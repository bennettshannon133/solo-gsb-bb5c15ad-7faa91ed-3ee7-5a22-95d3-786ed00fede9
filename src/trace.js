'use strict';

/**
 * 残留推演引擎
 *
 * 输入为不可变的记录数据（设备 / 批次 / 清洗），输出：
 *   - timeline：按时间排序的事件流（清洗事件 / 批次-设备接触事件），
 *               每个事件带事件发生后的设备残留快照；
 *   - batches：每批的最终过敏原集合（配方自带 + 从设备继承），并附
 *               labelCheck —— 以本次最新推演的最终过敏原核对批次包装
 *               标签声明（漏报 / 多报 / 一致 / 尚未填写）；
 *   - equipment：推演结束时每台设备的残留；
 *   - nodes ：去重后的来源链节点（origin / inherit），供前端逐层展开。
 *
 * 关键规则：
 *   1. 同一时刻，清洗事件先于接触事件（视为接触前的准备动作）。
 *   2. 批次接触设备时，先“继承”设备当时的残留，再把自身携带的过敏原
 *      “留渍”到设备上；因此同一步内不会把自己刚留下的残留又继承回来。
 *   3. 清洗只移除所勾选的过敏原，未勾选的过敏原原样保留。
 *   4. 批次携带的过敏原 = 配方过敏原 ∪ 此前各步继承到的过敏原；
 *      这些过敏原会被带到后续设备。
 */

const STANDARD_ALLERGENS = [
  '小麦（含麸质）',
  '甲壳类',
  '鸡蛋',
  '鱼',
  '花生',
  '大豆',
  '乳（含乳糖）',
  '坚果',
  '芝麻',
];

/** 展示与输出统一使用的过敏原排序：先按内置目录顺序，再按名称。 */
function sortAllergens(list) {
  return [...new Set(list)].sort((a, b) => {
    const ia = STANDARD_ALLERGENS.indexOf(a);
    const ib = STANDARD_ALLERGENS.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'zh-Hans-CN');
  });
}

/**
 * @param {{equipment: Array, batches: Array, cleanings: Array}} data
 * @returns {object} 推演结果
 */
