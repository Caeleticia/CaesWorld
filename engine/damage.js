/**
 * damage.js —— 伤害计算（纯函数，无状态）
 *
 * 假设 A 攻击 B，伤害属性为 attr：
 *
 *   伤害值 = 攻击积木给的数值(默认 A 攻击力)
 *          * (1 + A 伤害提升%) * (1 + A 对应属性伤害提升%)
 *          * (暴击 ? 1 + A 暴击伤害 : 1)
 *   防御减伤率 = 1 - (5*A等级 + 500) / (B防御力 + 5*A等级 + 500)
 *   抗性减伤率 = B对应属性抗性 * (1 - B抗性降低%) - A对应属性穿透   （可以为负 → 额外增伤）
 *   易伤率     = B受到伤害提升% * B易伤%
 *   最终伤害   = 伤害值 * (1 - 防御减伤率) * (1 - 抗性减伤率) * (1 + 易伤率)
 *
 * 减防不单列在公式里：减防效果直接修正受击方的防御力（效果属性修正 / 加成为负），
 * 参与计算的 B防御力 已经是修正后的值。
 *
 * 特例
 *  - 本源(origin)伤害：无视任何加成、防御、抗性、免伤/易伤、无敌与护盾，
 *    伤害 = 数值，且不暴击。
 *  - 无视减免(ignoreReduction)：只跳过目标侧的防御 / 抗性 / 易伤，
 *    攻击方的伤害提升与暴击照常。
 *  - 附加伤害(additional)：不视为攻击，无视任何加成与减免，伤害 = 数值且不暴击；
 *    仍会走正常的扣血 / 退场流程。
 *  - 暴击伤害 / 各种加成可以为负，此时 (1 + x) 截断到 [0, 1]，
 *    防止负数伤害或把「减伤」变成「增伤」。
 */
import { TRUE_DAMAGE_ATTRIBUTE } from "./constants.js";
import { clamp, rollChance } from "./math.js";

/** 伤害提升类乘子：(1 + x)，x 为负时最多归零 */
const boost = (x) => Math.max(0, 1 + (Number(x) || 0));

/**
 * 防御减伤率 = 1 - (5*A等级+500)/(5*A等级+500 + B防御力)。
 * 上限 1（完全免疫）；不额外设 99% 之类的封顶——按公式取值。
 * 减防由受击方面板直接承担（防御力已被修正），这里不再收减防参数。
 * @param {number} attackerLevel A 的等级
 * @param {number} defense B 的防御力（已含加成 / 减防修正）
 */
export function defenseReduction(attackerLevel, defense) {
  const num = 5 * (Number(attackerLevel) || 0) + 500;
  const def = Math.max(0, Number(defense) || 0);
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
export function damageRange(attacker, skillValue, attribute = "physical") {
  if (attribute === TRUE_DAMAGE_ATTRIBUTE) {
    return { min: skillValue, max: skillValue };
  }
  const beforeCrit =
    skillValue *
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
  const defRate = defenseReduction(attacker.level, target.def);
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
 * @param {number} params.skillValue 攻击积木给的数值（默认 = attacker.atk）
 * @param {string} [params.attribute] 伤害属性
 * @param {boolean} [params.crit]    是否强制暴击（默认按暴击率随机）
 * @param {boolean} [params.noCrit]  强制不暴击
 * @param {() => number} [params.rng] 随机源（默认 Math.random）
 * @param {boolean} [params.targetInvincible] 目标是否无敌（无敌则伤害为 0）
 * @param {boolean} [params.ignoreReduction] 无视目标侧减免（防御 / 抗性 / 易伤）；攻击方加成与暴击照常
 * @param {boolean} [params.additional] 附加伤害：不视为攻击，无视任何加成与减免，且不暴击
 * @returns {object} 完整过程记录
 */
export function calculateDamage({
  attacker,
  target,
  skillValue,
  attribute = "physical",
  crit,
  noCrit = false,
  rng = Math.random,
  targetInvincible = false,
  ignoreReduction = false,
  additional = false,
}) {
  const isTrue = attribute === TRUE_DAMAGE_ATTRIBUTE;
  const noBonuses = isTrue || additional;

  // 本源 / 附加伤害：数值不吃加成；其它情况可省略 skillValue（默认取攻击力）
  const fallback = Number(attacker.atk) || 0;
  const value = Number.isFinite(Number(skillValue)) && skillValue !== null && skillValue !== undefined
    ? Number(skillValue)
    : fallback;

  let isCrit = false;
  if (!noBonuses && !noCrit) {
    isCrit = typeof crit === "boolean" ? crit : rollChance(rng, attacker.critRate);
  }

  const { min: rawMin, max: rawMax } = additional
    ? { min: value, max: value }
    : damageRange(attacker, value, attribute);
  const raw = isCrit ? rawMax : rawMin;

  let factors;
  if (noBonuses || ignoreReduction) {
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
    /** 附加伤害：不视为攻击、不吃加成和减免、不暴击 */
    isAdditionalDamage: Boolean(additional),
    /** 本次是否跳过了目标侧减免 */
    ignoreReduction: Boolean(ignoreReduction),
    crit: isCrit,
    /** 攻击积木给的数值 */
    skillValue: value,
    /** 伤害值（暴击/非暴击后） */
    rawDamage: raw,
    rawDamageRange: { min: rawMin, max: rawMax },
    /** 各项系数 */
    dmgBoost: noBonuses ? 0 : boost(attacker.dmgBoostPct),
    attrDmgBoost: noBonuses ? 0 : boost(attacker.attrDmgBoostPct?.[attribute]),
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
