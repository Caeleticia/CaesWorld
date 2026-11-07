/**
 * editor.js —— 编辑器工程与卡包（纯数据）
 *
 * 编辑器里同时存在多个「卡包」：角色、技能、效果都带 pack 字段归到某个卡包。
 * 「卡包」把原来的工程与内容包合并成一份文件：
 *   { schema, kind: "caeworld-pack", id, name, version, author, description,
 *     units: [...], skills: [...], effects: [...] }
 * 其中 units 是内容包形状的单位卡，skills / effects 额外保留 `ui` 与流程里的 `pos`，
 * 所以同一份文件既能被战斗引擎当内容包读，也能导回编辑器继续改。
 *
 * 积木存档里额外带 `ui`（位置、常量、提示），战斗引擎会忽略它。
 */
import { createUnitCard, validateUnitCard } from "./units.js";
import { createSkillCard, validateSkillCard } from "./skills.js";
import {
  EFFECT_POLARITIES,
  effectPolarityOf,
  normalizeEffectAttrBonus,
  parseId,
  validateEffectAttrBonus,
} from "./constants.js";
import { prepareFlow, FLOW_SCHEMA } from "./flow.js";

export const PROJECT_SCHEMA = 1;
export const PROJECT_KIND = "caeworld-editor-project";
/** 卡包文件的 kind：工程 + 内容合并成的一份文件 */
export const PACK_KIND = "caeworld-pack";
/** 「全部卡包」筛选下新建内容时使用的独立草稿包 */
export const DRAFT_PACK_ID = "draft";
export const DRAFT_PACK_NAME = "草稿包";

/** 卡包 id 会作为卡 id 的第一段，不能含 "_"、不能叫 all */
export const PACK_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

export function isValidPackId(id) {
  return typeof id === "string" && id.length > 0 && id !== "all" && PACK_ID_PATTERN.test(id);
}

/** 新建卡包元信息 */
export function createPack(id = DRAFT_PACK_ID, name = DRAFT_PACK_NAME) {
  return {
    id: String(id),
    name: String(name || id),
    version: 1,
    author: "",
    description: "",
  };
}

/** 新建空工程 */
export function createProject() {
  return {
    schema: PROJECT_SCHEMA,
    kind: PROJECT_KIND,
    updatedAt: null,
    pack: null,
    /** 工程里包含的卡包：{ id, name, version, author, description } */
    packs: [createPack("default", "默认包")],
    /** 一个工程可以包含多个角色；编辑器里可选一个进行编辑 */
    characters: [createCharacter()],
    skills: [],
    effects: [],
  };
}

export function createCharacter() {
  return {
    id: "custom_unit_char",
    name: "",
    /** 所属卡包：default / 模组包 id；用于编辑器与卡牌库筛选 */
    pack: "default",
    packName: "默认包",
    quality: "white",
    level: 90,
    baseHp: 5000,
    baseAtk: 1000,
    baseDef: 500,
    critRate: 0.05,
    critDamage: 0.5,
    speed: 100,
    /** 三系抗性；本源是真实伤害，没有抗性 */
    resistances: { physical: 0.05, magic: 0.05, spirit: 0.05 },
    label: "",
    occupiesSlot: true,
    countsAsUnit: true,
    invincible: false,
    image: "",
    skillIds: [],
  };
}

/** 工程里的全部角色。兼容旧工程的单个 character 字段。 */
export function charactersOf(project) {
  if (!project || typeof project !== "object") return [];
  if (Array.isArray(project.characters) && project.characters.length) return project.characters;
  if (project.character) return [project.character];
  return [];
}

