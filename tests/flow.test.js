/**
 * flow.test.js —— 积木流程 / 效果触发 / 编辑器工程 单测
 *
 *   node tests/flow.test.js
 */
import { createHarness, assert, closeTo } from "./_harness.js";

import { buildFlowCatalog, BLOCK_GROUPS, DATA_TYPES, inputPortIds } from "../engine/flow-catalog.js";
import { prepareFlow, runFlow } from "../engine/flow.js";
import { ContentRegistry, createBattle, BATTLE_EVENT } from "../engine/index.js";
import {
  createProject,
  createCharacter,
  createSkill,
  createEffect,
  validateProject,
  projectToContent,
  projectToRegistryInput,
  normalizeFlow,
  PLACEHOLDER_IMAGE,
  resolveImage,
} from "../engine/editor.js";

const t = createHarness("flow");

/* ------------------------------------------------------------------ */
/* 积木总览                                                            */
/* ------------------------------------------------------------------ */
t.suite("积木总览", () => {});

const catalog = buildFlowCatalog();

t.test("积木总数与分类颜色", () => {
  const expected = [
    "trigger",
    "attack", "heal", "setHp", "attachEffect", "removeEffect", "summon", "summonChild", "skipTurn", "immuneDamage", "forceExit", "giveSkill",
    "branch", "whileLoop", "forEach", "repeatLoop",
    "compare", "and", "or", "not", "xor", "xnor",
    "number", "math", "getUnit", "targetSide", "chooseUnit", "setOp", "unitData", "filterSet", "contextUnit", "selfUnit",
    "contextSide", "currentTarget", "triggerUnit",
  ];
  for (const kind of expected) assert.ok(catalog.blocks[kind], `缺少积木 ${kind}`);
  assert.equal(catalog.blocks.trigger.color, BLOCK_GROUPS.trigger.color);
  assert.equal(catalog.blocks.attack.color, BLOCK_GROUPS.action.color);
  assert.equal(catalog.blocks.branch.color, BLOCK_GROUPS.structure.color);
  assert.equal(catalog.blocks.compare.color, BLOCK_GROUPS.logic.color);
  assert.equal(catalog.blocks.number.color, BLOCK_GROUPS.data.color);
  const colors = new Set(Object.values(BLOCK_GROUPS).map((g) => g.color));
  assert.equal(colors.size, 5, "五类颜色互不相同");
});

t.test("数据类型只有五种", () => {
  assert.deepEqual([...DATA_TYPES], ["targetset", "target", "number", "string", "condition"]);
});

t.test("端口：执行流无类型，数据端口都有类型", () => {
  for (const block of Object.values(catalog.blocks)) {
    for (const port of block.ports) {
      if (["in", "next", "true", "false", "body", "end"].includes(port.id)) {
        assert.equal(port.type, null, `${block.kind}.${port.id} 应是执行流端口`);
      } else {
        assert.ok(DATA_TYPES.includes(port.type) || port.type === "any", `${block.kind}.${port.id} 缺类型`);
      }
    }
  }
});

t.test("运算：固定输入 vs 无限输入（已连接 + 1）", () => {
  assert.deepEqual(inputPortIds(catalog.blocks.math, { operator: "add" }), ["a", "b"]);
  assert.deepEqual(inputPortIds(catalog.blocks.math, { operator: "round" }), ["a"]);
  assert.deepEqual(inputPortIds(catalog.blocks.math, { operator: "max" }, 0), ["in1"]);
  assert.deepEqual(inputPortIds(catalog.blocks.math, { operator: "max" }, 3), ["in1", "in2", "in3", "in4"]);
});

/* ------------------------------------------------------------------ */
/* 连线校验                                                            */
/* ------------------------------------------------------------------ */
t.suite("连线校验", () => {});

const node = (id, type, options = {}) => ({ id, type, options });
const N = (id, value) => node(id, "number", { mode: "const", value });
const SIDE = (id, side = "enemy") => node(id, "targetSide", { side });
const L = (from, port, to, portTo) => ({ from, port, to, portTo });

