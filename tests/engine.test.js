/**
 * engine.test.js —— 战斗引擎单测
 *
 *   node tests/engine.test.js
 *
 * 覆盖：卡面默认值与 id 规则、实时加成、伤害公式三段、本源特例、
 * 暴击、占位/计数/索敌、buff 计时、战斗流程与结束、存档重放。
 */
import { readFileSync } from "node:fs";
import { createHarness, assert, closeTo } from "./_harness.js";

import {
  ATTRIBUTE_INFO,
  UNIT_DEFAULTS,
  parseId,
  createUnitCard,
  validateUnitCard,
  createSkillCard,
  validateSkillCard,
  multiplierFor,
  normalizeEffects,
  emptyAccum,
  addBonus,
  computeStats,
  defenseReduction,
  resistanceReduction,
  vulnerabilityRate,
  damageRange,
  damageTakenFactor,
  calculateDamage,
  createRng,
  attrFill,
  canPlace,
  normalizeSlot,
  sortByDistance,
  selectTarget,
  createBuff,
  buffToBonus,
  ContentRegistry,
  createBattle,
  BATTLE_EVENT,
  BATTLE_END_REASON,
  serializeBattle,
  restoreBattle,
  serializeUnits,
  serializeSkills,
  validateContent,
  registryFromContent,
  createSaveStore,
  createMemoryDriver,
  SCHEMA_VERSION,
} from "../engine/index.js";

const t = createHarness("engine");

/* ------------------------------------------------------------------ */
/* 测试用内容                                                          */
/* ------------------------------------------------------------------ */
const content = {
  schema: SCHEMA_VERSION,
  units: [
    { name: "史莱姆", id: "default_unit_slime", skills: ["default_skill_beat", "default_skill_burn"] },
    { name: "史莱姆王", id: "default_unit_king", baseHp: 20000, baseAtk: 1500, baseDef: 800, speed: 80, skills: ["default_skill_beat"] },
    { name: "图腾", id: "default_unit_totem", occupiesSlot: false, countsAsUnit: false, baseHp: 3000, skills: ["default_skill_beat"] },
    { name: "守护石像", id: "default_unit_statue", invincible: true, skills: ["default_skill_beat"] },
  ],
  skills: [
    { name: "拍击", id: "default_skill_beat", type: "active", attribute: "physical", multiplier: 1 },
    { name: "本源燃烧", id: "default_skill_burn", type: "active", attribute: "origin", multiplier: 2 },
    { name: "血性", id: "default_skill_bloodlust", type: "passive", attribute: "physical" },
  ],
};

function makeRegistry() {
  const registry = new ContentRegistry();
  const r = registry.load(content);
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  return registry;
}

const statsOfCard = (card, acc = emptyAccum()) => computeStats(createUnitCard(card), acc);

/* ------------------------------------------------------------------ */
/* 数据定义                                                            */
/* ------------------------------------------------------------------ */
t.suite("卡面默认值", () => {});

t.test("单位默认值：等级/生命/攻击/防御/暴击/抗性/三开关", () => {
  const c = createUnitCard({ name: "x", id: "default_unit_x" });
  assert.equal(c.quality, "white");
  assert.equal(c.level, 90);
  assert.equal(c.baseHp, 5000);
  assert.equal(c.baseAtk, 1000);
  assert.equal(c.baseDef, 500);
  assert.equal(c.critRate, 0.05);
  assert.equal(c.critDamage, 0.5);
  for (const a of ["physical", "magic", "spirit", "origin"]) {
    assert.equal(c.resistances[a], 0.05);
  }
  assert.equal(c.occupiesSlot, true);
  assert.equal(c.countsAsUnit, true);
  assert.equal(c.invincible, false);
  assert.deepEqual(c.skills, []);
  assert.deepEqual(UNIT_DEFAULTS.resistances, { physical: 0.05, magic: 0.05, spirit: 0.05, origin: 0.05 });
});

t.test("默认值互不共享引用", () => {
  const a = createUnitCard({ name: "a", id: "default_unit_a" });
  const b = createUnitCard({ name: "b", id: "default_unit_b" });
  a.resistances.magic = 0.9;
  a.skills.push("default_skill_beat");
  assert.equal(b.resistances.magic, 0.05);
  assert.deepEqual(b.skills, []);
});

