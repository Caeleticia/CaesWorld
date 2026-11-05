/**
 * flow.js —— 积木流程（数据 + 解释执行）
 *
 * 存档格式（编辑器实时生成，也是运行时读取的格式）：
 *   {
 *     schema: 1, kind: "flow",
 *     nodes: [{ id, type, options: {...}, pos: { x, y } }],
 *     links: [{ id, from, port, to, portTo }]      // port = 输出端口，portTo = 输入端口
 *   }
 *
 * 连线规则：
 *  - 执行流（无类型的端口，画在积木上方）：输出只能接一个「下一步」；多个输出可以共用同一个下一步。
 *  - 数据流（带类型的端口，画在积木两侧）：一个输出可以接多个输入，反过来不行；类型必须一致。
 *  - 「触发」积木没有执行流的输入，是流程的起点。
 */
import { buildFlowCatalog, inputPortIds } from "./flow-catalog.js";

export const FLOW_SCHEMA = 1;
export const MAX_STEPS = 20000;
export const MAX_LOOP_ITERATIONS = 1000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v) => (v === undefined || v === null ? "" : String(v));
const toList = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return [v];
};
const unitKey = (u) => u.key;

/**
 * 目标集 → 单位数组。
 * 「目标」也是可接受的目标（单个目标 / 目标在循环里由 5-9 提供时），
 * 这样 7-1、8-1 也能直接接在需要目标集的输入上。
 */
const unitList = (v) => (v ? (Array.isArray(v) ? v.filter(Boolean) : [v]) : []);

/* ------------------------------------------------------------------ */
/* 校验 / 预处理                                                        */
/* ------------------------------------------------------------------ */

/**
 * 校验一个积木流程，返回可执行的预处理结果。不抛异常。
 * 节点上可以带常量选项（如 summon 的 unitId），没接数据线时作为默认值使用。
 *
 * @param {object} flow { nodes, links }
 * @param {{registry?: object}} [opts]
 * @returns {{ok: boolean, errors: string[], catalog, nodes: Map, links: object[], inputOwner: Map, constants: Map}}
 */
