/**
 * skills.js —— 技能卡：默认值、规范化、校验、运行时效果
 *
 * 一个技能 = 名字 + id + 类型(主动/被动) + 可选效果列表 / 积木流程。
 * 实际攻击由流程里的「攻击」积木完成，伤害属性与数值都在积木上指定，
 * 技能本身不带属性或倍率。
 */
import {
  ATTRIBUTES,
  SKILL_TYPES,
  parseId,
} from "./constants.js";

/** 技能数据的形式：直接数据 / 积木流程 */
export const SKILL_FORMATS = Object.freeze(["data", "flow"]);

/** 效果类型：伤害 / 加 buff / 移除 buff */
export const EFFECT_KINDS = Object.freeze(["damage", "buff", "dispel"]);

export function createSkillDefaults() {
  return {
    name: "",
    id: "",
    type: "active",
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
    /** 每回合可用次数；0 = 不限。每个单位独立计数，回合开始时刷新。 */
    usesPerTurn: 0,
    /** 整场对局可用次数；0 = 不限。每个单位独立计数，新上场的同名单位重新计数。 */
    usesTotal: 0,
    /** 技能图标路径；空 = 取模组 icons/skill/<短 id>.*，null = 强制不用图标 */
    image: "",
  };
}

export function createSkillCard(input = {}) {
  const skill = { ...createSkillDefaults(), ...input };
  skill.effects = Array.isArray(input.effects) ? input.effects.map((e) => ({ ...e })) : [];
  skill.usesPerTurn = Math.max(0, Math.floor(Number(skill.usesPerTurn) || 0));
  skill.usesTotal = Math.max(0, Math.floor(Number(skill.usesTotal) || 0));
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

  if (skill.valueSource !== "atk") {
    checkNumber(errors, "valueSource", skill.valueSource, { min: 0 });
  }

  checkNumber(errors, "targets", skill.targets, { min: -1, max: 99, integer: true });
  checkNumber(errors, "usesPerTurn", skill.usesPerTurn, { min: 0, max: 999, integer: true });
  checkNumber(errors, "usesTotal", skill.usesTotal, { min: 0, max: 9999, integer: true });
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

  if (skill.image !== undefined && skill.image !== null && typeof skill.image !== "string") {
    errors.push("image 必须是字符串或 null");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 规范化效果列表：默认单体伤害；伤害未写属性时按物理处理。
 * @returns {Array<object>}
 */
export function normalizeEffects(skill) {
  const list = Array.isArray(skill.effects) && skill.effects.length
    ? skill.effects
    : [{ kind: "damage", target: "enemy" }];
  return list.map((eff) => {
    const out = { ...eff };
    if (out.target === undefined) out.target = out.kind === "damage" ? "enemy" : "self";
    if (out.kind === "damage" && out.attribute === undefined) out.attribute = "physical";
    return out;
  });
}

/**
 * 释放这个技能时，是否需要玩家在战斗界面手动点选目标。
 *  - `requiresTarget`：需要「当前目标」的技能（旧数据式技能默认 true）；
 *  - 流程里出现「选择单位」积木：具体打谁 / 选谁由玩家决定。
 * 全体攻击、固定目标、纯自身效果等技能不需要玩家选目标。
 * @param {object} skill
 * @returns {boolean}
 */
export function skillNeedsPlayerTarget(skill) {
  if (!skill || typeof skill !== "object") return false;
  if (skill.requiresTarget) return true;
  const nodes = skill.flow && Array.isArray(skill.flow.nodes) ? skill.flow.nodes : [];
  return nodes.some((n) => n && n.type === "chooseUnit");
}

/**
 * 战斗界面选目标时需要知道的参数：
 *   max      最多可选几个（「选择单位」积木的「最多可选」，默认 1）
 *   required 必须选满（勾了「必须选满」）
 *   needsTarget 是否要玩家点选
 * @param {object} skill
 * @returns {{needsTarget: boolean, max: number, required: boolean}}
 */
export function skillTargetPickInfo(skill) {
  if (!skill || typeof skill !== "object") return { needsTarget: false, max: 1, required: false };
  const nodes = skill.flow && Array.isArray(skill.flow.nodes) ? skill.flow.nodes : [];
  const chooses = nodes.filter((n) => n && n.type === "chooseUnit");
  let max = 1;
  let required = false;
  for (const n of chooses) {
    const o = n.options || {};
    const c = Math.max(1, Math.floor(Number(o.count) || 1));
    if (c > max) max = c;
    if (o.mustFill) required = true;
  }
  return {
    needsTarget: Boolean(skill.requiresTarget) || chooses.length > 0,
    max,
    required,
  };
}