function trace(data) {
  const equipment = data.equipment || [];
  const batches = data.batches || [];
  const cleanings = data.cleanings || [];

  const nodes = {}; // nodeId -> node（去重后的来源节点表）

  const addNode = (node) => {
    if (!nodes[node.id]) nodes[node.id] = node;
    return node.id;
  };

  // 为每个批次的每种配方过敏原建立一个“源头”节点（同批同过敏原去重）。
  // carried：批次当前携带的过敏原 -> 该过敏原的全部来源节点 id 列表。
  const carried = new Map();
  // acquired：批次 id -> 过敏原 -> 首次获得该过敏原的信息。
  // 配方自带项在初始化时标记；交叉污染项在首次继承时记录设备、时间与步骤。
  const acquired = new Map();
  for (const b of batches) {
    const m = new Map();
    const acq = new Map();
    for (const allergen of sortAllergens(b.allergens || [])) {
      const id = `n_origin_${b.id}_${allergen}`;
      addNode({
        id,
        kind: 'origin',
        batchId: b.id,
        batchName: b.name,
        allergen,
      });
      addToMapList(m, allergen, id);
      acq.set(allergen, {
        kind: 'recipe',
        time: b.time,
      });
    }
    carried.set(b.id, m);
    acquired.set(b.id, acq);
  }

  // residue：设备 id -> 过敏原 -> 残留来源节点 id 列表
  const residue = new Map();
  for (const eq of equipment) residue.set(eq.id, new Map());

  const eqName = new Map(equipment.map((eq) => [eq.id, eq.name]));

  // ---- 组装事件流 -------------------------------------------------------

  const events = [];

  batches.forEach((b) => {
    (b.steps || []).forEach((step, idx) => {
      events.push({
        type: 'contact',
        time: step.time || b.time,
        batch: b,
        stepIndex: idx,
        equipmentId: step.equipmentId,
        stepNote: step.note || '',
        // 同刻事件的次级顺序：批次创建时间、批次 id、步骤序号
        seq: b.time + '|' + b.id + '|' + String(idx).padStart(6, '0'),
      });
    });
  });

  cleanings.forEach((c) => {
    events.push({
      type: 'cleaning',
      time: c.time,
      cleaningId: c.id,
      equipmentId: c.equipmentId,
      removed: c.allergens || [],
      note: c.note || '',
      seq: c.time + '|' + c.id,
    });
  });

  // 时间升序；同一时刻清洗（0）先于接触（1）；再按稳定的次级键排序。
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    const ta = a.type === 'cleaning' ? 0 : 1;
    const tb = b.type === 'cleaning' ? 0 : 1;
    if (ta !== tb) return ta - tb;
    return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
  });

  // ---- 逐步推演 ---------------------------------------------------------

  const timeline = [];

  const snapshot = (eqId) => {
    const map = residue.get(eqId);
    if (!map) return {};
    const out = {};
    for (const allergen of sortAllergens([...map.keys()])) {
      out[allergen] = [...(map.get(allergen) || [])];
    }
    return out;
  };

  const addInheritNode = (eqId, allergen, sourceIds, acquiredBy) => {
    const id =
      `n_inherit_${eqId}_${allergen}_${acquiredBy.batchId}_` +
      `s${acquiredBy.stepIndex}_${digestIds(sourceIds)}`;
    addNode({
      id,
      kind: 'inherit',
      equipmentId: eqId,
      equipmentName: eqName.get(eqId) || eqId,
      allergen,
      acquiredBy,
      sources: [...sourceIds],
    });
    return id;
  };

  for (const ev of events) {
    if (ev.type === 'cleaning') {
      const map = residue.get(ev.equipmentId);
      const removedSet = new Set(ev.removed);
      let actuallyRemoved = [];
      if (map) {
        for (const a of removedSet) {
          if (map.has(a)) {
            map.delete(a);
            actuallyRemoved.push(a);
          }
        }
      }
      timeline.push({
        type: 'cleaning',
        time: ev.time,
        seq: ev.seq,
        equipmentId: ev.equipmentId,
        equipmentName: eqName.get(ev.equipmentId) || ev.equipmentId,
        cleaningId: ev.cleaningId,
        requestedRemoval: sortAllergens(ev.removed),
        removed: sortAllergens(actuallyRemoved),
        note: ev.note,
        residueAfter: snapshot(ev.equipmentId),
      });
      continue;
    }

    // contact：批次接触设备
    const b = ev.batch;
    const eqId = ev.equipmentId;
    const map = residue.get(eqId);
    const batchMap = carried.get(b.id);

    const inherited = []; // { allergen, nodeIds } 本步继承到的来源
    const deposited = []; // string[] 本步新留在设备上的过敏原

    if (map && batchMap) {
      // 1) 先继承：设备上有、批次尚未携带的过敏原
      for (const [allergen, sourceIds] of map.entries()) {
        if (batchMap.has(allergen)) continue;
        const nodeId = addInheritNode(eqId, allergen, sourceIds, {
          batchId: b.id,
          batchName: b.name,
          stepIndex: ev.stepIndex,
        });        addToMapList(batchMap, allergen, nodeId);
        inherited.push({ allergen, nodeIds: [nodeId] });
        // 记录该过敏原在本批的首次继承：设备、时间、步骤、来源节点。
        const acqMap = acquired.get(b.id);
        if (acqMap && !acqMap.has(allergen)) {
          acqMap.set(allergen, {
            kind: 'cross',
            equipmentId: eqId,
            equipmentName: eqName.get(eqId) || eqId,
            time: ev.time,
            stepIndex: ev.stepIndex,
            nodeId,
          });
        }
      }

      // 2) 再留渍：把批次当前携带的全部过敏原带到设备上
      for (const [allergen, sourceIds] of batchMap.entries()) {
        if (!map.has(allergen)) deposited.push(allergen);
        for (const sid of sourceIds) addToMapList(map, allergen, sid);
      }
    }

    timeline.push({
      type: 'contact',
      time: ev.time,
      seq: ev.seq,
      batchId: b.id,
      batchName: b.name,
      stepIndex: ev.stepIndex,
      stepNote: ev.stepNote,
      equipmentId: eqId,
      equipmentName: eqName.get(eqId) || eqId,
      inherited: sortAllergens(inherited.map((x) => x.allergen)).map((a) =>
        inherited.find((x) => x.allergen === a)
      ),
      deposited: sortAllergens(deposited),
      residueAfter: snapshot(eqId),
    });
  }

  // ---- 批次最终过敏原 ---------------------------------------------------

  const batchResults = batches.map((b) => {
    const m = carried.get(b.id) || new Map();
    const acqMap = acquired.get(b.id) || new Map();
    const recipe = sortAllergens(b.allergens || []);
    const inheritedSet = new Set();
    const all = sortAllergens([...m.keys()]);
    const sources = {};
    for (const a of all) {
      sources[a] = [...(m.get(a) || [])];
      if (!recipe.includes(a)) inheritedSet.add(a);
    }
    return {
      batchId: b.id,
      name: b.name,
      time: b.time,
      recipeAllergens: recipe,
      inheritedAllergens: sortAllergens([...inheritedSet]),
      finalAllergens: all,
      sources,
      // 标签核对：声明随批次保存，核对依据每次最新推演即时计算；
      // 因此上游批次或清洗改动后无需重新保存标签即可更新结果。
      labelCheck: buildLabelCheck(b, all, acqMap, sources),
    };
  });
  // 结果按批次时间展示（与录入时间一致）
  batchResults.sort((a, b) =>
    a.time === b.time
      ? a.batchId < b.batchId
        ? -1
        : 1
      : a.time < b.time
        ? -1
        : 1
  );

  const equipmentResults = equipment.map((eq) => ({
    equipmentId: eq.id,
    name: eq.name,
    residue: snapshot(eq.id),
  }));

  return {
    standardAllergens: STANDARD_ALLERGENS,
    nodes,
    timeline,
    batches: batchResults,
    equipment: equipmentResults,
  };
}