/** 旧工程迁移到多角色格式（原地修改并返回） */
export function normalizeProject(project) {
  if (!project || typeof project !== "object") return createProject();
  if (!Array.isArray(project.characters) || !project.characters.length) {
    project.characters = project.character ? [project.character] : [createCharacter()];
  }
  delete project.character;
  if (!Array.isArray(project.skills)) project.skills = [];
  if (!Array.isArray(project.effects)) project.effects = [];
  if (!Array.isArray(project.removedSkillIds)) project.removedSkillIds = [];
  // 卡包清单：以项目上的 packs 为准，再按卡上的 pack 字段补全缺失的包
  if (!Array.isArray(project.packs)) project.packs = [];
  const known = new Map();
  for (const pack of project.packs) {
    if (!pack || typeof pack !== "object" || !pack.id) continue;
    pack.id = String(pack.id);
    pack.name = pack.name ? String(pack.name) : pack.id;
    if (!known.has(pack.id)) known.set(pack.id, pack);
  }
  project.packs = [...known.values()];

  const ensurePack = (id, name) => {
    const packId = String(id || "default");
    let pack = known.get(packId);
    if (!pack) {
      pack = createPack(packId, name || (packId === "default" ? "默认包" : packId));
      project.packs.push(pack);
      known.set(packId, pack);
    } else if (!pack.name) pack.name = name || packId;
    return pack;
  };

  for (const ch of project.characters) {
    if (!ch) continue;
    if (ch.pack === undefined || ch.pack === null || ch.pack === "") ch.pack = "default";
    // 效果不能初始挂载：旧工程里的 effectIds 直接丢弃
    delete ch.effectIds;
  }
  for (const card of [...project.characters, ...project.skills, ...project.effects]) {
    if (!card) continue;
    if (card.pack === undefined || card.pack === null || card.pack === "") card.pack = "default";
    const pack = ensurePack(card.pack, card.packName);
    // 以卡包清单里的名字为准，避免重命名后卡上还是旧名字
    card.pack = pack.id;
    card.packName = pack.name;
  }
  ensurePack("default", "默认包");
  for (const effect of project.effects) {
    if (!effect) continue;
    effect.attrBonus = normalizeEffectAttrBonus(effect.attrBonus);
    effect.autoConsume = Boolean(effect.autoConsume);
  }
  return project;
}

export function createSkill(id = "custom_skill_new", name = "新技能") {
  return {
    id,
    name,
    type: "active",
    description: "",
    pack: "default",
    packName: "默认包",
    flow: emptyFlow(),
    ui: defaultUi(),
  };
}

export function createEffect(id = "custom_effect_new", name = "新效果") {
  return {
    id,
    name,
    flags: [],
    /** 必选倾向：正面 / 负面 / 特殊 */
    polarity: "positive",
    /** 层数计数：关闭时永远 1 层 */
    stackable: false,
    /** 层数上限：0 = 无上限，默认 1 */
    maxStacks: 1,
    description: "",
    pack: "default",
    packName: "默认包",
    /** 属性修正：效果附着期间给持有者提供的面板加成，可空、可多条 */
    attrBonus: [],
    /** 自动消耗：持有者行动时，对应流程触发后自动移除一层 */
    autoConsume: false,
    triggers: [],
    flows: {},
    ui: defaultUi(),
  };
}

/** 触发积木在效果里的登记（flows / triggers 落盘格式） */
export function makeTriggerEntry(block, flow) {
  return {
    block: { id: block.id, event: block.options.event, unitScope: block.options.unitScope || "self" },
    flow,
  };
}

export function emptyFlow() {
  return { schema: FLOW_SCHEMA, kind: "flow", nodes: [], links: [] };
}

/** 编辑器 UI 状态：视口 + 每个积木的位置和常量 */
export function defaultUi() {
  return { view: { x: 0, y: 0, zoom: 1 }, blocks: {} };
}

/** 给某个积木的 UI 状态（不存在就建一个） */
export function uiOf(card, blockId) {
  if (!card.ui) card.ui = defaultUi();
  if (!card.ui.blocks) card.ui.blocks = {};
  if (!card.ui.blocks[blockId]) card.ui.blocks[blockId] = { x: 80, y: 80, const: {}, locked: false };
  return card.ui.blocks[blockId];
}