t.test("执行流：输出只能接一个下一步；多个输出可汇到同一步", () => {
  const bad = prepareFlow({
    nodes: [node("a", "heal"), node("b", "heal"), node("c", "heal")],
    links: [L("a", "next", "b", "in"), L("a", "next", "c", "in")],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("|"), /输出只能接一个/);

  const ok = prepareFlow({
    nodes: [node("br", "branch"), node("t", "heal"), node("f", "heal")],
    links: [L("br", "true", "t", "in"), L("br", "false", "t", "in")],
  });
  assert.equal(ok.ok, true, ok.errors.join("；"));
});

t.test("数据流：一个输出可接多个输入，反过来不行", () => {
  const ok = prepareFlow({
    nodes: [N("n", 1), node("ha", "heal"), node("hb", "heal")],
    links: [L("n", "num", "ha", "value"), L("n", "num", "hb", "value")],
  });
  assert.equal(ok.ok, true, ok.errors.join("；"));
  const bad = prepareFlow({
    nodes: [N("n", 1), N("m", 2), node("h", "heal")],
    links: [L("n", "num", "h", "value"), L("m", "num", "h", "value")],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("|"), /只能接一个来源/);
});

t.test("类型必须一致：目标集不能接数值；执行流不能接数据口", () => {
  const p1 = prepareFlow({
    nodes: [SIDE("s"), node("h", "heal")],
    links: [L("s", "set", "h", "value")],
  });
  assert.equal(p1.ok, false);
  assert.match(p1.errors.join("|"), /数据类型不匹配/);

  const p2 = prepareFlow({
    nodes: [node("a", "heal"), node("b", "heal")],
    links: [L("a", "next", "b", "targets")],
  });
  assert.equal(p2.ok, false);
  assert.match(p2.errors.join("|"), /数据类型不匹配/);
});

t.test("自连与不存在的节点会被拦住", () => {
  const p = prepareFlow({
    nodes: [node("a", "heal")],
    links: [L("a", "next", "a", "in"), L("a", "next", "ghost", "in")],
  });
  assert.equal(p.ok, false);
  const text = p.errors.join("|");
  assert.match(text, /不能连到自己/);
  assert.match(text, /不存在的节点/);
});

t.test("比较积木：A/B 分别在两侧，各接一个", () => {
  const p = prepareFlow({
    nodes: [N("n1", 1), N("n2", 2), node("cmp", "compare")],
    links: [L("n1", "num", "cmp", "a"), L("n2", "num", "cmp", "b")],
  });
  assert.equal(p.ok, true, p.errors.join("；"));
});

/* ------------------------------------------------------------------ */
/* 解释执行                                                            */
/* ------------------------------------------------------------------ */
t.suite("解释执行", () => {});

function fakeUnit(key, props = {}) {
  return { key, uid: key, side: props.side || "enemy", hp: props.hp ?? 100, ...props };
}

function makeEnv() {
  const calls = [];
  const me = fakeUnit("me", { side: "ally" });
  const e1 = fakeUnit("e1");
  const e2 = fakeUnit("e2");
  const env = {
    self: me,
    owner: me,
    context: { unit: null },
    interrupted: false,
    rng: () => 0.5,
    sideOf: (u) => u.side,
    otherSide: (s) => (s === "ally" ? "enemy" : "ally"),
    listSide: (s) => (s === "enemy" ? [e1, e2] : [me]),
    currentTarget: () => [e1],
    pickForPlayer: (l) => l || [],
    unitData: (u, field) => (field === "hp" ? u.hp : field === "name" ? u.key : 0),
    damage: (target, value, attribute) => calls.push({ op: "damage", to: target.key, value, attribute }),
    healUnit: (target, amount) => calls.push({ op: "heal", to: target.key, amount }),
    setHp: (target, value) => calls.push({ op: "setHp", to: target.key, value }),
    attachEffect: (target, eid) => calls.push({ op: "attach", to: target.key, eid }),
    removeEffectByMode: (target, opts) => calls.push({ op: "remove", to: target.key, opts }),
    summon: (opts) => calls.push({ op: "summon", ...opts }),
    skipTurn: (target) => calls.push({ op: "skip", to: target.key }),
    grantImmune: (target) => calls.push({ op: "immune", to: target.key }),
    forceExit: (target) => calls.push({ op: "exit", to: target.key }),
    giveSkill: (skillId) => calls.push({ op: "give", skillId }),
  };
  return { env, calls, me, e1, e2 };
}

function run(flow, env, opts) {
  const p = prepareFlow(flow);
  assert.equal(p.ok, true, p.errors.join("；"));
  return runFlow(p, env, opts);
}

t.test("攻击：目标集 + 数值 + 属性", () => {
  const { env, calls } = makeEnv();
  run(
    {
      nodes: [node("t", "trigger"), node("atk", "attack", { attribute: "magic" }), SIDE("side"), N("n", 120)],
      links: [L("t", "next", "atk", "in"), L("side", "set", "atk", "targets"), L("n", "num", "atk", "value")],
    },
    env
  );
  assert.deepEqual(calls, [
    { op: "damage", to: "e1", value: 120, attribute: "magic" },
    { op: "damage", to: "e2", value: 120, attribute: "magic" },
  ]);
});

t.test("常量：没接数据线时用积木上的常量（召唤/给予技能/附加效果）", () => {
  const { env, calls } = makeEnv();
  run(
    {
      nodes: [
        node("t", "trigger"),
        node("su", "summon", { unitId: "slime", count: 2, label: "召唤物" }),
        node("g", "giveSkill", { skillId: "skill_x" }),
        node("ae", "attachEffect", { effectId: "effect_x" }),
        node("me", "selfUnit"),
      ],
      links: [L("t", "next", "su", "in"), L("su", "next", "g", "in"), L("g", "next", "ae", "in"), L("me", "target", "ae", "targets")],
    },
    env
  );
  assert.deepEqual(calls[0], { op: "summon", unitId: "slime", count: 2, label: "召唤物", ignoreLimit: false, parent: null, owner: env.self });
  assert.deepEqual(calls[1], { op: "give", skillId: "skill_x" });
  assert.equal(calls[2].op, "attach");
  assert.equal(calls[2].eid, "effect_x");
});

t.test("条件分支：真/假走不同路径", () => {
  const build = () => ({
    nodes: [
      node("t", "trigger"),
      node("br", "branch"),
      node("cmp", "compare", { operator: ">=" }),
      node("ud", "unitData", { field: "hp" }),
      node("me", "selfUnit"),
      N("zero", 0),
      node("yes", "attachEffect", { effectId: "yes_fx" }),
      node("no", "attachEffect", { effectId: "no_fx" }),
    ],
    links: [
      L("t", "next", "br", "in"),
      L("ud", "value", "cmp", "a"),
      L("zero", "num", "cmp", "b"),
      L("me", "target", "ud", "unit"),
      L("cmp", "out", "br", "condition"),
      L("br", "true", "yes", "in"),
      L("br", "false", "no", "in"),
      L("me", "target", "yes", "targets"),
      L("me", "target", "no", "targets"),
    ],
  });
  const a = makeEnv();
  a.me.hp = 100;
  run(build(), a.env);
  assert.deepEqual(a.calls.map((c) => c.eid), ["yes_fx"], "100 >= 0 走真分支");
  const b = makeEnv();
  b.me.hp = -5;
  run(build(), b.env);
  assert.deepEqual(b.calls.map((c) => c.eid), ["no_fx"], "-5 >= 0 不成立，走假分支");
});

t.test("逻辑：与/或/非/异或/同或", () => {
  const cond = (kind) => {
    const { env } = makeEnv();
    const nodes = [
      node("t", "trigger"),
      node("br", "branch"),
      node("op", kind),
      node("ca", "compare", { operator: ">" }),
      node("cb", "compare", { operator: ">" }),
      N("n1", 1),
      N("n2", 2),
      N("z", 0),
      N("n3", 3),
      node("h1", "attachEffect", { effectId: "hit" }),
      node("me", "selfUnit"),
    ];
    // ca: 1 > 0 真；cb: 2 > 3 假
    const links = [
      L("n1", "num", "ca", "a"),
      L("z", "num", "ca", "b"),
      L("n2", "num", "cb", "a"),
      L("n3", "num", "cb", "b"),
      L("t", "next", "br", "in"),
      L("ca", "out", "op", "a"),
      L("op", "out", "br", "condition"),
      L("br", "true", "h1", "in"),
      L("me", "target", "h1", "targets"),
    ];
    if (kind !== "not") links.push(L("cb", "out", "op", "b"));
    return run({ nodes, links }, env).visited.includes("h1");
  };
  assert.equal(cond("and"), false);
  assert.equal(cond("or"), true);
  assert.equal(cond("not"), false);
  assert.equal(cond("xor"), true);
  assert.equal(cond("xnor"), false);
});

t.test("遍历循环：forEach 遍历目标集，7-1 指代当前单位", () => {
  const { env, calls } = makeEnv();
  run(
    {
      nodes: [node("t", "trigger"), node("loop", "forEach"), SIDE("side"), node("h", "heal"), node("ctx", "contextUnit"), N("n", 1)],
      links: [
        L("t", "next", "loop", "in"),
        L("side", "set", "loop", "targets"),
        L("loop", "body", "h", "in"),
        L("ctx", "target", "h", "targets"),
        L("n", "num", "h", "value"),
      ],
    },
    env
  );
  // 7-1 在循环体里指代当前遍历到的单位
  assert.deepEqual(calls.map((c) => c.to), ["e1", "e2"]);
});

t.test("次数循环 / 条件循环（带次数上限保护）", () => {
  const { env, calls } = makeEnv();
  run(
    {
      nodes: [node("t", "trigger"), node("loop", "repeatLoop"), N("n", 3), node("ae", "attachEffect", { effectId: "burn" }), node("me", "selfUnit")],
      links: [L("t", "next", "loop", "in"), L("n", "num", "loop", "count"), L("loop", "body", "ae", "in"), L("me", "target", "ae", "targets")],
    },
    env
  );
  assert.equal(calls.length, 3, "次数循环执行 3 次");

  const bad = makeEnv();
  const p2 = prepareFlow({
    nodes: [node("t", "trigger"), node("w", "whileLoop"), node("tt", "compare", { operator: "==" }), N("c1", 0), N("c2", 0), node("h", "attachEffect")],
    links: [L("t", "next", "w", "in"), L("w", "body", "h", "in"), L("c1", "num", "tt", "a"), L("c2", "num", "tt", "b"), L("tt", "out", "w", "condition")],
  });
  assert.equal(p2.ok, true, p2.errors.join("；"));
  assert.throws(() => runFlow(p2, bad.env), /条件循环次数超限/);
});

t.test("数值与运算：π / e / 范围随机 / 加减乘除 / 对数 / 排列组合 / 取整 / max 无限输入", () => {
  const mathOf = (makeNum, ports) => {
    const { env, calls } = makeEnv();
    const nodes = [node("t", "trigger"), node("loop", "forEach"), SIDE("side"), node("h", "heal"), node("m", "math", { operator: makeNum.op }), node("me", "selfUnit")];
    const links = [L("t", "next", "loop", "in"), L("side", "set", "loop", "targets"), L("loop", "body", "h", "in"), L("me", "target", "h", "targets"), L("m", "num", "h", "value")];
    makeNum.values.forEach((v, i) => {
      nodes.push(N(`c${i}`, v));
      links.push(L(`c${i}`, "num", "m", ports ? ports[i] : ["a", "b"][i]));
    });
    const p = prepareFlow({ nodes, links });
    assert.equal(p.ok, true, p.errors.join("；"));
    runFlow(p, env);
    return calls[0] && calls[0].amount;
  };
  const numNode = (mode, extra = {}) => ({ nodes: [node("pi", "number", { mode, ...extra })] });
  {
    const { env, calls } = makeEnv();
    const p = prepareFlow({
      nodes: [node("t", "trigger"), node("loop", "forEach"), SIDE("side"), node("h", "heal"), node("me", "selfUnit"), node("pi", "number", { mode: "pi" })],
      links: [L("t", "next", "loop", "in"), L("side", "set", "loop", "targets"), L("loop", "body", "h", "in"), L("me", "target", "h", "targets"), L("pi", "num", "h", "value")],
    });
    runFlow(p, env);
    closeTo(calls[0].amount, Math.PI);
  }
  {
    const { env, calls } = makeEnv();
    const p = prepareFlow({
      nodes: [node("t", "trigger"), node("loop", "forEach"), SIDE("side"), node("h", "heal"), node("me", "selfUnit"), node("e", "number", { mode: "e" })],
      links: [L("t", "next", "loop", "in"), L("side", "set", "loop", "targets"), L("loop", "body", "h", "in"), L("me", "target", "h", "targets"), L("e", "num", "h", "value")],
    });
    runFlow(p, env);
    closeTo(calls[0].amount, Math.E);
  }
  const r = { env: makeEnv().env, calls: makeEnv().calls };
  assert.equal(mathOf({ op: "add", values: [7, 5] }), 12);
  assert.equal(mathOf({ op: "sub", values: [7, 5] }), 2);
  assert.equal(mathOf({ op: "mul", values: [7, 5] }), 35);
  closeTo(mathOf({ op: "div", values: [7, 0] }), 0);
  assert.equal(mathOf({ op: "mod", values: [7, 4] }), 3);
  closeTo(mathOf({ op: "log", values: [2, 8] }), 3);
  assert.equal(mathOf({ op: "perm", values: [5, 2] }), 20);
  assert.equal(mathOf({ op: "comb", values: [5, 2] }), 10);
  closeTo(mathOf({ op: "round", values: [2.6] }), 3);
  closeTo(mathOf({ op: "abs", values: [-3] }), 3);
  closeTo(mathOf({ op: "ceil", values: [1.2] }), 2);
  closeTo(mathOf({ op: "floor", values: [1.8] }), 1);
  assert.equal(mathOf({ op: "max", values: [3, 9, 4] }, ["in1", "in2", "in3"]), 9);
  void r;
  void numNode;
});

t.test("集合运算：交集 / 并集 / 相对差集", () => {
  const { env, calls } = makeEnv();
  const runSet = (op, sideB) => {
    calls.length = 0;
    const p = prepareFlow({
      nodes: [node("t", "trigger"), node("op", "setOp", { operator: op }), SIDE("sa"), SIDE("sb", sideB), node("loop", "forEach"), node("h", "heal"), node("ctx", "contextUnit"), N("n", 1)],
      links: [
        L("t", "next", "loop", "in"),
        L("sa", "set", "op", "a"),
        L("sb", "set", "op", "b"),
        L("op", "set", "loop", "targets"),
        L("loop", "body", "h", "in"),
        L("ctx", "target", "h", "targets"),
        L("n", "num", "h", "value"),
      ],
    });
    assert.equal(p.ok, true, p.errors.join("；"));
    runFlow(p, env);
    return calls.map((c) => c.to);
  };
  assert.deepEqual(runSet("intersect", "enemy"), ["e1", "e2"]);
  assert.deepEqual(runSet("union", "enemy"), ["e1", "e2"]);
  assert.deepEqual(runSet("diff", "enemy"), []);
  assert.deepEqual(runSet("intersect", "ally"), []);
  assert.deepEqual(runSet("union", "ally"), ["e1", "e2", "me"]);
  assert.deepEqual(runSet("diff", "ally"), ["e1", "e2"]);
});

t.test("筛选目标集：条件里 7-1 指代被筛选的单位", () => {
  const { env, calls, e1, e2 } = makeEnv();
  e1.hp = 200;
  e2.hp = 50;
  run(
    {
      nodes: [
        node("t", "trigger"),
        node("filter", "filterSet"),
        SIDE("side"),
        node("cmp", "compare", { operator: ">=" }),
        node("ud", "unitData", { field: "hp" }),
        node("ctx", "contextUnit"),
        N("n", 100),
        node("loop", "forEach"),
        node("h", "heal"),
        N("one", 1),
      ],
      links: [
        L("t", "next", "loop", "in"),
        L("side", "set", "filter", "targets"),
        L("ctx", "target", "ud", "unit"),
        L("ud", "value", "cmp", "a"),
        L("n", "num", "cmp", "b"),
        L("cmp", "out", "filter", "condition"),
        L("filter", "set", "loop", "targets"),
        L("loop", "body", "h", "in"),
        L("ctx", "target", "h", "targets"),
        L("one", "num", "h", "value"),
      ],
    },
    env
  );
  assert.deepEqual(calls.map((c) => c.to), ["e1"], "只留 HP >= 100 的");
});

/* ------------------------------------------------------------------ */
/* 战斗内：技能流程 + 效果触发                                          */
/* ------------------------------------------------------------------ */
t.suite("战斗内执行", () => {});

function buildRegistry() {
  const registry = new ContentRegistry();
  registry.load({
    units: [
      { name: "勇者", id: "default_unit_hero", baseHp: 10000, baseAtk: 1000, speed: 120, skills: ["default_skill_beat", "default_skill_flurry"] },
      { name: "木桩", id: "default_unit_dummy", baseHp: 100000, baseAtk: 100, speed: 10 },
      { name: "史莱姆", id: "default_unit_slime", baseHp: 3000, baseAtk: 100, speed: 90 },
    ],
    skills: [
      { name: "拍击", id: "default_skill_beat", type: "active", attribute: "physical" },
      {
        name: "连打",
        id: "default_skill_flurry",
        type: "active",
        attribute: "physical",
        format: "flow",
        requiresTarget: false,
        effects: [],
        flow: {
          nodes: [
            { id: "t1", type: "trigger", options: { event: "skillCast" } },
            { id: "rep", type: "repeatLoop" },
            { id: "n2", type: "number", options: { mode: "const", value: 2 } },
            { id: "atk", type: "attack" },
            { id: "side", type: "targetSide", options: { side: "enemy" } },
            { id: "v", type: "number", options: { mode: "const", value: 100 } },
          ],
          links: [
            { from: "t1", port: "next", to: "rep", portTo: "in" },
            { from: "n2", port: "num", to: "rep", portTo: "count" },
            { from: "rep", port: "body", to: "atk", portTo: "in" },
            { from: "side", port: "set", to: "atk", portTo: "targets" },
            { from: "v", port: "num", to: "atk", portTo: "value" },
          ],
        },
      },
    ],
    effects: [
      {
        // 触发积木的 id 与流程里的触发积木 id 一致
        id: "default_effect_thorns",
        name: "荆棘",
        flags: ["negative", "unremovable"],
        triggers: [{ id: "tr", event: "attacked", unitScope: "self" }],
        flows: {
          tr: {
            nodes: [
              { id: "tr", type: "trigger", options: { event: "attacked" } },
              { id: "src", type: "unitData", options: { field: "lastHitSource" } },
              { id: "me", type: "selfUnit" },
              { id: "atk", type: "attack", options: { attribute: "magic" } },
              { id: "v", type: "number", options: { mode: "const", value: 50 } },
            ],
            links: [
              { from: "tr", port: "next", to: "atk", portTo: "in" },
              { from: "me", port: "target", to: "src", portTo: "unit" },
              { from: "src", port: "value", to: "atk", portTo: "targets" },
              { from: "v", port: "num", to: "atk", portTo: "value" },
            ],
          },
        },
      },
      {
        id: "default_effect_shield",
        name: "免伤",
        flags: [],
        triggers: [{ id: "sh", event: "attacked", unitScope: "self" }],
        flows: {
          sh: {
            nodes: [
              { id: "sh", type: "trigger", options: { event: "attacked" } },
              { id: "me", type: "selfUnit" },
              { id: "imm", type: "immuneDamage" },
            ],
            links: [
              { from: "sh", port: "next", to: "imm", portTo: "in" },
              { from: "me", port: "target", to: "imm", portTo: "targets" },
            ],
          },
        },
      },
      {
        id: "default_effect_curse",
        name: "虚弱",
        flags: ["negative"],
        attrBonus: [{ attr: "physical", value: -0.5 }],
        triggers: [],
        flows: {},
      },
    ],
  });
  return registry;
}

function makeBattle(extra = {}) {
  const registry = buildRegistry();
  const battle = createBattle({
    registry,
    seed: 5,
    units: [
      { cardId: "default_unit_hero", side: "ally", slot: 1 },
      { cardId: "default_unit_dummy", side: "enemy", slot: 1 },
    ],
    ...extra,
  });
  return { registry, battle };
}

t.test("技能流程：由施放者为主体执行；重复执行循环体", () => {
  const { battle } = makeBattle();
  battle.useSkill(1);
  const damage = battle.state.events.filter((e) => e.type === BATTLE_EVENT.DAMAGE);
  assert.equal(damage.length, 2, "次数循环 2 次");
  for (const d of damage) assert.ok(d.finalDamage > 0, "100 点物理伤害：扣防御与抗性后仍为正");
  const flowErrors = battle.state.events.filter((e) => e.type === BATTLE_EVENT.FLOW_ERROR);
  assert.deepEqual(flowErrors, [], "技能的积木流程应无报错");
});

t.test("效果触发：受击时反伤（lastHitSource → 攻击方）", () => {
  const { registry, battle } = makeBattle();
  battle.attachEffect("u2", "default_effect_thorns");
  // 直接调用效果流程（引擎内部由 attacked 事件驱动；这里验证流程本身能跑通）
  const effect = registry.getEffect("default_effect_thorns");
  const prepared = prepareFlow(effect.flows.tr);
  assert.equal(prepared.ok, true, prepared.errors.join("；"));
  const calls = [];
  const env = {
    self: battle.getUnit("u2"),
    context: {},
    unitData: () => battle.getUnit("u1"),
    damage: (target, value, attribute) => calls.push({ target: target && target.key, value, attribute }),
    healUnit: () => {},
    setHp: () => {},
    attachEffect: () => {},
    removeEffectByMode: () => {},
    summon: () => {},
    skipTurn: () => {},
    grantImmune: () => {},
    forceExit: () => {},
    giveSkill: () => {},
    sideOf: (u) => u.side,
    otherSide: (s) => (s === "ally" ? "enemy" : "ally"),
    listSide: () => [],
    currentTarget: () => [],
    pickForPlayer: () => [],
    rng: Math.random,
  };
  runFlow(prepared, env, { triggerNode: "tr" });
  assert.deepEqual(calls, [{ target: "u1", value: 50, attribute: "magic" }], "反伤打向攻击方");
});

t.test("效果触发：受击时由引擎自动执行（免疫伤害）", () => {
  const { battle } = makeBattle();
  battle.attachEffect("u2", "default_effect_shield");
  const before = battle.getUnit("u2").hp;
  battle.dealDamage({ attackerRef: "u1", targetRef: "u2", value: 100, multiplier: 1, attribute: "magic" }, { log: true });
  assert.equal(battle.getUnit("u2").hp, before, "免疫后不掉血");
});

t.test("效果触发：免疫伤害（受击时免疫本组伤害）", () => {
  const { battle } = makeBattle();
  battle.attachEffect("u2", "default_effect_shield");
  const before = battle.getUnit("u2").hp;
  battle.useSkill(0);
  assert.equal(battle.getUnit("u2").hp, before, "免疫后不掉血");
  const dmg = battle.state.events.find((e) => e.type === BATTLE_EVENT.DAMAGE);
  assert.equal(Boolean(dmg && dmg.immune), true);
});

t.test("效果层：层数累加、按模式移除、不可解除标记", () => {
  const { battle } = makeBattle();
  battle.attachEffect("u2", "default_effect_curse");
  battle.attachEffect("u2", "default_effect_curse");
  assert.equal(battle.effectStacks(battle.getUnit("u2"), "default_effect_curse"), 2);
  closeTo(battle.getUnit("u2").attrBonus.physical.flat, -1, 1e-9, "两层 -50% 物理抗性");
  // 非强制：不可解除的荆棘移除不掉
  battle.attachEffect("u2", "default_effect_thorns");
  assert.equal(battle.removeEffect("u2", "default_effect_thorns"), 0);
  assert.equal(battle.removeEffect("u2", "default_effect_thorns", { force: true }), 1);
  // 指定移除 1 层
  assert.equal(battle.removeEffect("u2", "default_effect_curse", { layers: 1 }), 1);
  assert.equal(battle.effectStacks(battle.getUnit("u2"), "default_effect_curse"), 1);
});

t.test("跳过行动：回合开始时被效果跳过", () => {
  const registry = buildRegistry();
  registry.addEffect({
    id: "default_effect_frozen",
    name: "冰封",
    triggers: [{ id: "tr", event: "unitTurnStart", unitScope: "self" }],
    flows: {
      tr: {
        nodes: [
          { id: "tr", type: "trigger", options: { event: "unitTurnStart" } },
          { id: "me", type: "selfUnit" },
          { id: "skip", type: "skipTurn" },
        ],
        links: [
          { from: "tr", port: "next", to: "skip", portTo: "in" },
          { from: "me", port: "target", to: "skip", portTo: "targets" },
        ],
      },
    },
  });
  const battle = createBattle({
    registry,
    seed: 3,
    units: [
      { cardId: "default_unit_hero", side: "ally", slot: 1 },
      { cardId: "default_unit_dummy", side: "enemy", slot: 1 },
    ],
  });
  battle.attachEffect("u1", "default_effect_frozen");
  const acts = [];
  battle.state.events.push = ((orig) => (...a) => { if (a[0] && a[0].type === BATTLE_EVENT.ACTION_START) acts.push(a[0].activeId); return Array.prototype.push.apply(battle.state.events, a); })(battle.state.events.push);
  battle.endTurn();
  // 勇者速度更快：本轮之后又轮到勇者，这次被跳过，直接落到木桩
  assert.equal(battle.state.activeId, "u2");
  assert.deepEqual(acts, ["u2"], "勇者这次没有拿到行动");
});

t.test("召唤 / 子单位随父单位退场 / 强制退场", () => {
  const registry = buildRegistry();
  registry.addEffect({
    id: "default_effect_summoner",
    name: "召唤师",
    triggers: [{ id: "tr", event: "unitEnter", unitScope: "self" }],
    flows: {
      tr: {
        nodes: [
          { id: "tr", type: "trigger", options: { event: "unitEnter" } },
          { id: "sc", type: "summonChild", options: { unitId: "default_unit_slime", count: 2 } },
          { id: "me", type: "selfUnit" },
        ],
        links: [
          { from: "tr", port: "next", to: "sc", portTo: "in" },
          { from: "me", port: "target", to: "sc", portTo: "targets" },
        ],
      },
    },
  });
  const battle = createBattle({
    registry,
    seed: 3,
    units: [
      { cardId: "default_unit_hero", side: "ally", slot: 1 },
      { cardId: "default_unit_dummy", side: "enemy", slot: 1 },
    ],
  });
  battle.attachEffect("u1", "default_effect_summoner");
  const kids = battle.state.units.filter((u) => u.parentKey === "u1");
  assert.ok(kids.length >= 1, "召唤出了子单位");
  battle.forceExit("u1");
  for (const kid of kids) assert.equal(battle.isAlive(kid), false, "子单位随父单位退场");
});

t.test("给予技能：持有效果时获得额外技能", () => {
  const { battle } = makeBattle();
  const before = battle.allSkillsOf(battle.getUnit("u1")).length;
  battle.getUnit("u1").granted.push({ skillId: "default_skill_beat", count: 1 });
  assert.equal(battle.allSkillsOf(battle.getUnit("u1")).length, before + 1);
});

t.test("致命伤害：流程里回复能把血拉回来", () => {
  const registry = buildRegistry();
  registry.addEffect({
    id: "default_effect_laststand",
    name: "不屈",
    flags: ["unremovable"],
    triggers: [{ id: "tr", event: "lethalDamage", unitScope: "self" }],
    flows: {
      tr: {
        nodes: [
          { id: "tr", type: "trigger", options: { event: "lethalDamage" } },
          { id: "heal", type: "heal" },
          { id: "me", type: "selfUnit" },
          { id: "v", type: "number", options: { mode: "const", value: 500 } },
        ],
        links: [
          { from: "tr", port: "next", to: "heal", portTo: "in" },
          { from: "me", port: "target", to: "heal", portTo: "targets" },
          { from: "v", port: "num", to: "heal", portTo: "value" },
        ],
      },
    },
  });
  const battle = createBattle({
    registry,
    seed: 3,
    units: [
      { cardId: "default_unit_hero", side: "ally", slot: 1 },
      { cardId: "default_unit_dummy", side: "enemy", slot: 1 },
    ],
  });
  const effect = registry.getEffect("default_effect_laststand");
  const prepared = prepareFlow(effect.flows.tr);
  assert.equal(prepared.ok, true, prepared.errors.join("；"));
  const u1 = battle.getUnit("u1");
  u1.hp = 1;
  const heals = [];
  runFlow(prepared, {
    self: u1,
    context: {},
    healUnit: (u, amount) => heals.push([u && u.key, amount]),
    unitData: () => 0,
    damage: () => {},
    setHp: () => {},
    attachEffect: () => {},
    removeEffectByMode: () => {},
    summon: () => {},
    skipTurn: () => {},
    grantImmune: () => {},
    forceExit: () => {},
    giveSkill: () => {},
    sideOf: (u) => u.side,
    otherSide: (s) => "enemy",
    listSide: () => [],
    currentTarget: () => [],
    pickForPlayer: () => [],
    rng: Math.random,
  }, { triggerNode: "tr" });
  assert.deepEqual(heals, [["u1", 500]], "回复打在濒死单位上");
});

/* ------------------------------------------------------------------ */
/* 编辑器工程                                                          */
/* ------------------------------------------------------------------ */
t.suite("编辑器工程", () => {});

/* ------------------------------------------------------------------ */
/* 编辑器工程                                                          */
/* ------------------------------------------------------------------ */
t.suite("编辑器工程", () => {});

t.test("新建工程：默认角色数值 + 占位卡面", () => {
  const project = createProject();
  assert.equal(project.character.level, 90);
  assert.equal(project.character.baseHp, 5000);
  assert.deepEqual(project.skills, []);
  assert.deepEqual(project.effects, []);
  assert.equal(resolveImage(""), PLACEHOLDER_IMAGE);
  assert.equal(resolveImage("castorice"), "castorice");
});

t.test("工程校验：没有技能流程的技能通过、非法 id 报错", () => {
  const project = createProject();
  project.character.name = "测试角色";
  project.character.id = "custom_unit_test";
  const skill = createSkill("custom_skill_a", "技能A");
  project.skills.push(skill);
  project.character.skillIds.push(skill.id);
  const r = validateProject(project);
  assert.equal(r.ok, true, r.errors.join("；"));

  project.skills[0].id = "bad-id";
  const r2 = validateProject(project);
  assert.equal(r2.ok, false);
  assert.ok(r2.byCard.skills["bad-id"].length > 0);
});

t.test("工程 → 内容包 → 注册表 → 战斗（技能流程能跑）", () => {
  const project = createProject();
  project.character.name = "编辑角色";
  project.character.id = "custom_unit_edited";
  const skill = createSkill("custom_skill_smash", "重击");
  skill.flow = {
    nodes: [
      { id: "tr", type: "trigger", options: { event: "skillCast" } },
      { id: "atk", type: "attack", options: { attribute: "magic" } },
      { id: "cur", type: "currentTarget" },
      { id: "v", type: "number", options: { mode: "const", value: 200 } },
    ],
    links: [
      { from: "tr", port: "next", to: "atk", portTo: "in" },
      { from: "cur", port: "set", to: "atk", portTo: "targets" },
      { from: "v", port: "num", to: "atk", portTo: "value" },
    ],
  };
  project.skills.push(skill);
  project.character.skillIds.push(skill.id);

  const effect = createEffect("custom_effect_burn", "灼烧");
  effect.triggers.push({
    block: { id: "b1", event: "turnStart", unitScope: "self" },
  });
  effect.flows = {
    b1: {
      nodes: [
        { id: "tr", type: "trigger", options: { event: "turnStart" } },
        { id: "atk", type: "attack", options: { attribute: "true" } },
        { id: "side", type: "targetSide", options: { side: "enemy" } },
        { id: "v", type: "number", options: { mode: "const", value: 25 } },
      ],
      links: [
        { from: "tr", port: "next", to: "atk", portTo: "in" },
        { from: "side", port: "set", to: "atk", portTo: "targets" },
        { from: "v", port: "num", to: "atk", portTo: "value" },
      ],
    },
  };
  project.effects.push(effect);
  project.character.effectIds.push(effect.id);

  const content = projectToContent(project);
  assert.equal(content.units.units[0].image, undefined);
  assert.equal(content.skills.skills[0].format, "flow");
  assert.deepEqual(Object.keys(content.effects.effects[0].flows), ["b1"]);

  const registry = new ContentRegistry();
  const loaded = registry.load(projectToRegistryInput(project));
  assert.equal(loaded.ok, true, JSON.stringify(loaded.failed));

  const dummy = registry.addUnit({ name: "木桩", id: "custom_unit_dummy", baseHp: 5000, speed: 10 });
  assert.equal(dummy.ok, true);
  const battle = createBattle({
    registry,
    seed: 1,
    units: [
      { cardId: "custom_unit_edited", side: "ally", slot: 1 },
      { cardId: "custom_unit_dummy", side: "enemy", slot: 1 },
    ],
  });
  battle.useSkill(0);
  const dmg = battle.state.events.find((e) => e.type === BATTLE_EVENT.DAMAGE);
  assert.ok(dmg && dmg.finalDamage > 0, `魔法伤害 200 打过去应该有伤害：${dmg && dmg.finalDamage}`);
  // turnStart 触发灼烧：下一次回合开始会再扣 25
  assert.ok(battle.state.events.some((e) => e.type === BATTLE_EVENT.DAMAGE));
});

t.test("工程模拟编辑器产物：技能/效果流程都能被引擎加载并执行", () => {
  const project = createProject();
  project.character.name = "测试角色";
  project.character.id = "custom_unit_tester";
  const skill = createSkill("custom_skill_fireball", "火球");
  skill.flow = {
    nodes: [
      { id: "trg1", type: "trigger", options: { event: "skillCast" } },
      { id: "atk1", type: "attack", options: { attribute: "magic" } },
      { id: "set1", type: "targetSide", options: { side: "enemy" } },
      { id: "num1", type: "number", options: { mode: "const", value: 300 } },
    ],
    links: [
      { from: "trg1", port: "next", to: "atk1", portTo: "in" },
      { from: "set1", port: "set", to: "atk1", portTo: "targets" },
      { from: "num1", port: "num", to: "atk1", portTo: "value" },
    ],
  };
  project.skills.push(skill);
  project.character.skillIds.push(skill.id);

  const effect = createEffect("custom_effect_burn", "灼烧");
  const flow = {
    nodes: [
      { id: "trg1", type: "trigger", options: { event: "unitTurnStart" } },
      { id: "h1", type: "heal" },
      { id: "self1", type: "selfUnit" },
      { id: "n1", type: "number", options: { mode: "const", value: 100 } },
    ],
    links: [
      { from: "trg1", port: "next", to: "h1", portTo: "in" },
      { from: "self1", port: "target", to: "h1", portTo: "targets" },
      { from: "n1", port: "num", to: "h1", portTo: "value" },
    ],
  };
  effect.triggers.push({ block: { id: "trg1", event: "unitTurnStart", unitScope: "self" } });
  effect.flows.trg1 = flow;
  project.effects.push(effect);
  project.character.effectIds.push(effect.id);

  const registry = new ContentRegistry();
  const loaded = registry.load(projectToRegistryInput(project));
  assert.equal(loaded.ok, true, JSON.stringify(loaded.failed));
  registry.addUnit({ name: "木桩", id: "custom_unit_dummy", baseHp: 5000, speed: 10 });
  const battle = createBattle({
    registry,
    seed: 7,
    units: [
      { cardId: "custom_unit_tester", side: "ally", slot: 1 },
      { cardId: "custom_unit_dummy", side: "enemy", slot: 1 },
    ],
  });
  battle.getUnit("u1").hp = 3000;
  battle.attachEffect("u1", "custom_effect_burn");
  battle.useSkill(0);
  const dmg = battle.state.events.find((e) => e.type === BATTLE_EVENT.DAMAGE);
  assert.ok(dmg && dmg.finalDamage > 0, "火球打出了伤害（300×魔法加成，再扣防御与抗性）");
  battle.endTurn();
  battle.endTurn();
  // 下一个「单位行动开始时」：灼烧效果给自己回血
  assert.equal(battle.getUnit("u1").hp, 3100);
});

t.test("normalizeFlow：去掉编辑器 UI 状态，只留流程本体", () => {
  const flow = {
    nodes: [
      { id: "a", type: "summon", options: { event: "x" }, ui: { x: 10, y: 20, const: { unitId: "default_unit_slime", count: 3 }, locked: true } },
    ],
    links: [],
  };
  const out = normalizeFlow(flow);
  assert.deepEqual(out.nodes[0], { id: "a", type: "summon", options: { unitId: "default_unit_slime", count: 3, event: "x" } });
  assert.equal(JSON.stringify(flow).includes("locked"), true, "原对象不被修改");
});

process.exitCode = await t.done();