function addToMapList(map, key, value) {
  const list = map.get(key);
  if (!list) {
    map.set(key, [value]);
  } else if (!list.includes(value)) {
    list.push(value);
  }
}

/**
 * 依据本次最新推演的最终过敏原核对批次保存的包装标签声明。
 *
 * @param {object} batch 原始批次记录（labelFilled / labelAllergens）
 * @param {string[]} finalAllergens 推演得到的最终过敏原（已排序）
 * @param {Map} acqMap 该批各过敏原首次获得信息（recipe / cross）
 * @param {object} sources 最终过敏原 -> 来源节点 id 列表（用于逐级展开）
 * @returns {object} labelCheck
 */
function buildLabelCheck(batch, finalAllergens, acqMap, sources) {
  // 尚未填写：与「已填写但声明为空集合」明确区分。
  if (!batch.labelFilled) {
    return {
      status: 'unfilled',
      declaredAllergens: [],
      missingAllergens: [],
      extraAllergens: [],
      details: [],
    };
  }

  const declared = sortAllergens(batch.labelAllergens || []);
  const finalSet = new Set(finalAllergens);
  const declaredSet = new Set(declared);

  // 漏报：最终含有但标签未声明。多报：标签声明了但最终不含。
  const missingAllergens = finalAllergens.filter((a) => !declaredSet.has(a));
  const extraAllergens = declared.filter((a) => !finalSet.has(a));

  const details = missingAllergens.map((a) => {
    const acq = acqMap.get(a);
    if (acq && acq.kind === 'cross') {
      return {
        allergen: a,
        origin: 'cross', // 来自交叉污染：展示首次继承的设备/时间，来源链可逐级展开
        equipmentId: acq.equipmentId,
        equipmentName: acq.equipmentName,
        time: acq.time,
        stepIndex: acq.stepIndex,
        nodeId: acq.nodeId,
        sourceNodeIds: sources[a] || (acq.nodeId ? [acq.nodeId] : []),
      };
    }
    // 配方自带项：标明来自本批配方（可能未被 acqMap 记录的兜底）。
    return {
      allergen: a,
      origin: 'recipe',
      sourceNodeIds: sources[a] || [],
    };
  });

  const status =
    missingAllergens.length === 0 && extraAllergens.length === 0
      ? 'consistent'
      : 'mismatch';

  return {
    status, // 'consistent' | 'mismatch'
    declaredAllergens: declared,
    missingAllergens,
    extraAllergens,
    details,
  };
}

/** 来源 id 列表的稳定短摘要，用于组成去重节点 id。 */
function digestIds(ids) {
  // 来源在同一上下文下数量很小且已去重，直接拼接后做一个简单散列即可。
  let h = 5381;
  const s = [...ids].sort().join('|');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return 'h' + (h >>> 0).toString(36);
}

module.exports = { trace, STANDARD_ALLERGENS, sortAllergens };
