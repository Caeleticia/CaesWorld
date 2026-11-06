/**
 * editor.js —— 编辑器工程（纯数据）
 *
 * 编辑器存的是「工程」：角色、技能、效果各一张卡，卡上的流程是积木流程。
 * 由工程生成正式内容包（与 data/pack/<卡组>/单位.json、技能.json、效果.json 同构），
 * 战斗引擎读的是内容包，不是工程。
 *
 * 积木存档里额外带 `ui`（位置、常量、提示），战斗引擎会忽略它。
 */
import { createUnitCard, validateUnitCard } from "./units.js";
import { createSkillCard, validateSkillCard } from "./skills.js";
import { parseId } from "./constants.js";
import { prepareFlow, FLOW_SCHEMA } from "./flow.js";

export const PROJECT_SCHEMA = 1;
export const PROJECT_KIND = "caeworld-editor-project";

/** 新建空工程 */
export function createProject() {
  return {
    schema: PROJECT_SCHEMA,
    kind: PROJECT_KIND,
    updatedAt: null,
    character: createCharacter(),
    skills: [],
    effects: [],
  };
}

export function createCharacter() {
  return {
    id: "custom_unit_char",
    name: "",
    quality: "white",
    level: 90,
    baseHp: 5000,
    baseAtk: 1000,
    baseDef: 500,
    critRate: 0.05,
    critDamage: 0.5,
    speed: 100,
    resistances: { physical: 0.05, magic: 0.05, spirit: 0.05, origin: 0.05 },
    label: "",
    occupiesSlot: true,
    countsAsUnit: true,
    invincible: false,
    image: "",
    skillIds: [],
    effectIds: [],
  };
}

export function createSkill(id = "custom_skill_new", name = "新技能") {
  return {
    id,
    name,
    type: "active",
    attribute: "physical",
    multiplier: 1,
    description: "",
    flow: emptyFlow(),
    ui: defaultUi(),
  };
}

export function createEffect(id = "custom_effect_new", name = "新效果") {
  return {
    id,
    name,
    flags: [],
    description: "",
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
 * 校验工程。返回 { ok, errors, byCard: { character: [], skills: {}, effects: {} } }
 */
export function validateProject(project) {
  const errors = [];
  const byCard = { character: [], skills: {}, effects: {} };
  if (!project || typeof project !== "object") {
    return { ok: false, errors: ["工程必须是对象"], byCard };
  }
  const ch = project.character || createCharacter();
  const chErrors = [];
  const unitCard = characterToUnit(ch);
  const v = validateUnitCard(unitCard);
  if (!v.ok) chErrors.push(...v.errors.filter((e) => !/^(skills|effects)\[/.test(e)));
  if (ch.image && typeof ch.image !== "string") chErrors.push("卡面图片路径必须是字符串");
  byCard.character = chErrors;
  errors.push(...chErrors.map((e) => `角色: ${e}`));

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

  for (const sid of ch.skillIds || []) {
    if (!skillIds.has(sid)) errors.push(`角色挂载了不存在的技能 ${sid}`);
  }
  for (const eid of ch.effectIds || []) {
    if (!effectIds.has(eid)) errors.push(`角色挂载了不存在的效果 ${eid}`);
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
    effects: (ch.effectIds || []).slice(),
  });
  if (ch.image) base.image = ch.image;
  return base;
}

export function skillToContent(skill) {
  const card = createSkillCard({
    id: skill.id,
    name: skill.name || "未命名技能",
    type: skill.type,
    attribute: skill.attribute,
    multiplier: skill.multiplier,
    targets: 1,
    requiresTarget: false,
    effects: [],
    format: "flow",
    flow: skill.flow ? normalizeFlow(skill.flow) : emptyFlow(),
  });
  if (skill.description) card.description = skill.description;
  return card;
}

export function effectToContent(effect) {
  return {
    id: effect.id,
    name: effect.name || "未命名效果",
    flags: (effect.flags || []).slice(),
    description: effect.description || "",
    triggers: (effect.triggers || []).map((t) => ({ ...t.block })),
    flows: Object.fromEntries(
      (effect.triggers || []).map((t) => [
        t.block.id,
        normalizeFlow((effect.flows || {})[t.block.id] || emptyFlow()),
      ])
    ),
    attrBonus: (effect.attrBonus || []).slice(),
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
  return {
    units: { schema: 1, kind: "units", units: [characterToUnit(project.character || createCharacter())] },
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