t.test("id 规则：扩展包_类型_标识", () => {
  assert.deepEqual(parseId("default_unit_slime"), { ok: true, pack: "default", kind: "unit", key: "slime" });
  assert.deepEqual(parseId("mod_unit_slime_king"), { ok: true, pack: "mod", kind: "unit", key: "slime_king" });
  assert.equal(parseId("default_slime").ok, false, "缺一段");
  assert.equal(parseId("default_monster_slime").ok, false, "类型段非法");
  assert.equal(parseId("").ok, false);
  assert.equal(parseId("default_unit_").ok, false);
});

t.test("单位卡校验：抓到全部问题", () => {
  const bad = validateUnitCard({ name: "", id: "default_skill_x", quality: "red", baseHp: -1, critRate: 2 });
  assert.equal(bad.ok, false);
  const reasons = bad.errors.join("|");
  assert.match(reasons, /name/);
  assert.match(reasons, /类型段应为 unit/);
  assert.match(reasons, /quality/);
  assert.match(reasons, /baseHp/);
  assert.match(reasons, /critRate/);
});

t.test("技能卡校验与倍率", () => {
  assert.equal(validateSkillCard(createSkillCard({ name: "a", id: "default_skill_a" })).ok, true);
  assert.equal(validateSkillCard(createSkillCard({ name: "a", id: "default_skill_a", type: "ultimate" })).ok, false);
  assert.equal(validateSkillCard(createSkillCard({ name: "a", id: "default_skill_a", attribute: "fire" })).ok, false);
  const s = createSkillCard({ name: "a", id: "default_skill_a", multiplier: { physical: 1.5 } });
  assert.equal(multiplierFor(s, "physical"), 1.5);
  assert.equal(multiplierFor(s, "magic"), 0);
  assert.equal(multiplierFor(createSkillCard({ name: "b", id: "default_skill_b", multiplier: 0.8 }), "magic"), 0.8);
});

t.test("技能效果：不填时默认单体伤害且属性取技能属性", () => {
  const s = createSkillCard({ name: "a", id: "default_skill_a", attribute: "magic" });
  assert.deepEqual(normalizeEffects(s), [{ kind: "damage", target: "enemy", attribute: "magic" }]);
});

t.test("伤害属性跳字颜色与种类", () => {
  assert.deepEqual(Object.keys(ATTRIBUTE_INFO), ["physical", "magic", "spirit", "origin"]);
  assert.deepEqual(ATTRIBUTE_INFO.physical, { label: "物理", upper: "D6D6D6", lower: "9E9E9E" });
  assert.deepEqual(ATTRIBUTE_INFO.magic, { label: "魔法", upper: "A98BD0", lower: "774EA6" });
  assert.deepEqual(ATTRIBUTE_INFO.spirit, { label: "精神", upper: "B3D6EE", lower: "77B1DB" });
  assert.deepEqual(ATTRIBUTE_INFO.origin, { label: "本源", upper: "FFF3A1", lower: "FFA957" });
});

/* ------------------------------------------------------------------ */
/* 实时面板                                                            */
/* ------------------------------------------------------------------ */
t.suite("实时加成", () => {});

t.test("攻击/防御/生命：基础*(1+%)+数值", () => {
  const s = statsOfCard({ name: "x", id: "default_unit_x" }, {
    ...emptyAccum(),
    atkPct: 0.2,
    atkFlat: 100,
    defPct: -0.5,
    defFlat: 50,
    hpPct: 0.1,
    hpFlat: 0,
  });
  closeTo(s.atk, 1000 * 1.2 + 100);
  closeTo(s.def, 500 * 0.5 + 50);
  closeTo(s.hp, 5500);
});

t.test("攻击力降低 = 负的百分比加成", () => {
  const acc = emptyAccum();
  addBonus(acc, { atkPct: -0.3 });
  assert.equal(computeStats(createUnitCard({ name: "x", id: "default_unit_x" }), acc).atk, 700);
});

t.test("暴击率/暴击伤害/速度可被加成", () => {
  const acc = emptyAccum();
  addBonus(acc, { critRate: 0.3, critDamage: 1, speed: 20 });
  const s = computeStats(createUnitCard({ name: "x", id: "default_unit_x" }), acc);
  closeTo(s.critRate, 0.35);
  closeTo(s.critDamage, 1.5);
  assert.equal(s.speed, UNIT_DEFAULTS.speed + 20);
});

