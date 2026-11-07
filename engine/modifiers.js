/**
 * modifiers.js —— 效果加成系统
 *
 * 卡上只写「基础数值」，所有「效果加成」都作为加成项(modifier)实时叠算：
 *
 *   atkPct / defPct / hpPct / atkFlat / defFlat / hpFlat / dmgBoostPct
 *   attrDmgBoostPct   四系：属性伤害提升
 *   attrPenPct        四系：属性抗性穿透（穿透作用于「抗性减伤率」，不必属同系）
 *   resistDownPct     B 抗性降低效果
 *   damageTakenPct    B 受到伤害提升效果
 *   vulnPct           B 易伤效果
 *   critRate / critDamage   暴击率 / 暴击伤害（可被加成）
 *
 * 「减防」不是这里的独立加成项：减防效果直接修正受击方的防御力（defPct / defFlat 为负），
 * 参与伤害计算的已经是修正后的防御力。
 *
 * 百分比一律存小数（5% = 0.05）。叠加规则：
 *   同一键的加成项直接相加（攻击力降低直接记成负的百分比加成）。
 *   多个层叠乘子(hpMul / atkMul / defMul)连乘得出生效倍率。
 */
import { ATTRIBUTES } from "./constants.js";
import { attrZero } from "./math.js";

/** 「单位卡.bonuses」里可以写的键（条件加成/常驻 buff） */
export const BONUS_KEYS = Object.freeze([
  "hpMul",
  "atkMul",
  "defMul",
  "atkPct",
  "defPct",
  "hpPct",
  "atkFlat",
  "defFlat",
  "hpFlat",
  "dmgBoostPct",
  "attrDmgBoostPct",
  "attrPenPct",
  "resistDownPct",
  "damageTakenPct",
  "vulnPct",
  "critRate",
  "critDamage",
  "speed",
]);

/** 运行时累加器里出现的键（含层叠乘子） */
export const MOD_ACCUM_KEYS = Object.freeze([...BONUS_KEYS]);

export function emptyAccum() {
  return {
    atkPct: 0,
    defPct: 0,
    hpPct: 0,
    atkFlat: 0,
    defFlat: 0,
    hpFlat: 0,
    dmgBoostPct: 0,
    resistDownPct: 0,
    damageTakenPct: 0,
    vulnPct: 0,
    critRate: 0,
    critDamage: 0,
    speed: 0,
    attrDmgBoostPct: attrZero(0),
    attrPenPct: attrZero(0),
    hpMul: 1,
    atkMul: 1,
    defMul: 1,
  };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 把一条加成描述写进累加器。
 * 未列在 BONUS_KEYS 的键会被忽略（保证存储结构稳定）。
 */
export function addBonus(acc, bonus) {
  if (!isPlainObject(bonus)) return acc;
  for (const key of BONUS_KEYS) {
    const v = bonus[key];
    if (v === undefined) continue;
    if (isPlainObject(v)) {
      for (const a of ATTRIBUTES) {
        const av = Number(v[a]);
        if (Number.isFinite(av)) acc[key][a] += av;
      }
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (key === "hpMul" || key === "atkMul" || key === "defMul") acc[key] *= n;
    else acc[key] += n;
  }
  return acc;
}

/** 校验一条「单位卡.bonuses」描述；返回错误字符串数组 */
export function validateBonus(bonus, path = "bonus") {
  const errors = [];
  if (!isPlainObject(bonus)) return [`${path} 必须是对象`];
  if (Object.keys(bonus).length === 0) errors.push(`${path} 不能为空`);
  if (bonus.id !== undefined && typeof bonus.id !== "string") errors.push(`${path}.id 必须是字符串`);
  if (bonus.label !== undefined && typeof bonus.label !== "string") errors.push(`${path}.label 必须是字符串`);
  for (const [key, v] of Object.entries(bonus)) {
    if (key === "id" || key === "label") continue;
    if (!BONUS_KEYS.includes(key)) {
      errors.push(`${path}.${key} 不是可用的加成键`);
      continue;
    }
    if (isPlainObject(v)) {
      for (const a of Object.keys(v)) {
        if (!ATTRIBUTES.includes(a)) errors.push(`${path}.${key}.${a} 不是有效属性`);
        else if (!Number.isFinite(Number(v[a]))) errors.push(`${path}.${key}.${a} 必须是数字`);
      }
    } else if (!Number.isFinite(Number(v))) {
      errors.push(`${path}.${key} 必须是数字`);
    }
  }
  return errors;
}
