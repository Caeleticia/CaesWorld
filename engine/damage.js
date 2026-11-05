/**
 * damage.js —— 伤害计算（纯函数，无状态）
 *
 * 假设 A 攻击 B，伤害属性为 attr：
 *
 *   伤害值 = 技能指定的数值(默认 A 攻击力) * 技能倍率
 *          * (1 + A 伤害提升%) * (1 + A 对应属性伤害提升%)
 *          * (暴击 ? 1 + A 暴击伤害 : 1)
 *   防御减伤率 = 1 - (A等级 + 10) / (A等级 + 10 + B防御力 * (1 - A 减防%))
 *   抗性减伤率 = B对应属性抗性 * (1 - B抗性降低%) - A对应属性穿透   （可以为负 → 额外增伤）
 *   易伤率     = B受到伤害提升% * B易伤%
 *   最终伤害   = 伤害值 * (1 - 防御减伤率) * (1 - 抗性减伤率) * (1 + 易伤率)
 *
 * 特例
 *  - 本源(origin)伤害：无视任何加成、防御、抗性、免伤/易伤、无敌与护盾，
 *    伤害 = 技能指定的数值 * 技能倍率，且不暴击。
 *  - 暴击伤害 / 各种加成可以为负，此时 (1 + x) 截断到 [0, 1]，
 *    防止负数伤害或把「减伤」变成「增伤」。
 */
import { TRUE_DAMAGE_ATTRIBUTE } from "./constants.js";
import { clamp, rollChance } from "./math.js";

/** 伤害提升类乘子：(1 + x)，x 为负时最多归零 */
const boost = (x) => Math.max(0, 1 + (Number(x) || 0));

/**
 * 防御减伤率 = 1 - (A等级+10)/(A等级+10 + B防御*(1-减防%))。
 * 上限 1（完全免疫）；不额外设 99% 之类的封顶——按公式取值。
 * @param {number} attackerLevel A 的等级
 * @param {number} defense B 的防御力（已含加成）
 * @param {number} [defReducePct] A 的防御减免百分比
 */
export function defenseReduction(attackerLevel, defense, defReducePct = 0) {
  const num = (Number(attackerLevel) || 0) + 10;
  const def = Math.max(0, Number(defense) || 0) * (1 - (Number(defReducePct) || 0));
  const rate = 1 - num / (num + def);
  return clamp(rate, 0, 1);
}

/** 抗性减伤率：B抗性 * (1 - B抗性降低) - A穿透（可为负） */
export function resistanceReduction(resistance, resistDownPct = 0, penPct = 0) {
  return (Number(resistance) || 0) * (1 - (Number(resistDownPct) || 0)) - (Number(penPct) || 0);
}

/** 易伤率：受到伤害提升效果 * 易伤效果 */
export function vulnerabilityRate(damageTakenPct = 0, vulnPct = 0) {
  return (Number(damageTakenPct) || 0) * (Number(vulnPct) || 0);
}

/**
 * 伤害值（暴击与否两种结果）。
 * @returns {{min: number, max: number}}
 */
export function damageRange(attacker, skillValue, multiplier, attribute = "physical") {
  if (attribute === TRUE_DAMAGE_ATTRIBUTE) {
    const v = skillValue * multiplier;
    return { min: v, max: v };
  }
  const beforeCrit =
    skillValue *
    multiplier *
    boost(attacker.dmgBoostPct) *
    boost(attacker.attrDmgBoostPct?.[attribute]);
  return {
    min: beforeCrit,
    max: beforeCrit * Math.max(0, 1 + (Number(attacker.critDamage) || 0)),
  };
}

/**
 * 目标侧的减伤系数（不含暴击）。
 */
export function damageTakenFactor(attacker, target, attribute = "physical") {
  const defRate = defenseReduction(attacker.level, target.def, attacker.defReducePct);
  const resRate = resistanceReduction(
    target.resistances?.[attribute] ?? 0,
    target.resistDownPct,
    attacker.attrPenPct?.[attribute]
  );
  const vulnRate = vulnerabilityRate(target.damageTakenPct, target.vulnPct);
  return {
    defenseReduction: defRate,
    resistanceReduction: resRate,
    vulnerabilityRate: vulnRate,
    factor: Math.max(0, 1 - defRate) * Math.max(0, 1 - resRate) * Math.max(0, 1 + vulnRate),
  };
}

/**
 * 完整伤害计算。
 *
 * @param {object} params
 * @param {object} params.attacker  已算好的面板（stats.computeStats）
 * @param {object} params.target    已算好的面板
 * @param {number} params.skillValue 技能指定的数值（默认 = attacker.atk）
 * @param {number} params.multiplier 技能倍率
 * @param {string} [params.attribute] 伤害属性
 * @param {boolean} [params.crit]    是否强制暴击（默认按暴击率随机）
 * @param {boolean} [params.noCrit]  强制不暴击
 * @param {() => number} [params.rng] 随机源（默认 Math.random）
 * @param {boolean} [params.targetInvincible] 目标是否无敌（无敌则伤害为 0）
 * @returns {object} 完整过程记录
 */
export function calculateDamage({
  attacker,
  target,
  skillValue,
  multiplier,
  attribute = "physical",
  crit,
  noCrit = false,
  rng = Math.random,
  targetInvincible = false,
}) {
  const isTrue = attribute === TRUE_DAMAGE_ATTRIBUTE;

  // 本源：数值与倍率都不吃加成；其它情况可省略 skillValue（默认取攻击力）
  const fallback = Number(attacker.atk) || 0;
  const value = Number.isFinite(Number(skillValue)) && skillValue !== null && skillValue !== undefined
    ? Number(skillValue)
    : fallback;
  const mult = Number(multiplier) || 0;

  let isCrit = false;
  if (!isTrue && !noCrit) {
    isCrit = typeof crit === "boolean" ? crit : rollChance(rng, attacker.critRate);
  }

  const { min: rawMin, max: rawMax } = damageRange(attacker, value, mult, attribute);
  const raw = isCrit ? rawMax : rawMin;

  let factors;
  if (isTrue) {
    factors = { defenseReduction: 0, resistanceReduction: 0, vulnerabilityRate: 0, factor: 1 };
  } else {
    factors = damageTakenFactor(attacker, target, attribute);
  }

  let final = raw * factors.factor;
  if (factors.factor <= 0) final = 0;
  if (targetInvincible) final = 0;

  return {
    attribute,
    isTrueDamage: isTrue,
    crit: isCrit,
    /** 技能指定的数值 / 倍率 */
    skillValue: value,
    multiplier: mult,
    /** 伤害值（暴击/非暴击后） */
    rawDamage: raw,
    rawDamageRange: { min: rawMin, max: rawMax },
    /** 各项系数 */
    dmgBoost: isTrue ? 0 : boost(attacker.dmgBoostPct),
    attrDmgBoost: isTrue ? 0 : boost(attacker.attrDmgBoostPct?.[attribute]),
    critFactor: isCrit ? Math.max(0, 1 + (Number(attacker.critDamage) || 0)) : 1,
    defenseReduction: factors.defenseReduction,
    resistanceReduction: factors.resistanceReduction,
    vulnerabilityRate: factors.vulnerabilityRate,
    takenFactor: factors.factor,
    targetInvincible: Boolean(targetInvincible),
    /** 最终伤害 */
    finalDamage: final,
  };
}