t.test("四系加成分别叠算，未给键按 0 处理", () => {
  const acc = emptyAccum();
  addBonus(acc, { attrDmgBoostPct: { magic: 0.3 }, attrPenPct: { spirit: 0.1 } });
  addBonus(acc, { attrDmgBoostPct: { magic: 0.2, physical: 0.1 } });
  const s = computeStats(createUnitCard({ name: "x", id: "default_unit_x" }), acc);
  closeTo(s.attrDmgBoostPct.magic, 0.5);
  closeTo(s.attrDmgBoostPct.physical, 0.1);
  assert.equal(s.attrDmgBoostPct.spirit, 0);
  closeTo(s.attrPenPct.spirit, 0.1);
  assert.equal(s.attrPenPct.magic, 0);
});

t.test("未知加成键被忽略（存储结构稳定）", () => {
  const acc = emptyAccum();
  addBonus(acc, { whatever: 999 });
  assert.equal(acc.atkPct, 0);
  assert.equal("whatever" in acc, false);
});

/* ------------------------------------------------------------------ */
/* 伤害公式                                                            */
/* ------------------------------------------------------------------ */
t.suite("伤害公式", () => {});

const A0 = statsOfCard({ name: "A", id: "default_unit_a" });
const B0 = statsOfCard({ name: "B", id: "default_unit_b" });

t.test("基准：A 攻破 B（非暴击）= 158.333…", () => {
  const r = calculateDamage({ attacker: A0, target: B0, skillValue: A0.atk, multiplier: 1, attribute: "physical", crit: false });
  closeTo(r.defenseReduction, 1 - 100 / 600);
  closeTo(r.resistanceReduction, 0.05);
  closeTo(r.finalDamage, 1000 * (100 / 600) * 0.95);
});

t.test("基准：暴击 = ×1.5，且标记暴击", () => {
  const r = calculateDamage({ attacker: A0, target: B0, skillValue: A0.atk, multiplier: 1, attribute: "physical", crit: true });
  assert.equal(r.crit, true);
  closeTo(r.finalDamage, 1000 * 1.5 * (100 / 600) * 0.95);
});

t.test("防御减伤率 = 1-(A等级+10)/(A等级+10+B防御*(1-减防))", () => {
  closeTo(defenseReduction(90, 500), 1 - 100 / 600);
  closeTo(defenseReduction(90, 500, 0.5), 1 - 100 / 350);
  closeTo(defenseReduction(40, 0), 0);
  assert.ok(defenseReduction(90, 1e9) > 0.999, "按公式取值，不额外封顶");
  assert.equal(defenseReduction(90, Infinity), 1, "减伤率最多 1");
});

t.test("抗性减伤率 = 抗性*(1-抗性降低)-穿透，可为负", () => {
  closeTo(resistanceReduction(0.05), 0.05);
  closeTo(resistanceReduction(0.05, 0.4), 0.03);
  closeTo(resistanceReduction(0.05, 0, 0.2), -0.15);
  const pen = statsOfCard({ name: "A", id: "default_unit_a" }, (() => {
    const acc = emptyAccum();
    addBonus(acc, { attrPenPct: { physical: 0.2 } });
    return acc;
  })());
  const tf = damageTakenFactor(pen, B0, "physical");
  closeTo(tf.resistanceReduction, -0.15);
  closeTo(tf.factor, (1 - (1 - 100 / 600)) * 1.15 * 1);
});

t.test("易伤率 = 受到伤害提升 * 易伤", () => {
  closeTo(vulnerabilityRate(0.5, 0.3), 0.15);
  const B = statsOfCard({ name: "B", id: "default_unit_b" }, (() => {
    const acc = emptyAccum();
    addBonus(acc, { damageTakenPct: 0.5, vulnPct: 0.3, resistDownPct: 1 });
    return acc;
  })());
  const r = calculateDamage({ attacker: A0, target: B, skillValue: A0.atk, multiplier: 1, crit: false });
  closeTo(r.finalDamage, 1000 * (100 / 600) * 1 * 1.15, 1e-9, "抗性降低 100% 抵消抗性");
});

t.test("伤害提升 / 属性伤害提升分别乘算", () => {
  const A = statsOfCard({ name: "A", id: "default_unit_a" }, (() => {
    const acc = emptyAccum();
    addBonus(acc, { dmgBoostPct: 0.2, attrDmgBoostPct: { magic: 0.1, physical: 0.5 } });
    return acc;
  })());
  const r = calculateDamage({ attacker: A, target: B0, skillValue: A.atk, multiplier: 1.5, attribute: "physical", crit: false });
  closeTo(r.finalDamage, 1000 * 1.5 * 1.2 * 1.5 * (100 / 600) * 0.95);
});

