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

/** 效果图标 / 进度条的默认颜色：按倾向取色，等价于原来状态图标的绿 / 红 / 黄 */
export const EFFECT_DEFAULT_COLORS = Object.freeze({
  positive: "#59c98a",
  negative: "#ff6b8b",
  special: "#ffb020",
});

/**
 * 解析效果颜色：支持 #RGB / #RRGGBB / RGB / RRGGBB / rgb(...) / rgba(...)。
 * @param {string} value
 * @returns {string|null} 规范化后的 #rrggbb；空值返回 ""；非法返回 null
 */
export function parseEffectColor(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const hex = raw.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex.split("").map((c) => c + c).join("")}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`.toLowerCase();
  const m = raw.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?%?)\s*[,\s]\s*(\d+(?:\.\d+)?%?)\s*[,\s]\s*(\d+(?:\.\d+)?%?)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i
  );
  if (!m) return null;
  const channel = (part) => {
    const n = Number(String(part).replace("%", ""));
    if (!Number.isFinite(n)) return 0;
    const v = String(part).endsWith("%") ? (n / 100) * 255 : n;
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return `#${[m[1], m[2], m[3]].map((c) => channel(c).toString(16).padStart(2, "0")).join("")}`;
}

/** 效果的实际颜色：自定义颜色优先，否则按倾向取默认色 */
export function effectColorOf(def) {
  const custom = parseEffectColor(def && def.color);
  if (custom) return custom;
  return EFFECT_DEFAULT_COLORS[effectPolarityOf(def)] || EFFECT_DEFAULT_COLORS.positive;
}

/**
 * 校验效果的颜色 / 条式显示 / 反转条字段。
 * @param {object} def
 * @returns {string[]}
 */
export function validateEffectDisplay(def) {
  const errors = [];
  if (!def || typeof def !== "object") return errors;
  if (def.bar !== undefined && typeof def.bar !== "boolean") errors.push("bar 必须是布尔值");
  if (def.barInvert !== undefined && typeof def.barInvert !== "boolean") {
    errors.push("barInvert 必须是布尔值");
  }
  if (def.color !== undefined && def.color !== null && typeof def.color !== "string") {
    errors.push("color 必须是字符串");
  } else if (def.color && parseEffectColor(def.color) === null) {
    errors.push("color 必须是 HEX 或 rgb(...)");
  }
  if (def.bar) {
    if (!def.stackable) errors.push("条式显示必须开启层数计数");
    const max = Math.floor(Number(def.maxStacks));
    if (!Number.isFinite(max) || max <= 0) errors.push("条式显示必须有上限（maxStacks > 0）");
  }
  if (def.barInvert && !def.bar) errors.push("只有条式显示的效果才能反转条");
  return errors;
}

/**
 * 效果「属性修正」可用的键：效果附着期间给持有者提供的面板加成。
 *
 *   atkPct / atkFlat / defPct / defFlat / hpPct / hpFlat —— 三项基础面板
 *   critRate / critDamage / speed / speedPct              —— 暴击与速度（数值 / 百分比）
 *   dmgBoostPct / damageTakenPct / vulnPct / resistDownPct —— 伤害类百分比
 *   physical / magic / spirit                            —— 三系抗性（百分点）
 *   attrDmgBoostPct.<系> / attrPenPct.<系>                —— 三系伤害提升 / 三系抗性穿透
 *
 * 「<系>」取 physical / magic / spirit；本源是真实伤害，既不吃伤害提升也没有抗性可穿，故不提供。
 * 百分比一律存小数（5% = 0.05）；数值项直接相加。
 */
export const EFFECT_ATTR_BONUS_KEYS = Object.freeze([
  "atkPct",
  "atkFlat",
  "defPct",
  "defFlat",
  "hpPct",
  "hpFlat",
  "critRate",
  "critDamage",
  "speed",
  "speedPct",
  "dmgBoostPct",
  "damageTakenPct",
  "vulnPct",
  "resistDownPct",
  "physical",
  "magic",
  "spirit",
  "attrDmgBoostPct.physical",
  "attrDmgBoostPct.magic",
  "attrDmgBoostPct.spirit",
  "attrPenPct.physical",
  "attrPenPct.magic",
  "attrPenPct.spirit",
]);

/** 三系抗性：属性修正里按「百分点」加到面板抗性上 */
const RESIST_ATTR_BONUS = Object.freeze(["physical", "magic", "spirit"]);

/**
 * 解析一条属性修正（兼容旧格式 { attr:"atk", pct:true }）。
 * @returns {{mod: string, value: number}|{resistance: string, value: number}|null}
 */
export function effectAttrBonusTarget(entry) {
  if (!entry || typeof entry !== "object") return null;
  const value = Number(entry.value);
  if (!Number.isFinite(value)) return null;
  const attr = String(entry.attr || "");
  // 旧格式：atk / def / hp + pct 开关
  if (attr === "atk" || attr === "def" || attr === "hp") {
    return { mod: `${attr}${entry.pct ? "Pct" : "Flat"}`, value };
  }
  // 三系抗性：直接加到面板抗性上（pct 开关无意义）
  if (RESIST_ATTR_BONUS.includes(attr)) return { resistance: attr, value };
  if (EFFECT_ATTR_BONUS_KEYS.includes(attr)) return { mod: attr, value };
  return null;
}

/** 归一化为当前格式 [{ attr, value }]，丢弃无法识别的项 */
export function normalizeEffectAttrBonus(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const target = effectAttrBonusTarget(entry);
    if (!target) continue;
    out.push({ attr: target.mod || target.resistance, value: target.value });
  }
  return out;
}

/** 校验属性修正数组；返回错误文案（空数组 = 合法） */
export function validateEffectAttrBonus(list, path = "attrBonus") {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return [`${path} 必须是数组`];
  const errors = [];
  list.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`${path}[${i}] 必须是对象`);
      return;
    }
    if (!Number.isFinite(Number(entry.value))) errors.push(`${path}[${i}].value 必须是数字`);
    else if (!effectAttrBonusTarget(entry)) errors.push(`${path}[${i}].attr 无法识别：${entry.attr}`);
  });
  return errors;
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
  /** 每回合默认可行动次数（角色字段「速度」）；回合开始时剩余次数重置为这个值 */
  actionsPerTurn: 1,
  /** 三系抗性；本源是真实伤害，没有抗性字段 */
  resistances: Object.freeze({ physical: 0.05, magic: 0.05, spirit: 0.05 }),
  /** 标签：战斗中每个单位独立的字段，一个单位只有一个标签（字符串，可为空） */
  label: "",
  occupiesSlot: true,
  countsAsUnit: true,
  invincible: false,
  /** 可获取：默认勾选。目前只是标记，还没有任何玩法用到（预留给卡池 / 掉落 / 图鉴筛选） */
  obtainable: true,
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
