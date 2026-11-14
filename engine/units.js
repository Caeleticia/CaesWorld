/**
 * units.js —— 单位卡：默认值、规范化、校验
 *
 * 一张单位卡 = 名字 + 基础数值 + 开关 + 选中限制 + 技能 id 列表 + 可选的条件加成(bonuses) + 角色介绍(description)。
 * 「效果加成」不写在卡上，而是由加成系统实时叠算（见 modifiers.js）；
 * 效果也不能初始挂在单位上——只能在战斗中用「附加效果」积木附加。
 */
import {
  RESISTANCE_ATTRIBUTES,
  QUALITIES,
  INVINCIBLE_LEVELS,
  INVINCIBLE_LABEL,
  UNIT_DEFAULTS,
  normalizeInvincible,
  UNSELECTABLE_MODES,
  normalizeUnselectable,
  parseId,
} from "./constants.js";

/** 只保留三系抗性：本源是真实伤害，不存抗性字段 */
function resistanceFill(source) {
  const src = source && typeof source === "object" ? source : {};
  const out = {};
  for (const a of RESISTANCE_ATTRIBUTES) {
    const v = Number(src[a]);
    out[a] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** 单位卡的全部可选字段的默认值（深拷贝，避免共享引用） */
export function createUnitDefaults() {
  return {
    name: "",
    id: "",
    quality: UNIT_DEFAULTS.quality,
    level: UNIT_DEFAULTS.level,
    baseHp: UNIT_DEFAULTS.baseHp,
    baseAtk: UNIT_DEFAULTS.baseAtk,
    baseDef: UNIT_DEFAULTS.baseDef,
    critRate: UNIT_DEFAULTS.critRate,
    critDamage: UNIT_DEFAULTS.critDamage,
    speed: UNIT_DEFAULTS.speed,
    /** 每回合默认可行动次数（角色字段「速度」） */
    actionsPerTurn: UNIT_DEFAULTS.actionsPerTurn,
    resistances: resistanceFill(UNIT_DEFAULTS.resistances),
    /** 标签（一个单位一个，可为空） */
    label: UNIT_DEFAULTS.label,
    /** 角色介绍：卡牌库详情里展示的背景 / 设定文本 */
    description: "",
    occupiesSlot: UNIT_DEFAULTS.occupiesSlot,
    countsAsUnit: UNIT_DEFAULTS.countsAsUnit,
    /** 选中限制：none / enemy / ally / all */
    unselectable: UNIT_DEFAULTS.unselectable,
    invincible: UNIT_DEFAULTS.invincible,
    /** 可获取：默认 true。目前只是卡面标记，还没有玩法读取它 */
    obtainable: UNIT_DEFAULTS.obtainable,
    /** 免疫负面效果 / 免疫控制类效果 */
    immuneNegative: UNIT_DEFAULTS.immuneNegative,
    immuneControl: UNIT_DEFAULTS.immuneControl,
    /** 技能：按顺序存放技能 id（战斗内每次使用技能时按索引取） */
    skills: [],
    /** 可选：条件加成（常驻 buff），格式见 modifiers.js → fromBonusOverrides */
    bonuses: [],
    /** 可选：成员效果。[{ effect, block, flow }] —— 角色自带、不可移除的效果，只在这张单位卡上生效 */
    members: [],
  };
}

/** 单位卡上的布尔开关（编辑器里是勾选框）；「无敌」是三档下拉，不在这里 */
export const UNIT_SWITCH_KEYS = Object.freeze(["occupiesSlot", "countsAsUnit", "obtainable", "immuneNegative", "immuneControl"]);

/** 把外部输入补全成完整单位卡（不改原对象）。缺失字段一律取默认值。 */
export function createUnitCard(input = {}) {
  const base = createUnitDefaults();
  const card = { ...base, ...input };
  // 显式传了 undefined 也当「没填」处理（旧工程 / 旧卡包没有这些字段）；
  // 明确给了非布尔值的仍然留给 validateUnitCard 报错。
  for (const key of UNIT_SWITCH_KEYS) {
    if (card[key] === undefined) card[key] = base[key];
  }
  card.unselectable = normalizeUnselectable(card.unselectable);
  // 无敌档位：旧卡包的 true/false 迁移成 damage/none（true 只代表“免伤”）
  card.invincible = normalizeInvincible(card.invincible);
  card.label = input.label === undefined || input.label === null ? "" : String(input.label);
  card.description = input.description === undefined || input.description === null ? "" : String(input.description);
  card.resistances = resistanceFill(input.resistances ?? base.resistances);
  const rawPerTurn = card.actionsPerTurn;
  const perTurn = rawPerTurn === undefined || rawPerTurn === null || rawPerTurn === "" ? NaN : Number(rawPerTurn);
  card.actionsPerTurn = Number.isFinite(perTurn) ? Math.max(0, Math.min(99, Math.floor(perTurn))) : 1;
  card.skills = Array.isArray(input.skills) ? input.skills.slice() : [];
  card.bonuses = Array.isArray(input.bonuses) ? input.bonuses.map((b) => ({ ...b })) : [];
  // 旧数据里可能残留 effects（角色初始挂载效果）：这个能力已移除，读入时直接丢弃
  delete card.effects;
  card.members = Array.isArray(input.members) ? input.members.map((m) => structuredClone(m)) : [];
  return card;
}

/**
 * 某个选择者能否选中目标单位。
 * selectorSide 是施放技能 / 触发效果一方的阵营：
 *   none  → 双方都可选
 *   enemy → 不可被目标敌对方选中（目标同阵营可选它）
 *   ally  → 不可被目标同阵营选中（目标敌对方可选它）
 *   all   → 双方都不可选
 */
export function canSelectUnit(unit, selectorSide) {
  if (!unit) return false;
  const mode = normalizeUnselectable(unit.unselectable);
  if (mode === "all") return false;
  if (mode === "none") return true;
  if (!selectorSide) return false;
  if (mode === "enemy") return selectorSide === unit.side;
  return selectorSide !== unit.side;
}

/** 数值字段检查 */
function checkNumber(errors, path, value, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path} 必须是有限数字`);
    return false;
  }
  if (integer && !Number.isInteger(value)) {
    errors.push(`${path} 必须是整数`);
    return false;
  }
  if (value < min || value > max) {
    errors.push(`${path} 超出范围 [${min}, ${max}]`);
    return false;
  }
  return true;
}

/**
 * 校验单位卡。返回纯数据结果（不抛异常），便于存档读取时汇总问题。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateUnitCard(card) {
  const errors = [];
  if (!card || typeof card !== "object") {
    return { ok: false, errors: ["单位卡必须是对象"] };
  }

  if (typeof card.name !== "string" || !card.name.trim()) {
    errors.push("name 不能为空");
  }

  const parsed = parseId(card.id);
  if (!parsed.ok) {
    errors.push(parsed.error);
  } else if (parsed.kind !== "unit") {
    errors.push(`单位卡的 id 类型段应为 unit：${card.id}`);
  }

  if (!QUALITIES.includes(card.quality)) {
    errors.push(`quality 必须是 ${QUALITIES.join("/")}：${card.quality}`);
  }

  checkNumber(errors, "level", card.level, { min: 1, max: 999, integer: true });
  checkNumber(errors, "baseHp", card.baseHp, { min: 0 });
  checkNumber(errors, "baseAtk", card.baseAtk, { min: 0 });
  checkNumber(errors, "baseDef", card.baseDef, { min: 0 });
  checkNumber(errors, "critRate", card.critRate, { min: 0, max: 1 });
  checkNumber(errors, "critDamage", card.critDamage, { min: 0 });
  checkNumber(errors, "speed", card.speed, { min: 0 });
  checkNumber(errors, "actionsPerTurn", card.actionsPerTurn, { min: 0, max: 99, integer: true });

  if (!card.resistances || typeof card.resistances !== "object") {
    errors.push("resistances 必须是对象");
  } else {
    for (const a of RESISTANCE_ATTRIBUTES) {
      checkNumber(errors, `resistances.${a}`, card.resistances[a], { min: -1, max: 1 });
    }
  }

  if (typeof card.label !== "string") errors.push("label 必须是字符串");
  else if (card.label.length > 40) errors.push("label 最多 40 个字符");

  if (card.description !== undefined && typeof card.description !== "string") {
    errors.push("description 必须是字符串");
  }

  for (const key of UNIT_SWITCH_KEYS) {
    if (typeof card[key] !== "boolean") errors.push(`${key} 必须是布尔值`);
  }
  if (!UNSELECTABLE_MODES.includes(card.unselectable)) {
    errors.push(`unselectable 必须是 ${UNSELECTABLE_MODES.join("/")}：${card.unselectable}`);
  }
  if (!INVINCIBLE_LEVELS.includes(card.invincible)) {
    errors.push(`invincible 必须是 ${INVINCIBLE_LEVELS.map((v) => `${v}(${INVINCIBLE_LABEL[v]})`).join(" / ")}`);
  }

  if (!Array.isArray(card.skills)) {
    errors.push("skills 必须是数组");
  } else {
    card.skills.forEach((sid, i) => {
      const p = parseId(sid);
      if (!p.ok) errors.push(`skills[${i}]: ${p.error}`);
      else if (p.kind !== "skill") errors.push(`skills[${i}] 类型段应为 skill：${sid}`);
    });
  }

  if (!Array.isArray(card.members)) {
    errors.push("members 必须是数组");
  } else {
    card.members.forEach((m, i) => {
      if (!m || !m.effect || typeof m.effect !== "object" || !m.effect.id) errors.push(`members[${i}].effect 无效`);
      else {
        const p = parseId(m.effect.id);
        if (!p.ok) errors.push(`members[${i}].effect.id: ${p.error}`);
      }
      if (!m || !m.block || typeof m.block.id !== "string") errors.push(`members[${i}].block 无效`);
    });
  }

  if (card.bonuses !== undefined && !Array.isArray(card.bonuses)) {
    errors.push("bonuses 必须是数组");
  }

  return { ok: errors.length === 0, errors };
}