t.test("伤害区间：range.min/max 对应不暴击/暴击", () => {
  const range = damageRange(A0, A0.atk, 1, "physical");
  closeTo(range.min, 1000);
  closeTo(range.max, 1500);
});

t.test("本源伤害：无视加成/防御/抗性/易伤", () => {
  const A = statsOfCard({ name: "A", id: "default_unit_a" }, (() => {
    const acc = emptyAccum();
    addBonus(acc, { dmgBoostPct: 5, attrDmgBoostPct: { origin: 5 }, attrPenPct: { origin: 0.5 }, critRate: 1 });
    return acc;
  })());
  const B = statsOfCard({ name: "B", id: "default_unit_b" }, (() => {
    const acc = emptyAccum();
    addBonus(acc, { resistDownPct: -9, damageTakenPct: 3, vulnPct: 3, defPct: 10 });
    return acc;
  })());
  const r = calculateDamage({ attacker: A, target: B, skillValue: 1234, multiplier: 2, attribute: "origin" });
  assert.equal(r.isTrueDamage, true);
  assert.equal(r.crit, false, "本源不暴击");
  assert.equal(r.takenFactor, 1);
  closeTo(r.finalDamage, 2468);
});

t.test("无敌：伤害为 0 但保留计算过程", () => {
  const r = calculateDamage({ attacker: A0, target: B0, skillValue: 1000, multiplier: 1, crit: false, targetInvincible: true });
  assert.equal(r.finalDamage, 0);
  assert.equal(r.targetInvincible, true);
});

t.test("不加 crit 参数时按暴击率掷骰", () => {
  let hits = 0;
  const rng = createRng(42);
  const A = statsOfCard({ name: "A", id: "default_unit_a" }, (() => {
    const acc = emptyAccum();
    addBonus(acc, { critRate: 0.25 - 0.05 });
    return acc;
  })());
  for (let i = 0; i < 4000; i += 1) {
    if (calculateDamage({ attacker: A, target: B0, skillValue: 1, multiplier: 1, rng }).crit) hits += 1;
  }
  closeTo(hits / 4000, 0.25, 0.02, "暴击率");
});

t.test("暴击伤害为负时系数截断为 0，不出现负伤害", () => {
  const A = { ...A0, critDamage: -2 };
  const r = calculateDamage({ attacker: A, target: B0, skillValue: 1000, multiplier: 1, crit: true });
  assert.ok(r.finalDamage >= 0);
  closeTo(r.finalDamage, 0);
});

/* ------------------------------------------------------------------ */
/* 站位 / 占位 / 索敌                                                   */
/* ------------------------------------------------------------------ */
t.suite("站位与索敌", () => {});

t.test("占位：两个占位单位不能同格，不占位可以叠", () => {
  const units = [{ id: "a", slot: 1, occupiesSlot: true }];
  assert.equal(canPlace(units, { id: "b", slot: 1, occupiesSlot: true }).ok, false);
  assert.equal(canPlace(units, { id: "b", slot: 2, occupiesSlot: true }).ok, true);
  assert.equal(canPlace(units, { id: "b", slot: 1, occupiesSlot: false }).ok, true);
});

t.test("slot 必须是非零整数", () => {
  assert.equal(normalizeSlot(0), null);
  assert.equal(normalizeSlot(1.5), null);
  assert.equal(normalizeSlot("2"), 2);
  assert.equal(normalizeSlot(-3), -3);
});

t.test("索敌：默认最近、跳过不计数单位", () => {
  const units = [
    { uid: "u1", id: "far", side: "enemy", slot: 3, countsAsUnit: true },
    { uid: "u2", id: "totem", side: "enemy", slot: 1, countsAsUnit: false },
    { uid: "u3", id: "near", side: "enemy", slot: 2, countsAsUnit: true },
    { uid: "u4", id: "ally", side: "ally", slot: 1, countsAsUnit: true },
  ];
  assert.equal(selectTarget(units, "enemy").uid, "u3");
  assert.equal(selectTarget(units, "enemy", { counted: false }).uid, "u2");
  assert.deepEqual(sortByDistance(units).map((u) => u.uid), ["u2", "u4", "u3", "u1"]);
});

