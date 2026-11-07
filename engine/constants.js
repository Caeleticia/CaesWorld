/**
 * constants.js —— 全局常量与枚举
 *
 * 伤害属性、品质、技能类型的唯一真源；id 格式解析也在这里。
 */

/** id 三段式分隔符：扩展包_类型_标识 */
export const ID_SEPARATOR = "_";

/** id 中的类型段（第二段）允许的取值 */
export const ID_KINDS = Object.freeze(["unit", "skill", "effect", "buff", "pack"]);

/** 可填写的属性名（与技能「属性」下拉一致；自定义属性也允许，但只有四系颜色） */
export const ATTRIBUTE_LABELS = Object.freeze({
  physical: "物理",
  magic: "魔法",
  spirit: "精神",
  origin: "本源",
});

/** 品质：白 / 蓝 / 金 / 彩。rank 用于排序比较。 */
export const QUALITIES = Object.freeze(["white", "blue", "gold", "rainbow"]);

export const QUALITY_RANK = Object.freeze({
  white: 0,
  blue: 1,
  gold: 2,
  rainbow: 3,
});

/** 品质显示名 */
export const QUALITY_LABEL = Object.freeze({
  white: "白",
  blue: "蓝",
  gold: "金",
  rainbow: "彩",
});

/**
 * 伤害属性（四系）。
 * color 是跳字的上下两色码（十六进制，不带 #），中间自然渐变。
 * 本源（origin）伤害不受任何加成、无视防御/抗性/免伤。
 */
export const ATTRIBUTES = Object.freeze(["physical", "magic", "spirit", "origin"]);

/** 有抗性的属性：本源是真实伤害，没有抗性 */
export const RESISTANCE_ATTRIBUTES = Object.freeze(["physical", "magic", "spirit"]);

export const ATTRIBUTE_INFO = Object.freeze({
  physical: Object.freeze({ label: "物理", upper: "D6D6D6", lower: "9E9E9E" }),
  magic: Object.freeze({ label: "魔法", upper: "A98BD0", lower: "774EA6" }),
  spirit: Object.freeze({ label: "精神", upper: "B3D6EE", lower: "77B1DB" }),
  origin: Object.freeze({ label: "本源", upper: "FFF3A1", lower: "FFA957" }),
});

/** 本源伤害：不吃加成、不看防御/抗性/免伤 */
export const TRUE_DAMAGE_ATTRIBUTE = "origin";

/** 技能类型 */
export const SKILL_TYPES = Object.freeze(["active", "passive"]);

export const SKILL_TYPE_LABEL = Object.freeze({ active: "主动", passive: "被动" });

/** 战斗中单位的状态 */
export const UNIT_STATES = Object.freeze(["alive", "dead", "removed"]);

/**
 * 效果的倾向：必选其一（不是「负面」勾选框）。
 * 正面 / 负面 / 特殊；「特殊」既不算正面也不算负面，不会被按倾向移除。
 */
export const EFFECT_POLARITIES = Object.freeze(["positive", "negative", "special"]);

export const EFFECT_POLARITY_LABEL = Object.freeze({
  positive: "正面",
  negative: "负面",
  special: "特殊",
});

/**
 * 取效果倾向。兼容旧存档：旧格式没有 polarity，只可能在 flags 里带 negative。
 * @param {object} def 效果卡
 * @returns {"positive"|"negative"|"special"}
 */
export function effectPolarityOf(def) {
  if (def && EFFECT_POLARITIES.includes(def.polarity)) return def.polarity;
  if (def && Array.isArray(def.flags) && def.flags.includes("negative")) return "negative";
  return "positive";
}

/** 阵营 */
export const SIDES = Object.freeze(["ally", "enemy"]);


/** 单位卡默认数值（白板单位） */
export const UNIT_DEFAULTS = Object.freeze({
  quality: "white",
  level: 90,
  baseHp: 5000,
  baseAtk: 1000,
  baseDef: 500,
  critRate: 0.05,
  critDamage: 0.5,
  speed: 100,
  /** 三系抗性；本源是真实伤害，没有抗性字段 */
  resistances: Object.freeze({ physical: 0.05, magic: 0.05, spirit: 0.05 }),
  /** 标签：战斗中每个单位独立的字段，一个单位只有一个标签（字符串，可为空） */
  label: "",
  occupiesSlot: true,
  countsAsUnit: true,
  invincible: false,
});

/** 默认品质顺序即“从低到高” */
export function qualityRank(quality) {
  const r = QUALITY_RANK[quality];
  return typeof r === "number" ? r : -1;
}

/**
 * 解析 id：<扩展包>_<类型>_<标识>
 * @returns {{ok: boolean, pack?: string, kind?: string, key?: string, error?: string}}
 *   标识本身可含下划线（如 default_unit_slime_king → key = slime_king）
 */
export function parseId(id) {
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: "id 不能为空" };
  }
  const parts = id.split(ID_SEPARATOR);
  if (parts.length < 3) {
    return { ok: false, error: `id 需要 <扩展包>_<类型>_<标识> 三段：${id}` };
  }
  const [pack, kind, ...rest] = parts;
  const key = rest.join(ID_SEPARATOR);
  if (!pack || !kind || !key) {
    return { ok: false, error: `id 各段不能为空：${id}` };
  }
  if (!ID_KINDS.includes(kind)) {
    return { ok: false, error: `id 类型段必须是 ${ID_KINDS.join("/")}：${id}` };
  }
  return { ok: true, pack, kind, key };
}

/** 组装 id（不做校验，校验交给 assertId） */
export function buildId(pack, kind, key) {
  return [pack, kind, key].join(ID_SEPARATOR);
}
