/**
 * registry.js —— 内容注册表：单位卡 / 技能卡
 *
 * 战斗时只认注册表：回合开始后把单位卡、技能卡深拷贝快照进战斗，
 * 之后注册表被改名/改数值也不会影响已开始的战斗。
 * 正式数据来自模组包（mods/<modname>.zip 内的 <modname>/<modname>.json，kind: "caeworld-pack"；
 * 旧的 mods/<文件名>.json 仍兼容），由 js/mods.js 汇总后载入。
 */
import { createUnitCard, validateUnitCard } from "./units.js";
import { createSkillCard, validateSkillCard } from "./skills.js";
import {
  EFFECT_POLARITIES,
  effectPolarityOf,
  normalizeEffectAttrBonus,
  parseEffectColor,
  parseId,
  validateEffectAttrBonus,
  validateEffectDisplay,
} from "./constants.js";

export class ContentRegistry {
  constructor() {
    this.units = new Map();
    this.skills = new Map();
    /** 效果卡：{ id, name, flags, polarity, stackable, maxStacks, triggers, flows, attrBonus, autoConsume, color, bar, barInvert } */
    this.effects = new Map();
    this.errors = [];
  }

  addUnit(input) {
    const card = createUnitCard(input);
    const { ok, errors } = validateUnitCard(card);
    if (!ok) {
      this.errors.push(`单位 ${card.id || "(无 id)"}: ${errors.join("；")}`);
      return { ok: false, errors };
    }
    if (this.units.has(card.id)) {
      const msg = `单位 id 重复：${card.id}`;
      this.errors.push(msg);
      return { ok: false, errors: [msg] };
    }
    this.units.set(card.id, card);
    return { ok: true, errors: [] };
  }

  addSkill(input) {
    const card = createSkillCard(input);
    const { ok, errors } = validateSkillCard(card);
    if (!ok) {
      this.errors.push(`技能 ${card.id || "(无 id)"}: ${errors.join("；")}`);
      return { ok: false, errors };
    }
    if (this.skills.has(card.id)) {
      const msg = `技能 id 重复：${card.id}`;
      this.errors.push(msg);
      return { ok: false, errors: [msg] };
    }
    this.skills.set(card.id, card);
    return { ok: true, errors: [] };
  }