/* ------------------------------------------------------------------ */
/* buff                                                                */
/* ------------------------------------------------------------------ */
t.suite("运行时效果", () => {});

t.test("属性限定 buff 只作用于该属性", () => {
  const b = createBuff({ label: "魔攻", attr: "magic", def: { atkPct: 0.3 } });
  const bonus = buffToBonus(b);
  assert.equal(bonus.atkPct, 0.3);
  const pen = createBuff({ label: "魔穿", attr: "magic", def: { attrPenPct: 0.2 } });
  assert.deepEqual(buffToBonus(pen).attrPenPct, { magic: 0.2 });
  const dmg = createBuff({ label: "魔伤", def: { attrDmgBoostPct: { magic: 0.4 } } });
  assert.deepEqual(buffToBonus(dmg).attrDmgBoostPct, { magic: 0.4 }, "未给键保持 0");
});

/* ------------------------------------------------------------------ */
/* 战斗流程                                                            */
/* ------------------------------------------------------------------ */
t.suite("战斗流程", () => {});

function makeBattle(units, opts = {}) {
  return createBattle({ registry: makeRegistry(), units, seed: opts.seed ?? 7, ...opts });
}

t.test("战斗从第一个行动者开始，事件带回合与序号", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ]);
  assert.equal(b.state.status, "running");
  assert.equal(b.state.turn, 1);
  assert.equal(b.state.activeId, "u1");
  assert.deepEqual(b.state.events.map((e) => e.type).slice(0, 2), [BATTLE_EVENT.BATTLE_START, BATTLE_EVENT.TURN_START]);
  assert.equal(b.state.events[0].seq, 1);
});

t.test("行动顺序按速度，同速按站位", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_king", side: "enemy", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 2 },
  ]);
  assert.deepEqual(b.order().map((u) => u.cardId), ["default_unit_slime", "default_unit_slime", "default_unit_king"]);
  assert.equal(b.order()[0].uid, "u1");
});

t.test("使用技能对目标造成伤害（实时取目标防御）", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ]);
  b.useSkill(0);
  const dmg = b.state.events.find((e) => e.type === BATTLE_EVENT.DAMAGE);
  const enemy = b.getUnit("u2");
  const expected = 1000 * (dmg.crit ? 1.5 : 1) * (100 / 600) * 0.95;
  closeTo(dmg.finalDamage, expected);
  closeTo(enemy.damageTaken, expected);
  closeTo(b.getUnit("u1").damageDealt, enemy.damageTaken);
});

t.test("结束回合后轮到下一个单位，buff 计时递减后到期移除", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ]);
  b.applyBuff("u1", { label: "守势", tags: ["guard"], duration: 1, def: { defPct: 1 } });
  closeTo(b.statsOf(b.getUnit("u1")).def, 1000);
  b.endTurn();
  assert.equal(b.state.activeId, "u2");
  assert.equal(b.getUnit("u1").buffs.length, 0);
  closeTo(b.statsOf(b.getUnit("u1")).def, 500);
  assert.ok(b.state.events.some((e) => e.type === BATTLE_EVENT.BUFF_EXPIRED));
});

t.test("技能施加 buff（buff 效果）与 dispel", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ]);
  const skill = {
    name: "强化",
    id: "default_skill_buff",
    type: "active",
    attribute: "physical",
    effects: [{ kind: "buff", target: "self", buff: { label: "强化", tags: ["buff"], duration: 2, def: { atkPct: 1 } } }],
  };
  b.getUnit("u1").skills.push(skill);
  b.useSkill(2);
  closeTo(b.statsOf(b.getUnit("u1")).atk, 2000);
  assert.equal(b.dispel("u1", ["buff"]), 1);
  closeTo(b.statsOf(b.getUnit("u1")).atk, 1000);
});

t.test("本源技能自带的 buff 照常生效（只是它的伤害不吃加成）", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ]);
  b.getUnit("u1").skills.push({
    name: "本源强化",
    id: "default_skill_obuff",
    type: "active",
    attribute: "origin",
    effects: [{ kind: "buff", target: "self", buff: { label: "x", def: { atkPct: 1 } } }],
  });
  b.useSkill(2);
  assert.equal(b.getUnit("u1").buffs.length, 1);
  closeTo(b.statsOf(b.getUnit("u1")).atk, 2000);
});