export function prepareFlow(flow, opts = {}) {
  const catalog = buildFlowCatalog();
  const errors = [];
  const nodes = new Map();
  const links = [];
  const constants = new Map();

  if (!flow || typeof flow !== "object") {
    return { ok: false, errors: ["流程必须是对象"], catalog, nodes, links, inputOwner: new Map(), constants };
  }
  const rawNodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const rawLinks = Array.isArray(flow.links) ? flow.links : [];

  for (const n of rawNodes) {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !n.id) {
      errors.push("节点缺少 id");
      continue;
    }
    const block = catalog.blocks[n.type];
    if (!block) {
      errors.push(`节点 ${n.id} 的类型未知：${n.type}`);
      continue;
    }
    if (nodes.has(n.id)) {
      errors.push(`节点 id 重复：${n.id}`);
      continue;
    }
    const options = {};
    for (const o of block.options) {
      options[o.key] = n.options && n.options[o.key] !== undefined ? n.options[o.key] : o.default;
    }
    const consts = {};
    for (const key of ["unitId", "skillId", "effectId", "attribute", "label", "count"]) {
      const v = n.options && n.options[key];
      if (v !== undefined && v !== null && v !== "") consts[key] = typeof v === "string" ? v : num(v);
    }
    // 兼容旧存档：常量也可能写在 node.ui.const 里（编辑器早期格式）
    const legacy = n.ui && n.ui.const;
    if (legacy) {
      for (const key of Object.keys(legacy)) {
        if (consts[key] === undefined && legacy[key] !== "" && legacy[key] !== undefined) consts[key] = legacy[key];
      }
    }
    constants.set(n.id, consts);
    nodes.set(n.id, {
      id: n.id,
      type: n.type,
      block,
      options,
      pos:
        n.pos && Number.isFinite(n.pos.x) && Number.isFinite(n.pos.y)
          ? { x: n.pos.x, y: n.pos.y }
          : { x: 0, y: 0 },
    });
  }

  const inputOwner = new Map();
  const outputOwner = new Map();
  const connectedIn = new Map();
  const registry = opts.registry || null;

  for (const l of rawLinks) {
    if (!l || typeof l.from !== "string" || typeof l.to !== "string") {
      errors.push("连接缺少 from/to");
      continue;
    }
    const from = nodes.get(l.from);
    const to = nodes.get(l.to);
    if (!from || !to) {
      errors.push(`连接指向不存在的节点：${l.from} → ${l.to}`);
      continue;
    }
    if (from.id === to.id) {
      errors.push(`积木 ${from.id} 不能连到自己`);
      continue;
    }
    const outPort = from.block.ports.find((p) => p.id === l.port && p.direction === "out");
    if (!outPort) {
      errors.push(`积木 ${from.id} 没有输出端口 ${l.port}`);
      continue;
    }
    let inPort = to.block.ports.find((p) => p.id === l.portTo && p.direction === "in");
    if (!inPort && to.block.kind === "math") {
      // 运算积木的「无限输入」端口
      const list = inputPortIds(to.block, to.options, connectedIn.get(to.id) || 0);
      if (list.includes(l.portTo)) inPort = { id: l.portTo, direction: "in", type: "number" };
    }
    if (!inPort) {
      // 「回复 / 攻击」等积木的执行流输入端只接受执行流
      errors.push(`积木 ${to.id} 没有输入端口 ${l.portTo}`);
      continue;
    }

    // 端口有没有「类型」是区分执行流 / 数据流的唯一依据：
    //   执行流：两端都不带类型；数据流：两端都带类型（「比较」的 A/B 是 any）。
    if (outPort.type === null || inPort.type === null) {
      if (outPort.type !== null || inPort.type !== null) {
        errors.push(`数据类型不匹配：${from.id}.${l.port}(${outPort.type}) → ${to.id}.${l.portTo}(${inPort.type})`);
        continue;
      }
      if (outputOwner.has(`${from.id}.${l.port}`)) {
        errors.push(`积木 ${from.id} 的「输出」已经连了下一步（输出只能接一个）`);
        continue;
      }
      outputOwner.set(`${from.id}.${l.port}`, to.id);
    } else {
      // 「目标」可以喂给需要「目标集」的输入（单个目标会被当作只含一个单位的目标集）
      const compatible =
        outPort.type === inPort.type ||
        outPort.type === "any" ||
        inPort.type === "any" ||
        (outPort.type === "target" && inPort.type === "targetset");
      if (!compatible) {
        errors.push(`数据类型不匹配：${from.id}.${l.port}(${outPort.type}) → ${to.id}.${l.portTo}(${inPort.type})`);
        continue;
      }
      // 「比较」积木的 A/B 画在两侧，各接一个；其它输入都只能接一个
      const single = inPort.id !== "a" && inPort.id !== "b";
      if (single && inputOwner.has(`${to.id}.${l.portTo}`)) {
        errors.push(`积木 ${to.id} 的输入 ${l.portTo} 只能接一个来源`);
        continue;
      }
      inputOwner.set(`${to.id}.${l.portTo}`, from.id);
      connectedIn.set(to.id, (connectedIn.get(to.id) || 0) + 1);
    }
    links.push({
      id: typeof l.id === "string" && l.id ? l.id : `${l.from}.${l.port}->${l.to}.${l.portTo}`,
      from: from.id,
      port: l.port,
      to: to.id,
      portTo: l.portTo,
      flow: outPort.type === null && inPort.type === null,
    });
  }

  // 引用检查（只查没接数据线的常量）
  if (registry) {
    const has = (kind) => (kind === "unit" ? registry.getUnit : kind === "skill" ? registry.getSkill : registry.getEffect);
    const check = (nodeId, kind, value) => {
      const list = has(kind);
      if (value && !(list && list.call(registry, value))) {
        errors.push(`积木 ${nodeId} 引用了不存在的${kind === "unit" ? "单位" : kind === "skill" ? "技能" : "效果"} ${value}`);
      }
    };
    for (const node of nodes.values()) {
      const c = constants.get(node.id) || {};
      if (node.type === "summon" || node.type === "summonChild") {
        if (!inputOwner.has(`${node.id}.unitId`)) check(node.id, "unit", c.unitId);
      } else if (node.type === "giveSkill") {
        if (!inputOwner.has(`${node.id}.skillId`)) check(node.id, "skill", c.skillId);
      } else if (node.type === "attachEffect" || node.type === "removeEffect") {
        if (!inputOwner.has(`${node.id}.effectId`)) check(node.id, "effect", c.effectId);
      }
    }
  }

  return { ok: errors.length === 0, errors, catalog, nodes, links, inputOwner, constants };
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

function permutations(n, k) {
  n = Math.floor(n);
  k = Math.floor(k);
  if (n < 0 || k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i += 1) r *= n - i;
  return r;
}

