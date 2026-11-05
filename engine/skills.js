/**
 * skills.js —— 技能卡：默认值、规范化、校验、运行时效果
 *
 * 一个技能 = 名字 + id + 类型(主动/被动) + 属性 + 倍率 + 可选效果列表。
 * 数值公式里技能只贡献「倍率」（默认 1），其余全部来自实时加成。
 */
import {
  ATTRIBUTES,
  SKILL_TYPES,
  DEFAULT_SKILL_MULTIPLIER,
  parseId,
} from "./constants.js";

/** 技能数据有无「属性」字段：直接数据 / 积木流程 */
export const SKILL_FORMATS = Object.freeze(["data", "flow"]);

/** 效果类型：伤害 / 加 buff / 移除 buff */
export const EFFECT_KINDS = Object.freeze(["damage", "buff", "dispel"]);

export function createSkillDefaults() {
  return {
    name: "",
    id: "",
    type: "active",
    /** 技能属性：决定伤害吃哪一系加成，也是伤害默认属性 */
    attribute: "physical",
    /**
     * 倍率：可写单个数字，或按属性分别写 { physical: 1.2, magic: 0 }。
     * 不写 = 1。数值都乘在「技能指定的数值（默认攻击力）」上。
     */
    multiplier: DEFAULT_SKILL_MULTIPLIER,
    /**
     * 技能指定的数值来源：
     *   "atk"（默认）= 施放者实时攻击力
     *   number       = 固定数值
     */
    valueSource: "atk",
    /**
     * 使用的形式：
     *   "data"（默认）：effects 里填数据（伤害/加 buff/移除 buff），旧接口
     *   "flow"        ：effects 为空，执行流程来产生效果（积木编辑器生成的技能）
     */
    format: "data",
    /** 技能最多选中几个单位（默认 1，单体） */
    targets: 1,
    /**
     * 效果列表（有序执行）。为空时按默认单体伤害处理。
     *   damage: { target: "enemy"|"self", attribute?: 属性 }
     *   buff:   { target, buff: 运行时 buff 描述 }（def 可含 "ATTACKER" 占位）
     *   dispel: { target, tags?: string[] }  移除带指定标签的 buff
     */
    effects: [],
    requiresTarget: true,
  };
}

export function createSkillCard(input = {}) {
  const skill = { ...createSkillDefaults(), ...input };
  skill.effects = Array.isArray(input.effects) ? input.effects.map((e) => ({ ...e })) : [];
  return skill;
}

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

export function validateSkillCard(skill) {
  const errors = [];
  if (!skill || typeof skill !== "object") {
    return { ok: false, errors: ["技能卡必须是对象"] };
  }

  if (typeof skill.name !== "string" || !skill.name.trim()) {
    errors.push("name 不能为空");
  }

  const parsed = parseId(skill.id);
  if (!parsed.ok) errors.push(parsed.error);
  else if (parsed.kind !== "skill") errors.push(`技能卡的 id 类型段应为 skill：${skill.id}`);

  if (!SKILL_TYPES.includes(skill.type)) {
    errors.push(`type 必须是 ${SKILL_TYPES.join("/")}：${skill.type}`);
  }

  if (!ATTRIBUTES.includes(skill.attribute)) {
    errors.push(`attribute 必须是 ${ATTRIBUTES.join("/")}：${skill.attribute}`);
  }

  if (typeof skill.multiplier === "number") {
    checkNumber(errors, "multiplier", skill.multiplier, { min: 0 });
  } else if (skill.multiplier && typeof skill.multiplier === "object") {
    for (const a of ATTRIBUTES) {
      const v = skill.multiplier[a];
      if (v !== undefined) checkNumber(errors, `multiplier.${a}`, v, { min: 0 });
    }
  } else {
    errors.push("multiplier 必须是数字或按属性分流的对象");
  }

  if (skill.valueSource !== "atk") {
    checkNumber(errors, "valueSource", skill.valueSource, { min: 0 });
  }

  checkNumber(errors, "targets", skill.targets, { min: -1, max: 99, integer: true });
  if (!SKILL_FORMATS.includes(skill.format)) {
    errors.push(`format 必须是 ${SKILL_FORMATS.join("/")}：${skill.format}`);
  }

  if (!Array.isArray(skill.effects)) {
    errors.push("effects 必须是数组");
  } else {
    skill.effects.forEach((eff, i) => {
      if (!eff || !EFFECT_KINDS.includes(eff.kind)) {
        errors.push(`effects[${i}].kind 必须是 ${EFFECT_KINDS.join("/")}`);
        return;
      }
      if (eff.target !== undefined && !["enemy", "self"].includes(eff.target)) {
        errors.push(`effects[${i}].target 必须是 enemy/self`);
      }
      if (eff.kind === "damage" && eff.attribute !== undefined && !ATTRIBUTES.includes(eff.attribute)) {
        errors.push(`effects[${i}].attribute 无效：${eff.attribute}`);
      }
    });
  }

  if (typeof skill.requiresTarget !== "boolean") {
    errors.push("requiresTarget 必须是布尔值");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 取该属性下的倍率。
 * @param {object} skill
 * @param {string} attribute
 */
export function multiplierFor(skill, attribute) {
  const m = skill && skill.multiplier;
  if (typeof m === "number") return m;
  if (m && typeof m === "object") {
    const v = m[attribute];
    return typeof v === "number" ? v : 0;
  }
  return DEFAULT_SKILL_MULTIPLIER;
}

/**
 * 规范化效果列表：默认单体伤害，缺省属性取技能属性。
 * @returns {Array<object>}
 */
export function normalizeEffects(skill) {
  const list = Array.isArray(skill.effects) && skill.effects.length
    ? skill.effects
    : [{ kind: "damage", target: "enemy" }];
  return list.map((eff) => {
    const out = { ...eff };
    if (out.target === undefined) out.target = out.kind === "damage" ? "enemy" : "self";
    if (out.kind === "damage" && out.attribute === undefined) out.attribute = skill.attribute;
    return out;
  });
}