t.test("本源技能伤害不吃任何加成", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_king", side: "enemy", slot: 1 },
  ]);
  b.getUnit("u1").skills.push({ name: "本源", id: "default_skill_o", type: "active", attribute: "origin", multiplier: 2 });
  b.getUnit("u1").bonuses = [];
  b.applyBuff("u1", { label: "强化", def: { atkPct: 5, dmgBoostPct: 5 } });
  b.getUnit("u1").permanentBonuses.push({ atkPct: 3, attrDmgBoostPct: { origin: 3 } });
  b.useSkill(2);
  const dmg = b.state.events.find((e) => e.type === BATTLE_EVENT.DAMAGE);
  assert.ok(dmg, "目标必中");
  closeTo(dmg.finalDamage, 1000 * 2);
  closeTo(b.statsOf(b.getUnit("u1")).atk, 9000, 1e-9, "非本源面板仍是加成的：1000*(1+5+3)");
});

t.test("无敌单位：伤害 0、不死", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_statue", side: "enemy", slot: 1 },
  ]);
  b.useSkill(0);
  assert.equal(b.getUnit("u2").hp, 5000);
  assert.equal(b.isInvincible(b.getUnit("u2")), true);
});

t.test("击败全部计数单位即结束，胜利方正确", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ]);
  b.getUnit("u2").hp = 10;
  b.useSkill(0);
  assert.equal(b.state.status, "finished");
  assert.equal(b.state.winner, "ally");
  assert.equal(b.state.endReason, BATTLE_END_REASON.ENEMY_DEFEATED);
  assert.equal(b.getUnit("u2").state, "dead");
  assert.ok(b.state.events.some((e) => e.type === BATTLE_EVENT.BATTLE_END));
});

t.test("只计算计数单位：不计数目标全灭不算结束", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
    { cardId: "default_unit_totem", side: "enemy", slot: 1 },
  ]);
  b.getUnit("u3").hp = 1;
  // u2 先行动（同速按站位，u2 比 u1 远 → u1 先）… 直接手动打图腾
  b.dealDamage({ attackerRef: "u1", targetRef: "u3", value: 5000, multiplier: 1, attribute: "origin" }, { log: true });
  assert.equal(b.getUnit("u3").state, "dead");
  assert.equal(b.state.status, "running");
  assert.equal(selectTarget(b.state.units, "enemy").uid, "u2", "索敌跳过不计数单位");
});

t.test("外部入口（applyBuff / dealDamage）默认不污染事件日志", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ]);
  const before = b.state.events.length;
  const rec = b.dealDamage({ attackerRef: "u1", targetRef: "u2", value: 10, multiplier: 1 });
  b.applyBuff(b.active(), { label: "场景", def: { atkPct: 0.5 } });
  b.heal(b.active(), 10);
  assert.equal(b.state.events.length, before, "日志不应增长");
  assert.equal(rec.logged, false);
  assert.equal(b.active().buffs.length, 1);
  assert.ok(b.getUnit("u2").hp < 5000, "伤害照常生效");
});

t.test("被动技能不可主动使用；缺技能报错", () => {
  const registry = makeRegistry();
  registry.addSkill(content.skills[2]); // 血性（被动）
  const b = createBattle({
    registry,
    units: [{ cardId: "default_unit_slime", side: "ally", slot: 1 }],
    seed: 1,
  });
  b.getUnit("u1").skills = [registry.getSkill("default_skill_bloodlust"), registry.getSkill("default_skill_beat")];
  assert.throws(() => b.useSkill(0), /被动/);
  assert.throws(() => b.useSkill(9), /没有第/);
});

t.test("占位冲突在建战斗时直接报错", () => {
  assert.throws(
    () => makeBattle([
      { cardId: "default_unit_slime", side: "enemy", slot: 1 },
      { cardId: "default_unit_slime", side: "enemy", slot: 1 },
    ]),
    /已被占位/
  );
});

t.test("无上限地互相打会触发 maxCycles 保护", () => {
  const b = makeBattle([
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ], { maxCycles: 2 });
  for (let i = 0; i < 20 && b.state.status === "running"; i += 1) b.endTurn();
  assert.equal(b.state.status, "finished");
  assert.equal(b.state.endReason, BATTLE_END_REASON.MAX_CYCLES);
});

/* ------------------------------------------------------------------ */
/* 存档                                                                */
/* ------------------------------------------------------------------ */
t.suite("数据存储", () => {});