  addEffect(input) {
    const def = structuredClone(input || {});
    const parsed = parseId(def.id);
    const errors = [];
    if (!parsed.ok) errors.push(parsed.error);
    else if (parsed.kind !== "effect") errors.push(`效果卡的 id 类型段应为 effect：${def.id}`);
    if (def.name !== undefined && typeof def.name !== "string") errors.push("name 必须是字符串");
    if (def.triggers !== undefined && !Array.isArray(def.triggers)) errors.push("triggers 必须是数组");
    errors.push(...validateEffectAttrBonus(def.attrBonus));
    if (def.polarity !== undefined && def.polarity !== null && def.polarity !== "" && !EFFECT_POLARITIES.includes(def.polarity)) {
      errors.push(`polarity 必须是 ${EFFECT_POLARITIES.join("/")}：${def.polarity}`);
    }
    if (def.stackable !== undefined && typeof def.stackable !== "boolean") {
      errors.push("stackable 必须是布尔值");
    }
    if (def.maxStacks !== undefined) {
      const n = Number(def.maxStacks);
      if (!Number.isFinite(n) || n < 0) errors.push(`maxStacks 必须是 ≥ 0 的数字：${def.maxStacks}`);
    }
    if (def.autoConsume !== undefined && typeof def.autoConsume !== "boolean") {
      errors.push("autoConsume 必须是布尔值");
    }
    if (def.image !== undefined && def.image !== null && typeof def.image !== "string") {
      errors.push("image 必须是字符串或 null");
    }
    errors.push(...validateEffectDisplay(def));
    if (errors.length) {
      this.errors.push(`效果 ${def.id || "(无 id)"}: ${errors.join("；")}`);
      return { ok: false, errors };
    }
    if (this.effects.has(def.id)) {
      const msg = `效果 id 重复：${def.id}`;
      this.errors.push(msg);
      return { ok: false, errors: [msg] };
    }
    const maxStacks = Math.floor(Number(def.maxStacks));
    this.effects.set(def.id, {
      id: def.id,
      name: def.name || def.id,
      flags: Array.isArray(def.flags) ? def.flags.filter((f) => f !== "negative") : [],
      /** 倾向是必选项：正面 / 负面 / 特殊（旧存档 flags.negative 自动迁移） */
      polarity: effectPolarityOf(def),
      /** 层数计数：关闭时永远 1 层；开启时按 maxStacks 叠加（0 = 无上限） */
      stackable: Boolean(def.stackable),
      maxStacks: Number.isFinite(maxStacks) ? Math.max(0, maxStacks) : 1,
      triggers: Array.isArray(def.triggers) ? def.triggers.map((t) => ({ ...t })) : [],
      flows: typeof def.flows === "object" && def.flows ? structuredClone(def.flows) : {},
      attrBonus: normalizeEffectAttrBonus(def.attrBonus),
      /** 自动消耗：每次该效果的触发流程执行完后消耗 1 层 */
      autoConsume: Boolean(def.autoConsume),
      description: def.description || "",
      ...(def.image === null ? { image: null } : def.image ? { image: String(def.image) } : {}),
      ...(def.color ? { color: parseEffectColor(def.color) || "" } : {}),
      bar: Boolean(def.bar),
      barInvert: Boolean(def.bar && def.barInvert),
      ...(def.pack ? { pack: String(def.pack) } : {}),
      ...(def.packName ? { packName: String(def.packName) } : {}),
    });
    return { ok: true, errors: [] };
  }

  getUnit(id) {
    return this.units.get(id) || null;
  }

  getEffect(id) {
    return this.effects.get(id) || null;
  }

  getSkill(id) {
    return this.skills.get(id) || null;
  }

  /** 载入一组内容；返回失败项，不抛异常 */
  load({ units = [], skills = [], effects = [] }) {
    const failed = [];
    for (const e of effects) {
      const r = this.addEffect(e);
      if (!r.ok) failed.push({ kind: "effect", id: e && e.id, errors: r.errors });
    }
    for (const u of units) {
      const r = this.addUnit(u);
      if (!r.ok) failed.push({ kind: "unit", id: u && u.id, errors: r.errors });
    }
    for (const s of skills) {
      const r = this.addSkill(s);
      if (!r.ok) failed.push({ kind: "skill", id: s && s.id, errors: r.errors });
    }
    return { ok: failed.length === 0, failed };
  }

  /** 校验单位卡引用的技能是否都存在 */
  checkSkillRefs() {
    const missing = [];
    for (const unit of this.units.values()) {
      for (const sid of unit.skills) {
        if (!this.skills.has(sid)) missing.push({ unit: unit.id, skill: sid });
      }
    }
    return missing;
  }

  snapshot() {
    return {
      units: [...this.units.values()].map((u) => structuredClone(u)),
      skills: [...this.skills.values()].map((s) => structuredClone(s)),
      effects: [...this.effects.values()].map((e) => structuredClone(e)),
    };
  }
}

/** 浏览器 / Node 通用：从 URL 拉 JSON */
export async function loadContentFromUrls(unitUrl, skillUrl) {
  const load = async (url) => {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`读取 ${url} 失败：HTTP ${res.status}`);
    return res.json();
  };
  const [unitsDoc, skillsDoc] = await Promise.all([load(unitUrl), load(skillUrl)]);
  const registry = new ContentRegistry();
  const { failed } = registry.load({
    units: unitsDoc.units || unitsDoc,
    skills: skillsDoc.skills || skillsDoc,
  });
  return { registry, failed, missingSkills: registry.checkSkillRefs() };
}