function combinations(n, k) {
  n = Math.floor(n);
  k = Math.floor(k);
  if (n < 0 || k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i += 1) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

function compareValues(a, b, operator) {
  if (typeof a === "number" || typeof b === "number") {
    const x = num(a);
    const y = num(b);
    switch (operator) {
      case "==": return x === y;
      case "!=": return x !== y;
      case ">": return x > y;
      case ">=": return x >= y;
      case "<": return x < y;
      case "<=": return x <= y;
      default: return false;
    }
  }
  const x = str(a);
  const y = str(b);
  switch (operator) {
    case "==": return x === y;
    case "!=": return x !== y;
    case ">": return x > y;
    case ">=": return x >= y;
    case "<": return x < y;
    case "<=": return x <= y;
    default: return false;
  }
}

/**
 * 运行一个积木流程。
 *
 * env（由 battle 提供）：
 *   owner / self      流程拥有者（技能/效果的持有单位）
 *   context           { unit: 遍历中的单位 }
 *   rng()             随机源
 *   sideOf(u) / listSide(side) / pickForPlayer(cands)
 *   unitData(u, field, { effectId })
 *   damage(target, value, attribute, { source }) / healUnit / setHp
 *   attachEffect(target, effectId) / removeEffectByMode(target, opts)
 *   summon({ unitId, count, label, ignoreLimit, parent, owner })
 *   skipTurn / grantImmune / forceExit / giveSkill
 *   interrupted       置 true 可中止当前循环
 *
 * @param {object} prepared prepareFlow 的结果
 * @param {object} env
 * @param {{triggerNode?: string}} [opts]
 * @returns {{ran: boolean, steps: number, visited: string[]}}
 */
export function runFlow(prepared, env, opts = {}) {
  const nodes = prepared.nodes;
  const graph = new Map();
  for (const l of prepared.links) {
    if (l.flow) graph.set(`${l.from}\u0000${l.port}`, l.to);
  }
  const visited = [];
  let steps = 0;
  let currentNodeId = null;

  function inputNode(nodeId, port) {
    return prepared.inputOwner.get(`${nodeId}.${port}`) || null;
  }

  /** 求一个端口上的值（缓存设在 local.memo 里，保证同一次执行只算一次） */
  function valueOf(node, port, local) {
    const fromId = inputNode(node.id, port);
    if (!fromId) {
      const c = prepared.constants.get(node.id);
      return c && port in c ? c[port] : undefined;
    }
    return evalNode(nodes.get(fromId), local);
  }

  /**
   * 「与/或/非/异或/同或」的操作数是条件：
   *  - 接了「比较」/其它条件积木：用它们的布尔结果
   *  - 什么都没接：视为 false
   */
  function condOf(node, port, local) {
    const fromId = inputNode(node.id, port);
    if (!fromId) return false;
    return Boolean(evalNode(nodes.get(fromId), local));
  }

  function unitScope(local) {
    if (local && local.unit) return local.unit;
    if (env.context && env.context.unit) return env.context.unit;
    return null;
  }

  function evalNode(node, local) {
    const scope = local.unit ? unitKey(local.unit) : "";
    const hit = local.memo.find((m) => m.id === node.id && m.scope === scope);
    if (hit) return hit.value;
    const out = evalNodeInner(node, local);
    local.memo.push({ id: node.id, scope, value: out });
    return out;
  }

  function dynamicInputs(node) {
    const connected = Object.keys(Object.fromEntries(prepared.inputOwner))
      .filter((k) => k.startsWith(`${node.id}.`))
      .map((k) => k.slice(node.id.length + 1));
    const list = inputPortIds(node.block, node.options, connected.length);
    if (!list.includes("in1")) return list;
    const used = connected.filter((p) => list.includes(p));
    const free = list.find((p) => !used.includes(p));
    return free ? [...used, free] : list;
  }

  function evalNodeInner(node, local) {
    const o = node.options;
    switch (node.type) {
      case "number": {
        if (o.mode === "pi") return Math.PI;
        if (o.mode === "e") return Math.E;
        if (o.mode === "range") {
          const lo = Math.ceil(num(o.min));
          const hi = Math.floor(num(o.max));
          if (hi < lo) return lo;
          return lo + Math.floor(env.rng() * (hi - lo + 1));
        }
        return num(o.value);
      }
      case "math": {
        const a = num(valueOf(node, "a", local));
        const b = num(valueOf(node, "b", local));
        switch (o.operator) {
          case "add": return a + b;
          case "sub": return a - b;
          case "mul": return a * b;
          case "div": return b === 0 ? 0 : a / b;
          case "mod": return b === 0 ? 0 : a % b;
          case "log": return a <= 0 || b <= 0 || a === 1 ? 0 : Math.log(b) / Math.log(a);
          case "perm": return permutations(a, b);
          case "comb": return combinations(a, b);
          case "max": {
            const vals = dynamicInputs(node).map((p) => num(valueOf(node, p, local)));
            return vals.length ? Math.max(...vals) : 0;
          }
          case "min": {
            const vals = dynamicInputs(node).map((p) => num(valueOf(node, p, local)));
            return vals.length ? Math.min(...vals) : 0;
          }
          case "round": return Math.round(num(valueOf(node, "a", local)));
          case "abs": return Math.abs(num(valueOf(node, "a", local)));
          case "ceil": return Math.ceil(num(valueOf(node, "a", local)));
          case "floor": return Math.floor(num(valueOf(node, "a", local)));
          default: return 0;
        }
      }
      case "getUnit": {
        const list = toList(valueOf(node, "targets", local));
        const i = Math.max(0, Math.floor(num(valueOf(node, "index", local))));
        return list[i] || null;
      }
      case "targetSide": {
        const side = o.side === "ally" ? env.sideOf(env.self) : env.otherSide(env.sideOf(env.self));
        return env.listSide(side);
      }
      case "chooseUnit": {
        const raw = valueOf(node, "targets", local);
        return env.pickForPlayer(raw ? toList(raw) : null, { multiple: o.multiple !== false });
      }
      case "setOp": {
        const a = toList(valueOf(node, "a", local));
        const b = toList(valueOf(node, "b", local));
        if (o.operator === "union") {
          const out = a.slice();
          for (const u of b) if (!out.some((x) => unitKey(x) === unitKey(u))) out.push(u);
          return out;
        }
        if (o.operator === "diff") return a.filter((u) => !b.some((x) => unitKey(x) === unitKey(u)));
        return a.filter((u) => b.some((x) => unitKey(x) === unitKey(u)));
      }
      case "unitData": {
        // 没接「目标」时指向流程的「自己」
        const raw = valueOf(node, "unit", local);
        const u = raw === undefined || raw === null ? env.self : raw;
        if (!u || !u.key) return o.field === "name" || o.field === "label" || o.field === "id" ? "" : 0;
        const res = env.unitData(u, o.field, { effectId: valueOf(node, "effectId", local) });
    return res;
      }
      case "filterSet": {
        const list = toList(valueOf(node, "targets", local));
        const out = [];
        for (const u of list) {
          const scope = { ...local, unit: u };
          if (condOf(node, "condition", scope)) out.push(u);
        }
        return out;
      }
      case "contextUnit":
        return unitScope(local);
      case "selfUnit":
        return env.self;
      case "contextSide": {
        const u = unitScope(local);
        return env.listSide(env.sideOf(u || env.self));
      }
      case "currentTarget":
        return env.currentTarget ? env.currentTarget() : [];
      case "triggerUnit":
        return env.triggerUnit || env.self;
      /* 条件类 */
      case "compare":
        return compareValues(valueOf(node, "a", local), valueOf(node, "b", local), o.operator || ">=");
      case "and": return condOf(node, "a", local) && condOf(node, "b", local);
      case "or": return condOf(node, "a", local) || condOf(node, "b", local);
      case "not": return !condOf(node, "a", local);
      case "xor": return condOf(node, "a", local) !== condOf(node, "b", local);
      case "xnor": return condOf(node, "a", local) === condOf(node, "b", local);
      default:
        return undefined;
    }
  }

  function step(node, local) {
    steps += 1;
    if (steps > MAX_STEPS) throw new Error("流程执行步数超限（可能有死循环）");
    visited.push(node.id);
    const prevCurrent = currentNodeId;
    currentNodeId = node.id;
    try {
      execute(node, local);
    } finally {
      currentNodeId = prevCurrent;
    }
  }

  function execute(node, local) {
    const o = node.options;
    const v = (port) => valueOf(node, port, local);
    const list = (port) => toList(v(port));
    const nextId = (port) => graph.get(`${node.id}\u0000${port}`) || null;
    const go = (targetId, nextLocal) => {
      if (!targetId) return;
      const n = nodes.get(targetId);
      if (n) step(n, nextLocal || local);
    };

    switch (node.type) {
      case "trigger": {
        const unit = v("unit");
        if (unit && unit.key && !condOf(node, "condition", local)) return;
        go(nextId("next"));
        return;
      }
      case "attack": {
        const targets = unitList(valueOf(node, "targets", local));
        const value = valueOf(node, "value", local) === undefined ? 0 : num(valueOf(node, "value", local));
        const attribute = str(v("attribute")) || o.attribute || "physical";
        for (const t of targets) env.damage(t, value, attribute, { source: env.self });
        go(nextId("next"));
        return;
      }
      case "heal": {
        const amount = valueOf(node, "value", local) === undefined ? 0 : num(valueOf(node, "value", local));
        for (const t of unitList(valueOf(node, "targets", local))) env.healUnit(t, amount);
        go(nextId("next"));
        return;
      }
      case "setHp": {
        const hp = valueOf(node, "value", local) === undefined ? 0 : num(valueOf(node, "value", local));
        for (const t of unitList(valueOf(node, "targets", local))) env.setHp(t, hp);
        go(nextId("next"));
        return;
      }
      case "attachEffect": {
        const eid = str(v("effectId"));
        if (eid) for (const t of unitList(valueOf(node, "targets", local))) env.attachEffect(t, eid);
        go(nextId("next"));
        return;
      }
      case "removeEffect": {
        const targets = unitList(valueOf(node, "targets", local));
        const opts = {
          mode: o.mode,
          effectId: str(v("effectId")),
          layers: v("value") === undefined ? 1 : Math.max(1, Math.floor(num(v("value")))),
          force: Boolean(o.force),
        };
        for (const t of targets) env.removeEffectByMode(t, opts);
        go(nextId("next"));
        return;
      }
      case "summon": {
        const unitId = str(v("unitId"));
        const count = v("count") === undefined ? 1 : Math.max(0, Math.floor(num(v("count"))));
        const label = str(v("label"));
        if (unitId && count > 0) {
          env.summon({ unitId, count, label, ignoreLimit: Boolean(o.ignoreLimit), parent: null, owner: env.self });
        }
        go(nextId("next"));
        return;
      }
      case "summonChild": {
        const parents = unitList(valueOf(node, "targets", local));
        const unitId = str(v("unitId"));
        const count = v("count") === undefined ? 1 : Math.max(0, Math.floor(num(v("count"))));
        const label = str(v("label"));
        if (unitId && count > 0) {
          for (const p of parents) env.summon({ unitId, count, label, ignoreLimit: false, parent: p, owner: env.self });
        }
        go(nextId("next"));
        return;
      }
      case "skipTurn": {
        for (const t of unitList(valueOf(node, "targets", local))) env.skipTurn(t);
        go(nextId("next"));
        return;
      }
      case "immuneDamage": {
        for (const t of unitList(valueOf(node, "targets", local))) env.grantImmune(t);
        go(nextId("next"));
        return;
      }
      case "forceExit": {
        for (const t of unitList(valueOf(node, "targets", local))) env.forceExit(t);
        go(nextId("next"));
        return;
      }
      case "giveSkill": {
        const skillId = str(v("skillId"));
        if (skillId) env.giveSkill(skillId);
        go(nextId("next"));
        return;
      }
      case "branch": {
        go(nextId(condOf(node, "condition", local) ? "true" : "false"));
        return;
      }
      case "whileLoop": {
        let iterations = 0;
        while (condOf(node, "condition", local) && !env.interrupted) {
          iterations += 1;
          if (iterations > MAX_LOOP_ITERATIONS) throw new Error("条件循环次数超限（条件可能永远成立）");
          go(nextId("body"));
        }
        go(nextId("end"));
        return;
      }
      case "forEach": {
        for (const u of unitList(valueOf(node, "targets", local))) {
          if (env.interrupted) break;
          go(nextId("body"), { ...local, unit: o.context === "stay" ? local.unit : u });
        }
        go(nextId("end"));
        return;
      }
      case "repeatLoop": {
        const times = Math.min(Math.max(0, Math.floor(num(v("count")))), MAX_LOOP_ITERATIONS);
        for (let i = 0; i < times; i += 1) {
          if (env.interrupted) break;
          go(nextId("body"), { ...local, index: i });
        }
        go(nextId("end"));
        return;
      }
      default:
        // 数据/条件类积木不会出现在执行流上
        return;
    }
  }

  let startId = opts.triggerNode || null;
  if (!startId) {
    for (const n of nodes.values()) {
      if (n.type === "trigger") {
        startId = n.id;
        break;
      }
    }
  }
  const start = startId ? nodes.get(startId) : null;
  if (!start) return { ran: false, steps: 0, visited: [] };

  step(start, { unit: null, memo: [] });
  return { ran: true, steps, visited };
}

/** 便捷方法：直接给 (flow, env) 运行 */
export function runStandalone(flow, env, opts) {
  const prepared = prepareFlow(flow);
  if (!prepared.ok) throw new Error(`流程无效：${prepared.errors.join("；")}`);
  return runFlow(prepared, env, opts);
}