t.test("存档：同种子同操作 → 结果完全一致", () => {
  const units = [
    { cardId: "default_unit_slime", side: "ally", slot: 1 },
    { cardId: "default_unit_slime", side: "enemy", slot: 1 },
  ];
  const run = () => {
    const b = makeBattle(units);
    b.useSkill(0);
    b.endTurn();
    b.useSkill(0);
    return b.state.events.filter((e) => e.type === BATTLE_EVENT.DAMAGE).map((e) => e.finalDamage);
  };
  assert.deepEqual(run(), run());
});

t.test("存档：serialize → restore 对账一致（含随机暴击）", () => {
  const registry = makeRegistry();
  const b = createBattle({
    registry,
    seed: 12345,
    units: [
      { cardId: "default_unit_slime", side: "ally", slot: 1 },
      { cardId: "default_unit_slime", side: "enemy", slot: 1 },
    ],
  });
  const actions = [];
  for (let i = 0; i < 6 && b.state.status === "running"; i += 1) {
    if (i % 2 === 0) {
      b.useSkill(0);
      actions.push({ type: "skill", index: 0 });
    } else {
      b.endTurn();
      actions.push({ type: "end" });
    }
  }
  const save = JSON.parse(JSON.stringify(serializeBattle(b, actions)));
  assert.equal(save.kind, "battle");
  assert.equal(save.units[0].cardId, "default_unit_slime");

  const restored = restoreBattle(save, registry);
  assert.equal(restored.verified, true, restored.mismatches.join("；"));
  assert.equal(restored.battle.state.turn, b.state.turn);
  assert.equal(restored.battle.state.activeId, b.state.activeId);
});

t.test("存档：内容包校验能发现重复 id / 缺失技能 / 非法字段", () => {
  const doc = {
    schema: SCHEMA_VERSION,
    units: [
      { name: "a", id: "default_unit_a", skills: ["default_skill_missing"] },
      { name: "a2", id: "default_unit_a" },
      { name: "b", id: "default_monster_b" },
    ],
    skills: [{ name: "s", id: "default_skill_s", type: "active", attribute: "physical" }],
  };
  const r = validateContent(doc);
  assert.equal(r.ok, false);
  const text = r.errors.join("|");
  assert.match(text, /不存在的技能 default_skill_missing/);
  assert.match(text, /单位 id 重复/);
  assert.match(text, /类型段必须是 unit/);
});

t.test("内容包：序列化单位卡后可原样再载入", () => {
  const registry = makeRegistry();
  const doc = serializeUnits(registry);
  assert.equal(doc.kind, "units");
  const back = new ContentRegistry();
  const r = back.load({ units: doc.units, skills: serializeSkills(registry).skills });
  assert.equal(r.ok, true);
  assert.deepEqual(back.getUnit("default_unit_king"), registry.getUnit("default_unit_king"));
});

t.test("槽位：save / load / list / clear", () => {
  const store = createSaveStore(createMemoryDriver());
  assert.equal(store.load("battle"), null);
  store.save("battle", { seed: 1 });
  store.save("units", { units: [] });
  assert.deepEqual(store.load("battle"), { seed: 1 });
  assert.deepEqual(store.list().sort(), ["battle", "units"]);
  store.clear("battle");
  assert.equal(store.load("battle"), null);
  assert.deepEqual(store.list(), ["units"]);
});

t.test("真实内容包 data/units.json + data/skills.json 通过校验且引用完整", () => {
  const read = (p) => JSON.parse(readFileSync(new URL(p, new URL("../", import.meta.url)), "utf8"));
  const units = read("data/units.json");
  const skills = read("data/skills.json");
  const r = validateContent({ schema: SCHEMA_VERSION, units: units.units, skills: skills.skills });
  assert.equal(r.ok, true, r.errors.join("；"));
  assert.ok(units.units.some((u) => u.id === "default_unit_slime"));
  assert.ok(skills.skills.some((s) => s.id === "default_skill_slimebeat"));
  const registry = registryFromContent({ units: units.units, skills: skills.skills });
  const b = createBattle({
    registry,
    units: [
      { cardId: "default_unit_slime", side: "ally", slot: 1 },
      { cardId: "default_unit_slime", side: "enemy", slot: 1 },
    ],
    seed: 2,
  });
  b.useSkill(0);
  assert.ok(b.state.events.some((e) => e.type === BATTLE_EVENT.DAMAGE));
});

process.exitCode = await t.done();