/** 默认占位卡面（内嵌 SVG，不依赖文件） */
export const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336" viewBox="0 0 240 336">
      <rect width="240" height="336" rx="16" fill="#F7FFFF" stroke="#7FC3C7" stroke-width="2" stroke-dasharray="8 6"/>
      <g fill="none" stroke="#B6DEDF" stroke-width="1">
        ${Array.from({ length: 12 }, (_, i) => `<path d="M0 ${(i + 1) * 26}h240"/>`).join("")}
      </g>
      <circle cx="120" cy="150" r="46" fill="#E5FFFF" stroke="#7FC3C7" stroke-width="2"/>
      <path d="M120 124v40M104 152l16 16 16-16" fill="none" stroke="#7FC3C7" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="120" y="236" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#7D9FA1">尚未选择卡面</text>
      <text x="120" y="264" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#B6DEDF">拖入图片 / 粘贴路径</text>
    </svg>`
  );

/** 卡面图片地址：空值用占位图 */
export function resolveImage(path) {
  const p = typeof path === "string" ? path.trim() : "";
  return p || PLACEHOLDER_IMAGE;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

/**
 * 校验工程。返回 { ok, errors, byCard: { characters: {}, character: [], skills: {}, effects: {} } }
 */
export function validateProject(project) {
  const errors = [];
  const byCard = { character: [], characters: {}, skills: {}, effects: {} };
  if (!project || typeof project !== "object") {
    return { ok: false, errors: ["工程必须是对象"], byCard };
  }
  // 卡包清单：id 唯一、格式合法
  const packIds = new Set();
  for (const pack of project.packs || []) {
    if (!pack || typeof pack !== "object" || !pack.id) {
      errors.push("卡包: 缺少 id");
      continue;
    }
    if (!isValidPackId(pack.id)) errors.push(`卡包 ${pack.id}: id 只能包含字母 / 数字 / . / -，且不能是 all`);
    if (packIds.has(pack.id)) errors.push(`卡包 id 重复：${pack.id}`);
    packIds.add(pack.id);
  }

  const characters = charactersOf(project);
  if (!characters.length) {
    const chErrors = ["工程至少需要一个角色"];
    byCard.character = chErrors;
    errors.push(...chErrors.map((e) => `角色: ${e}`));
  }
  const characterIds = new Set();
  for (const ch of characters) {
    const chErrors = [];
    const unitCard = characterToUnit(ch);
    const v = validateUnitCard(unitCard);
    if (!v.ok) chErrors.push(...v.errors.filter((e) => !/^skills\[/.test(e)));
    if (ch.image && typeof ch.image !== "string") chErrors.push("卡面图片路径必须是字符串");
    if (characterIds.has(ch.id)) chErrors.push(`角色 id 重复：${ch.id}`);
    characterIds.add(ch.id);
    byCard.characters[ch.id] = chErrors;
    if (!byCard.character.length) byCard.character = chErrors;
    errors.push(...chErrors.map((e) => `角色 ${ch.name || ch.id}: ${e}`));
  }

  const skillIds = new Set();
  for (const skill of project.skills || []) {
    const list = [];
    const card = skillToContent(skill);
    const sv = validateSkillCard(card);
    if (!sv.ok) list.push(...sv.errors.filter((e) => e !== "skills 必须是数组"));
    if (skillIds.has(skill.id)) list.push(`技能 id 重复：${skill.id}`);
    skillIds.add(skill.id);
    for (const e of flowErrors(skill.flow, "技能流程")) list.push(e);
    byCard.skills[skill.id] = list;
    errors.push(...list.map((e) => `技能 ${skill.name || skill.id}: ${e}`));
  }

  const effectIds = new Set();
  for (const effect of project.effects || []) {
    const list = [];
    const p = parseId(effect.id);
    if (!p.ok) list.push(p.error);
    else if (p.kind !== "effect") list.push(`效果 id 类型段应为 effect：${effect.id}`);
    if (!effect.name || !String(effect.name).trim()) list.push("名字不能为空");
    if (effect.polarity !== undefined && effect.polarity !== null && effect.polarity !== "" && !EFFECT_POLARITIES.includes(effect.polarity)) {
      list.push(`倾向必须是 ${EFFECT_POLARITIES.join("/")}：${effect.polarity}`);
    }
    if (effect.stackable !== undefined && typeof effect.stackable !== "boolean") {
      list.push("层数计数必须是布尔值");
    }
    if (effect.maxStacks !== undefined) {
      const n = Number(effect.maxStacks);
      if (!Number.isFinite(n) || n < 0) list.push(`层数上限必须是 ≥ 0 的数字：${effect.maxStacks}`);
    }
    list.push(...validateEffectAttrBonus(effect.attrBonus));
    if (effect.autoConsume !== undefined && typeof effect.autoConsume !== "boolean") {
      list.push("自动消耗必须是布尔值");
    }
    if (effectIds.has(effect.id)) list.push(`效果 id 重复：${effect.id}`);
    effectIds.add(effect.id);
    for (const t of effect.triggers || []) {
      const flow = (effect.flows || {})[t.block.id];
      if (!flow) list.push(`触发「${t.block.id}」还没有积木流程`);
      for (const e of flowErrors(flow, `触发 ${t.block.event}`)) list.push(e);
    }
    byCard.effects[effect.id] = list;
    errors.push(...list.map((e) => `效果 ${effect.name || effect.id}: ${e}`));
  }

  for (const ch of characters) {
    for (const sid of ch.skillIds || []) {
      if (!skillIds.has(sid)) errors.push(`角色 ${ch.name || ch.id} 挂载了不存在的技能 ${sid}`);
    }
  }

  return { ok: errors.length === 0, errors, byCard };
}

export function flowErrors(flow, label = "流程") {
  if (!flow) return [];
  const prepared = prepareFlow(flow);
  return prepared.errors.map((e) => `${label}: ${e}`);
}

/* ------------------------------------------------------------------ */
/* 工程 → 内容包                                                        */
/* ------------------------------------------------------------------ */

export function characterToUnit(ch) {
  const base = createUnitCard({
    id: ch.id,
    name: ch.name || "未命名角色",
    quality: ch.quality,
    level: ch.level,
    baseHp: ch.baseHp,
    baseAtk: ch.baseAtk,
    baseDef: ch.baseDef,
    critRate: ch.critRate,
    critDamage: ch.critDamage,
    speed: ch.speed,
    resistances: ch.resistances,
    label: ch.label,
    occupiesSlot: ch.occupiesSlot,
    countsAsUnit: ch.countsAsUnit,
    invincible: ch.invincible,
    skills: (ch.skillIds || []).slice(),
  });
  if (ch.pack) base.pack = String(ch.pack);
  if (ch.packName) base.packName = String(ch.packName);
  if (ch.image) base.image = ch.image;
  return base;
}

export function skillToContent(skill) {
  const card = createSkillCard({
    id: skill.id,
    name: skill.name || "未命名技能",
    type: skill.type,
    targets: 1,
    requiresTarget: false,
    effects: [],
    format: "flow",
    flow: skill.flow ? normalizeFlow(skill.flow) : emptyFlow(),
  });
  if (skill.pack) card.pack = String(skill.pack);
  if (skill.packName) card.packName = String(skill.packName);
  if (skill.description) card.description = skill.description;
  return card;
}

export function effectToContent(effect) {
  const maxStacks = Math.floor(Number(effect.maxStacks));
  return {
    id: effect.id,
    name: effect.name || "未命名效果",
    flags: Array.isArray(effect.flags) ? effect.flags.filter((f) => f !== "negative") : [],
    polarity: effectPolarityOf(effect),
    stackable: Boolean(effect.stackable),
    maxStacks: Number.isFinite(maxStacks) ? Math.max(0, maxStacks) : 1,
    description: effect.description || "",
    ...(effect.pack ? { pack: String(effect.pack) } : {}),
    ...(effect.packName ? { packName: String(effect.packName) } : {}),
    triggers: (effect.triggers || []).map((t) => ({ ...t.block })),
    flows: Object.fromEntries(
      (effect.triggers || []).map((t) => [
        t.block.id,
        normalizeFlow((effect.flows || {})[t.block.id] || emptyFlow()),
      ])
    ),
    attrBonus: normalizeEffectAttrBonus(effect.attrBonus),
    autoConsume: Boolean(effect.autoConsume),
  };
}

/** 卡包里的技能卡：内容包形状 + 编辑器位置信息 */
function skillToPackCard(skill) {
  const card = skillToContent(skill);
  card.flow = skill.flow ? structuredClone(skill.flow) : emptyFlow();
  if (skill.ui) card.ui = structuredClone(skill.ui);
  return card;
}

/** 卡包里的效果卡：内容包形状 + 编辑器位置信息 */
function effectToPackCard(effect) {
  const card = effectToContent(effect);
  card.flows = Object.fromEntries(
    (effect.triggers || []).map((t) => [
      t.block.id,
      (effect.flows || {})[t.block.id] ? structuredClone(effect.flows[t.block.id]) : emptyFlow(),
    ])
  );
  if (effect.ui) card.ui = structuredClone(effect.ui);
  return card;
}

/**
 * 把一个卡包导出成「卡包文件」（工程 + 内容合并）。
 * 只包含 pack 字段等于该卡包的卡；返回的对象可直接 JSON 序列化下载。
 */
export function packFileOf(project, packId) {
  const id = String(packId || "");
  const meta = (project.packs || []).find((p) => p && p.id === id) || createPack(id, id);
  const inPack = (card) => Boolean(card) && (card.pack || "default") === id;
  const characters = charactersOf(project).filter(inPack);
  const skills = (project.skills || []).filter(inPack);
  const effects = (project.effects || []).filter(inPack);
  return {
    schema: 1,
    kind: PACK_KIND,
    id,
    name: meta.name || id,
    version: Number.isFinite(Number(meta.version)) ? Number(meta.version) : 1,
    author: meta.author || "",
    description: meta.description || "",
    updatedAt: project.updatedAt || null,
    units: characters.map(characterToUnit),
    skills: skills.map(skillToPackCard),
    effects: effects.map(effectToPackCard),
  };
}

/** 去掉编辑器 UI 状态，只留流程本体 */
export function normalizeFlow(flow) {
  if (!flow) return emptyFlow();
  return {
    schema: FLOW_SCHEMA,
    kind: "flow",
    nodes: (flow.nodes || []).map((n) => {
      const out = { id: n.id, type: n.type };
      // 常量：数据线没接时运行时用的值
      const consts = (n.ui && n.ui.const) || {};
      const keep = {};
      for (const key of ["unitId", "skillId", "effectId", "attribute", "label", "count"]) {
        if (consts[key] !== undefined && consts[key] !== "") keep[key] = consts[key];
      }
      if (Object.keys(keep).length) out.options = keep;
      if (n.options && Object.keys(n.options).length) {
        // 积木自身的选项（触发事件、运算符…）
        out.options = { ...(out.options || {}), ...n.options };
      }
      return out;
    }),
    links: (flow.links || []).map((l) => ({ id: l.id, from: l.from, port: l.port, to: l.to, portTo: l.portTo })),
  };
}

/**
 * 工程 → 三份内容包（可直接写进 data/pack/<卡组>/ 下的单位/技能/效果.json）。
 * @returns {{units: object, skills: object, effects: object}}
 */
export function projectToContent(project) {
  const characters = charactersOf(project);
  return {
    units: { schema: 1, kind: "units", units: characters.map(characterToUnit) },
    skills: { schema: 1, kind: "skills", skills: (project.skills || []).map(skillToContent) },
    effects: { schema: 1, kind: "effects", effects: (project.effects || []).map(effectToContent) },
  };
}

/** 工程 → 可直接注册进引擎的内容（带注册表校验） */
export function projectToRegistryInput(project) {
  const content = projectToContent(project);
  return {
    units: content.units.units,
    skills: content.skills.skills,
    effects: content.effects.effects,
  };
}
