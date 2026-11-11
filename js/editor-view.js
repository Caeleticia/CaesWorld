/**
 * editor-view.js —— 编辑器交互层
 *
 *  · 角色 / 技能 / 效果 的填写表单
 *  · 角色 / 技能 / 效果 的新建与删除（删除会清空流程引用，并记住不再从内容包补回）
 *  · 积木画布：拖拽积木、拖拽端口连线、滑钮切换拖拽画布或切割连线、技能流程模板、画布平移缩放
 *  · 实时生成「积木 JSON」与「执行流程 JSON」，并保存到 localStorage
 *
 * 纯前端，不依赖任何第三方库。引擎只负责数据结构与解释执行（engine/）。
 */
import {
  DEFAULT_PACK,
  buildFlowCatalog,
  BLOCK_GROUPS,
  DATA_TYPE_LABEL,
  inputPortIds,
  prepareFlow,
  variablePortType,
  createProject,
  createCharacter,
  createSkill,
  createEffect,
  characterToUnit,
  projectToContent,
  normalizeProject,
  validateProject,
  charactersOf,
  PLACEHOLDER_IMAGE as PLACEHOLDER,
  cardImagePath,
  cardIconPath,
  defaultCardImageName,
  resolveCardImage,
  RESISTANCE_ATTRIBUTES,
  EFFECT_ATTR_BONUS_KEYS,
  effectPolarityOf,
  effectColorOf,
  normalizeEffectAttrBonus,
  parseEffectColor,
  parseId,
  buildId,
  packFileOf,
  createPack,
  isValidPackId,
  PACK_KIND,
  PROJECT_KIND,
  DRAFT_PACK_ID,
  DRAFT_PACK_NAME,
} from "../engine/index.js";
import { loadContentPacks, DEFAULT_PACK_ID, DEFAULT_PACK_NAME, EDITOR_PACK_ID, EDITOR_PACK_NAME } from "./mods.js";
import { isZipBytes, unpackModZip } from "./mod-zip.js";
import { applyPackImagesToCards, applyPackImagesToUnits, makePackZip } from "./pack-export.js";
import { onDataCleared } from "./data-events.js";

/** 卡组：编辑器工程按卡组存 localStorage；内容来自单文件模组（mods/） */
let PACK = localStorage.getItem("caeworld:editor-pack") || DEFAULT_PACK;
let STORAGE_KEY = `caeworld:editor-project:${PACK}`;

/** 「当前卡组」也存在浏览器里；设置里清掉后要跟着换回默认卡组 */
function refreshPackContext() {
  PACK = localStorage.getItem("caeworld:editor-pack") || DEFAULT_PACK;
  STORAGE_KEY = `caeworld:editor-project:${PACK}`;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ================================================================== */
/* 状态                                                                */
/* ================================================================== */
let project = loadProject();

let active = {
  tab: "character",
  character: null,
  skill: null,
  effect: null,
  triggerId: null,
  /** 角色 / 技能 / 效果共用的「编辑中卡包」筛选：all 或 pack id */
  editPack: "all",
  /** 「卡包」标签页当前选中的卡包（导出 / 存档 JSON 用） */
  packId: null,
};

/** 换一个工程（导入用）；页面上的表单与画布一起重绘 */
function setProject(p) {
  project = normalizeProject(stripLegacyFields(p));
  active = {
    tab: "character",
    character: (project.characters || [])[0] || null,
    skill: (project.skills || [])[0] || null,
    effect: (project.effects || [])[0] || null,
    triggerId: null,
    editPack: "all",
    packId: null,
  };
  renderAll();
  switchTab("character");
}
let dirty = false;
let initialized = false;
/** 「清除所有浏览器数据」后页面马上重载：这段时间禁止任何自动保存把旧工程写回 */
let savesSuppressed = false;
let saveTimer = 0;
const catalog = buildFlowCatalog();

/**
 * 挂载技能区的界面状态：角色 / 效果各自记住搜索词、排序与正倒序。
 * 只影响编辑器展示，不写进卡包。
 */
const mountUi = {
  character: { query: "", sort: "time", order: "asc" },
  effect: { query: "", sort: "time", order: "asc" },
};

/** 旧工程兼容：技能卡曾带 attribute / multiplier；本源曾带抗性字段。读入时清掉。 */
function stripLegacyFields(p) {
  for (const s of (p && p.skills) || []) {
    delete s.attribute;
    delete s.multiplier;
  }
  for (const ch of charactersOf(p)) {
    if (ch.resistances) delete ch.resistances.origin;
  }
  return p;
}

function loadProject() {
  try {
    // 新格式：按卡组存；旧版本只有不带卡组后缀的 key，读一次当迁移
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("caeworld:editor-project");
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.kind === "caeworld-editor-project") {
        p.pack = PACK;
        return normalizeProject(stripLegacyFields(p));
      }
    }
  } catch {
    /* 读不出来就用空白工程 */
  }
  const blank = createProject();
  blank.pack = PACK;
  return blank;
}

/**
 * 把「默认包 + 已启用的模组」里的卡补进工程（按 id 去重，已有编辑不会被覆盖）。
 * 新模组启用后重新打开编辑器就能看到；删除过的卡记在 removed*Ids 里，不会被补回。
 */
async function hydrateFromPacks({ force = false } = {}) {
  const before = JSON.stringify(project);
  try {
    const res = await loadContentPacks({ includeEditor: false, force });
    // 停用模组后，工程里属于该模组的卡也移除
    const disabledPacks = new Set(res.disabledPackIds || []);
    if (disabledPacks.size) {
      project.characters = project.characters.filter((ch) => !disabledPacks.has(ch.pack));
      project.skills = project.skills.filter((s) => !disabledPacks.has(s.pack));
      project.effects = project.effects.filter((e) => !disabledPacks.has(e.pack));
      for (const ch of project.characters) {
        ch.skillIds = (ch.skillIds || []).filter((id) => project.skills.some((s) => s.id === id));
      }
      for (const effect of project.effects) {
        effect.skillIds = (effect.skillIds || []).filter((id) => project.skills.some((s) => s.id === id));
      }
    }
    // 空工程只有一个未命名的占位角色，先把占位角色去掉，换成内容包里的角色
    const onlyBlank =
      project.characters.length === 1 &&
      !project.characters[0].name &&
      !(project.characters[0].skillIds || []).length &&
      String(project.characters[0].id || "").startsWith("custom_unit_char");
    if (onlyBlank) project.characters = [];

    for (const card of res.units) {
      if (project.characters.some((ch) => ch.id === card.id)) continue;
      if (isRemoved("unit", card.id)) continue;
      project.characters.push(unitCardToCharacter(card));
    }
    for (const card of res.skills) {
      if (project.skills.some((s) => s.id === card.id)) continue;
      if (isRemoved("skill", card.id)) continue;
      const s = createSkill(card.id, card.name);
      Object.assign(s, {
        type: card.type || "active",
        description: card.description || "",
        image: card.image === null ? null : card.image || "",
        pack: card.pack || DEFAULT_PACK_ID,
        packName: card.packName || (card.pack === DEFAULT_PACK_ID ? DEFAULT_PACK_NAME : card.pack),
        usesPerTurn: Math.max(0, Math.floor(Number(card.usesPerTurn) || 0)),
        usesTotal: Math.max(0, Math.floor(Number(card.usesTotal) || 0)),
      });
      s.flow = flowFromContent(card.flow);
      project.skills.push(s);
    }
    for (const card of res.effects) {
      if (project.effects.some((e) => e.id === card.id)) continue;
      if (isRemoved("effect", card.id)) continue;
      const e = createEffect(card.id, card.name);
      e.flags = Array.isArray(card.flags) ? card.flags.filter((f) => f !== "negative") : [];
      e.polarity = effectPolarityOf(card);
      e.stackable = Boolean(card.stackable);
      e.maxStacks = Number.isFinite(Number(card.maxStacks)) ? Math.max(0, Math.floor(Number(card.maxStacks))) : 1;
      e.image = card.image === null ? null : card.image || "";
      e.color = typeof card.color === "string" ? card.color : "";
      e.bar = Boolean(card.bar);
      e.barInvert = Boolean(card.bar && card.barInvert);
      e.pack = card.pack || DEFAULT_PACK_ID;
      e.packName = card.packName || (card.pack === DEFAULT_PACK_ID ? DEFAULT_PACK_NAME : card.pack);
      e.attrBonus = normalizeEffectAttrBonus(card.attrBonus);
      e.autoConsume = Boolean(card.autoConsume);
      e.skillIds = Array.isArray(card.skillIds) ? [...new Set(card.skillIds.filter((x) => typeof x === "string" && x))] : [];
      if (card.ui) e.ui = clone(card.ui);
      e.triggers = (card.triggers || []).map((t) => ({
        block: { id: t.id, event: t.event, unitScope: t.unitScope || "self" },
      }));
      e.flows = {};
      for (const t of e.triggers) e.flows[t.block.id] = flowFromContent((card.flows || {})[t.block.id]);
      project.effects.push(e);
    }

    if (!project.characters.length) project.characters.push(createCharacter());
    const knownSkillIds = new Set((project.skills || []).map((s) => s.id));
    for (const ch of project.characters) {
      ch.skillIds = (ch.skillIds || []).filter((id) => knownSkillIds.has(id));
    }
    for (const effect of project.effects || []) {
      effect.skillIds = (effect.skillIds || []).filter((id) => knownSkillIds.has(id));
    }
    // 把内容包里的卡包登记进工程清单（否则卡包页 / 筛选看不到）
    normalizeProject(project);
    if (!currentCharacter()) active.character = project.characters[0] || null;
    if (!currentSkill()) active.skill = project.skills[0] || null;
    if (!currentEffect()) active.effect = project.effects[0] || null;
    const defaultLoaded = res.packs.some((p) => p.packId === DEFAULT_PACK_ID);
    const modCount = res.packs.filter(
      (p) => p.packId !== DEFAULT_PACK_ID && (p.source === "server" || p.source === "local")
    ).length;
    setStatus(
      `卡包：${defaultLoaded ? "默认包 + " : ""}${modCount} 个模组 · 角色 ${project.characters.length} · 技能 ${project.skills.length} · 效果 ${project.effects.length}`,
      "ok"
    );
    return { ok: true, changed: JSON.stringify(project) !== before };
  } catch (err) {
    setStatus("卡包读取失败：" + err.message, "bad");
    return { ok: false, changed: false };
  }
}

/** 丢弃还没落盘的自动保存，避免清除后又被定时器写回旧工程 */
function cancelPendingSave() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  dirty = false;
}

/** 「清除全部」后页面即将重载：连之后的自动保存 / beforeunload 也一并禁止 */
function suppressPendingSaves() {
  savesSuppressed = true;
  cancelPendingSave();
}

/**
 * 设置页清掉当前卡组（编辑器工程）后，重新从存储载入。
 * 关键点：先取消待写入的自动保存，否则旧工程会在 400ms 后又被写回 localStorage。
 */
async function reloadEditorFromStorage() {
  cancelPendingSave();
  refreshPackContext();
  project = loadProject();
  normalizeProject(project);
  project.pack = PACK;
  if (!project.characters.length) project.characters.push(createCharacter());
  active = {
    tab: "character",
    character: project.characters[0] || null,
    skill: (project.skills || [])[0] || null,
    effect: (project.effects || [])[0] || null,
    triggerId: null,
    editPack: "all",
    packId: null,
  };
  if (!initialized) return;
  switchTab("character");
  renderAll();
  // 工程刚被清空：强制重新下载卡包再补回，确保读到的是本地更新版而不是旧缓存
  const res = await hydrateFromPacks({ force: true });
  if (res.ok) {
    renderAll();
    if (res.changed) flushSave();
  }
}

function markDirty() {
  if (savesSuppressed) return;
  dirty = true;
  setStatus("编辑中…", "");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  if (savesSuppressed) return false;
  project.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    dirty = false;
    const skills = (project.skills || []).length;
    const effects = (project.effects || []).length;
    const ch = currentCharacter() || {};
    const characters = (project.characters || []).length;
    const flowOk = currentFlow() ? validateFlow() : true;
    setStatus(
      `已自动保存 · 角色「${ch.name || "未命名"}」· 角色 ${characters} · 技能 ${skills} · 效果 ${effects}` +
        (currentFlow() && !flowOk ? " · 流程有问题" : ""),
      "ok"
    );
    return true;
  } catch (err) {
    setStatus("保存失败：" + err.message, "bad");
    return false;
  }
}

function setStatus(text, kind = "") {
  const el = $("#ed-status");
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

/* ================================================================== */
/* 当前正在编辑的卡                                                    */
/* ================================================================== */
function currentCharacter() {
  const list = project.characters || [];
  return active.character && list.includes(active.character) ? active.character : null;
}

function currentSkill() {
  const list = project.skills || [];
  return active.skill && list.includes(active.skill) ? active.skill : null;
}

function currentEffect() {
  const list = project.effects || [];
  return active.effect && list.includes(active.effect) ? active.effect : null;
}

/** 当前标签页对应的「牌」（技能或效果） */
function currentCard() {
  if (active.tab === "skills") return currentSkill();
  if (active.tab === "effects") return currentEffect();
  return null;
}

/** 编辑器当前状态的精简视图（控制台调试用） */
export function getView() {
  const skill = currentSkill();
  const effect = currentEffect();
  const character = currentCharacter();
  return {
    pack: PACK,
    active: {
      tab: active.tab,
      characterId: character ? character.id : null,
      skillId: skill ? skill.id : null,
      effectId: effect ? effect.id : null,
      triggerId: active.triggerId,
      editPack: active.editPack,
      packId: active.packId,
    },
    packs: packsOfProject().map((p) => ({ id: p.id, name: p.name })),
    character: character ? character.name || "" : "",
    characters: (project.characters || []).map((ch) => ch.id),
    skills: project.skills.map((s) => s.id),
    effects: project.effects.map((e) => e.id),
  };
}

/** 当前正在编辑的流程：技能只有一条流程；效果按触发积木各有一条 */
function currentFlow() {
  const card = currentCard();
  if (!card) return null;
  if (active.tab === "skills") return card.flow;
  const trigger = (card.triggers || []).find((t) => t.block.id === active.triggerId) || null;
  if (!trigger) return null;
  card.flows = card.flows || {};
  if (!card.flows[trigger.block.id]) card.flows[trigger.block.id] = { schema: 1, kind: "flow", nodes: [], links: [] };
  return card.flows[trigger.block.id];
}

/* ================================================================== */
/* 渲染：标签页                                                         */
/* ================================================================== */
function switchTab(tab) {
  active.tab = tab;
  // 三个标签共用同一个「编辑中卡包」；切到任何一边都按它选卡
  ensureTabInPack(tab);
  $$(".ed-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
  // 技能与效果共用「数据 + 流程」面板，左侧表单在技能 / 效果之间切换
  const panel = tab === "character" ? "character" : tab === "packs" ? "packs" : "skills";
  $$(".ed-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === panel));
  const skillCol = $("#ed-skill-col");
  const effectCol = $("#ed-effect-col");
  if (skillCol) skillCol.hidden = tab !== "skills";
  if (effectCol) effectCol.hidden = tab !== "effects";
  renderAll();
}

function flowTriggerLabel() {
  const card = currentEffect();
  if (!card) return "无效果";
  if (!active.triggerId) return "未选择触发";
  const t = (card.triggers || []).find((x) => x.block.id === active.triggerId);
  return t ? TRIGGER_LABEL[t.block.event] || t.block.event : "未选择触发";
}

function renderAll() {
  // 先把三边当前卡都对齐到同一个编辑中卡包，再画表单 / 流程
  normalizeEditPack();
  ensureAllInPack();
  renderPalette();
  renderCharacter();
  renderSkillPanel();
  renderEffectPanel();
  renderPackPanel();
  renderFlow();
  renderJson();
  renderCardsList();
}

const PACK_ALL = "all";

function packOf(card) {
  return (card && card.pack) || DEFAULT_PACK_ID;
}

/** 工程里的卡包清单 */
function packsOfProject() {
  return project.packs || (project.packs = []);
}

function packEntry(id) {
  return packsOfProject().find((p) => p && p.id === id) || null;
}

function packNameById(id) {
  const meta = packEntry(id);
  if (meta && meta.name) return meta.name;
  if (id === DEFAULT_PACK_ID) return DEFAULT_PACK_NAME;
  if (id === DRAFT_PACK_ID) return DRAFT_PACK_NAME;
  if (id === EDITOR_PACK_ID) return EDITOR_PACK_NAME;
  return String(id);
}

function packNameOf(card) {
  return packNameById(packOf(card));
}

/* ---------------------------- 挂载技能区 ---------------------------- */
/** 挂载技能区当前优先展示的卡包：编辑中卡包优先，选「全部」时用当前卡所在的包 */
function mountUsedPack(scope) {
  const editPack = normalizeEditPack();
  if (editPack !== PACK_ALL) return editPack;
  const card = scope === "effect" ? currentEffect() : currentCharacter();
  return card && card.pack ? card.pack : null;
}

/** 挂载技能区里技能排序：时间按加入工程的先后（新加入的靠后），名称按中文排序 */
function sortSkillsForMount(list, scope) {
  const ui = mountUi[scope] || mountUi.character;
  const all = project.skills || [];
  const orderOf = (s) => {
    const i = all.indexOf(s);
    return i < 0 ? all.length : i;
  };
  const dir = ui.order === "desc" ? -1 : 1;
  return list.slice().sort((a, b) => {
    if (ui.sort === "name") {
      const byName = String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
      return dir * (byName || orderOf(a) - orderOf(b));
    }
    return dir * (orderOf(a) - orderOf(b));
  });
}

/** 挂载区按卡包分组后的列表（当前编辑卡包永远排第一） */
function mountGroupList(scope, selected) {
  const selectedSet = new Set(selected || []);
  const currentPack = mountUsedPack(scope);
  const groups = new Map();
  for (const s of project.skills || []) {
    const pack = packOf(s);
    if (!groups.has(pack)) groups.set(pack, []);
    groups.get(pack).push(s);
  }
  return {
    currentPack,
    selectedSet,
    list: [...groups.entries()]
      .map(([pack, cards]) => ({
        pack,
        name: packNameById(pack),
        cards: sortSkillsForMount(cards, scope),
        mounted: cards.filter((c) => selectedSet.has(c.id)).length,
      }))
      .sort((a, b) => {
        if (a.pack === currentPack && b.pack !== currentPack) return -1;
        if (b.pack === currentPack && a.pack !== currentPack) return 1;
        return String(a.name).localeCompare(String(b.name), "zh-CN");
      }),
  };
}

/** 挂载区「列表本体」：只重绘这里，保留工具栏按钮节点，避免点一次就换掉按钮 */
function renderMountBodyHtml(scope, selected) {
  const skills = project.skills || [];
  if (!skills.length) return `<p class="hint">还没有技能，去「设计技能」里新建一个。</p>`;
  const { currentPack, selectedSet, list } = mountGroupList(scope, selected);
  if (!list.length) return `<p class="hint">没有可挂载的技能。</p>`;
  const groupsHtml = list
    .map((group) => {
      const rows = group.cards
        .map((s) => {
          const checked = selectedSet.has(s.id);
          const searchText = `${s.name || ""} ${s.id || ""} ${group.name || ""} ${group.pack || ""}`.toLowerCase();
          return `<label class="mount-row ${checked ? "is-checked" : ""}" data-search="${escapeHtml(searchText)}">
            <input type="checkbox" data-mount-skill data-skill-id="${escapeHtml(s.id)}" ${checked ? "checked" : ""} />
            <span class="mount-name">${escapeHtml(s.name || s.id)}</span>
            <code>${escapeHtml(s.id)}</code>
          </label>`;
        })
        .join("");
      return `<section class="mount-pack" data-pack="${escapeHtml(group.pack)}">
        <h3>
          <span class="mount-pack-name">${escapeHtml(group.name)}</span>
          ${group.pack === currentPack ? `<em class="mount-pack-now">当前编辑卡包</em>` : ""}
          <b class="mount-pack-count" title="已挂载 / 本栏技能">${group.mounted}/${group.cards.length}</b>
        </h3>
        <div class="mount-rows">${rows}</div>
      </section>`;
    })
    .join("");
  return `<div class="mount-groups">${groupsHtml}</div>
    <p class="mount-empty" hidden>没有匹配的技能。</p>`;
}

/** 渲染挂载技能区的完整 HTML：工具栏 + 统计 + 列表 */
function renderMountPanelHtml(scope, selected) {
  const ui = mountUi[scope] || (mountUi[scope] = { query: "", sort: "time", order: "asc" });
  const skills = project.skills || [];
  const selectedSet = new Set(selected || []);
  const totalMounted = skills.filter((s) => selectedSet.has(s.id)).length;
  return `<div class="mount-toolbar">
    <input class="mount-search" data-mount-search type="search" autocomplete="off"
      placeholder="搜索技能名 / id / 卡包" value="${escapeHtml(ui.query)}" aria-label="搜索技能" />
    <select class="mount-sort" data-mount-sort aria-label="技能排序">
      <option value="time" ${ui.sort === "time" ? "selected" : ""}>时间</option>
      <option value="name" ${ui.sort === "name" ? "selected" : ""}>名称</option>
    </select>
    <button class="btn tiny mount-order" type="button" data-action="mount-order"
      data-order="${ui.order === "asc" ? "desc" : "asc"}"
      title="切换为${ui.order === "asc" ? "倒序" : "正序"}">${ui.order === "asc" ? "正序 ↑" : "倒序 ↓"}</button>
  </div>
  <div class="mount-summary">
    <span>共 ${skills.length} 个技能</span>
    <span data-mount-total>已挂载 ${totalMounted}</span>
  </div>
  <div class="mount-body">${renderMountBodyHtml(scope, selected)}</div>`;
}

/** 只更新按钮上的「下一次顺序」，不替换按钮本身 */
function syncMountOrderButton(box, ui) {
  const btn = box && box.querySelector('[data-action="mount-order"]');
  if (!btn) return;
  btn.dataset.order = ui.order === "asc" ? "desc" : "asc";
  btn.textContent = ui.order === "asc" ? "正序 ↑" : "倒序 ↓";
  btn.title = `切换为${ui.order === "asc" ? "倒序" : "正序"}`;
}

/**
 * 刷新一个挂载技能区（排序 / 正倒序切换后）。
 * 只重绘列表本体并原地更新按钮文案，工具栏节点不变——
 * 这样一次点击不会把按钮换成新节点，下一次点击一定还能命中原按钮。
 */
function refreshMountPanel(scope) {
  const box = scope === "effect" ? $("#ed-effect-mount") : $("#ed-mount-skills");
  if (!box) return;
  const card = scope === "effect" ? currentEffect() : currentCharacter();
  const selected = card ? card.skillIds || [] : [];
  const body = box.querySelector(".mount-body");
  if (body) body.innerHTML = renderMountBodyHtml(scope, selected);
  const sortSel = box.querySelector("[data-mount-sort]");
  if (sortSel) sortSel.value = mountUi[scope].sort;
  syncMountOrderButton(box, mountUi[scope]);
  applyMountSearch(box, mountUi[scope].query);
}

/** 搜索过滤：只改 DOM 的显隐，不重建列表，输入框不会因此失焦 */
function applyMountSearch(panel, query) {
  if (!panel) return;
  const q = String(query || "").trim().toLowerCase();
  let any = false;
  for (const group of panel.querySelectorAll(".mount-pack")) {
    let visible = 0;
    for (const row of group.querySelectorAll(".mount-row")) {
      const hit = !q || String(row.dataset.search || "").includes(q);
      row.hidden = !hit;
      if (hit) visible += 1;
    }
    group.hidden = visible === 0;
    if (visible) any = true;
  }
  updateMountCounts(panel);
  const empty = panel.querySelector(".mount-empty");
  if (empty) empty.hidden = any || !panel.querySelector(".mount-pack");
}

/** 更新每栏「已挂载 / 可见」与总挂载数 */
function updateMountCounts(panel) {
  if (!panel) return;
  let mountedTotal = 0;
  for (const group of panel.querySelectorAll(".mount-pack")) {
    const rows = [...group.querySelectorAll(".mount-row")];
    const visible = rows.filter((row) => !row.hidden);
    const mounted = visible.filter((row) => row.querySelector("input")?.checked).length;
    const allMounted = rows.filter((row) => row.querySelector("input")?.checked).length;
    mountedTotal += allMounted;
    const count = group.querySelector(".mount-pack-count");
    if (count) count.textContent = `${mounted}/${visible.length}`;
  }
  const total = panel.querySelector("[data-mount-total]");
  if (total) total.textContent = `已挂载 ${mountedTotal}`;
}

/**
 * 挂载技能区的交互（角色 / 效果共用）：
 * 搜索、排序、正倒序、勾选挂载。返回 true 表示事件已被处理。
 */
function handleMountEvent(scope, e) {
  const panel = e.target.closest && e.target.closest(".mount-panel");
  if (!panel) return false;
  const ui = mountUi[scope] || (mountUi[scope] = { query: "", sort: "time", order: "asc" });
  const target = e.target;
  if (e.type === "input" && target.matches("[data-mount-search]")) {
    ui.query = target.value;
    applyMountSearch(panel, ui.query);
    return true;
  }
  if (e.type === "change" && target.matches("[data-mount-sort]")) {
    ui.sort = target.value === "name" ? "name" : "time";
    refreshMountPanel(scope);
    return true;
  }
  if (e.type === "click") {
    const orderBtn = target.closest('[data-action="mount-order"]');
    if (orderBtn) {
      // 用按钮上渲染时写好的目标顺序，而不是在事件里取反：
      // 这样即使一次点击被重复派发（触摸合成 / 重复监听），结果也是幂等的，
      // 不会出现「切到倒序后点不回正序」。
      const next = orderBtn.dataset.order === "desc" ? "desc" : "asc";
      if (ui.order !== next) {
        ui.order = next;
        refreshMountPanel(scope);
      }
      return true;
    }
  }
  if (e.type === "change" && target.matches("[data-mount-skill]")) {
    const card = scope === "effect" ? currentEffect() : currentCharacter();
    if (!card) return true;
    const id = target.dataset.skillId;
    const list = Array.isArray(card.skillIds) ? card.skillIds : (card.skillIds = []);
    card.skillIds = target.checked ? [...new Set([...list, id])] : list.filter((x) => x !== id);
    target.closest(".mount-row")?.classList.toggle("is-checked", target.checked);
    updateMountCounts(panel);
    markDirty();
    renderJson();
    return true;
  }
  return false;
}

/** 当前卡挂载的技能 id（挂载区渲染用） */
function mountSelectedIds(scope) {
  const card = scope === "effect" ? currentEffect() : currentCharacter();
  return card && Array.isArray(card.skillIds) ? card.skillIds : [];
}

function mountPanelShell(scope, attrs = "") {
  return `<div class="mount-panel" data-mount-scope="${scope}" ${attrs}>${renderMountPanelHtml(
    scope,
    mountSelectedIds(scope)
  )}</div>`;
}

/** 确保卡包存在，返回卡包对象 */
function ensurePack(id, name) {
  const packId = String(id || DEFAULT_PACK_ID);
  let pack = packEntry(packId);
  if (!pack) {
    pack = createPack(packId, name || packNameById(packId));
    packsOfProject().push(pack);
  } else if (!pack.name) pack.name = name || packId;
  return pack;
}

/** 新建内容时的目标卡包：编辑中卡包是「全部」时进草稿包 draft */
function newCardPack() {
  const filter = normalizeEditPack();
  const id = filter !== PACK_ALL ? filter : DRAFT_PACK_ID;
  const pack = ensurePack(id, id === DRAFT_PACK_ID ? DRAFT_PACK_NAME : undefined);
  active.packId = pack.id;
  return pack;
}

/** 卡包下拉的 option 列表 */
function packOptionsHtml(selected) {
  return packsOfProject()
    .filter((p) => p && p.id)
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"))
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}" ${String(p.id) === String(selected) ? "selected" : ""}>${escapeHtml(
          p.name || p.id
        )}（${escapeHtml(p.id)}）</option>`
    )
    .join("");
}

/** 卡包下拉（用于表单里的「所属卡包」） */
function packSelectHtml(attrs, selected) {
  return `<select ${attrs}>${packOptionsHtml(selected)}</select>`;
}

function fillPackSelect(el, selected) {
  if (!el) return selected;
  const opts = packsOfProject()
    .filter((p) => p && p.id)
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
  el.innerHTML =
    `<option value="${PACK_ALL}">全部卡包</option>` +
    opts
      .map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name || o.id)}（${escapeHtml(o.id)}）</option>`)
      .join("");
  const wanted = selected && opts.some((o) => o.id === selected) ? selected : PACK_ALL;
  el.value = wanted;
  return wanted;
}

function packMatch(card, pack) {
  return !pack || pack === PACK_ALL || packOf(card) === pack;
}

/** 编辑中卡包归一化：包不存在时回落到「全部卡包」 */
function normalizeEditPack() {
  if (!active.editPack) active.editPack = PACK_ALL;
  if (active.editPack !== PACK_ALL && !packEntry(active.editPack)) active.editPack = PACK_ALL;
  return active.editPack;
}

function firstCardInPack(list, pack) {
  return (list || []).find((card) => card && packMatch(card, pack)) || null;
}

/** 某个标签页的当前卡不在编辑中卡包里时，自动选该包的第一张（没有则为空） */
function ensureTabInPack(tab) {
  const pack = normalizeEditPack();
  if (tab === "character") {
    if (!active.character || !packMatch(active.character, pack)) {
      active.character = firstCardInPack(project.characters, pack);
    }
  } else if (tab === "skills") {
    if (!active.skill || !packMatch(active.skill, pack)) {
      active.skill = firstCardInPack(project.skills, pack);
    }
  } else if (tab === "effects") {
    if (!active.effect || !packMatch(active.effect, pack)) {
      active.effect = firstCardInPack(project.effects, pack);
      active.triggerId = null;
    }
  }
}

function ensureAllInPack() {
  ensureTabInPack("character");
  ensureTabInPack("skills");
  ensureTabInPack("effects");
}

/* ---------------------------- 卡包操作 ---------------------------- */
function allCards() {
  return [...(project.characters || []), ...(project.skills || []), ...(project.effects || [])];
}

/** 流程里可能引用卡 id 的常量字段 */
const CARD_REF_KEYS = ["unitId", "skillId", "effectId"];

/**
 * 删除过的卡 id 记在这里（按卡种类分开）。
 * 内容包每次载入时会跳过这些 id，否则重新打开编辑器 / 重新启用模组时，
 * 被删掉的默认包、模组卡又会被补回工程。
 */
const REMOVED_KEYS = {
  unit: "removedUnitIds",
  skill: "removedSkillIds",
  effect: "removedEffectIds",
};

function removedIdsOf(kind) {
  const key = REMOVED_KEYS[kind];
  if (!key) return [];
  if (!Array.isArray(project[key])) project[key] = [];
  return project[key];
}

function isRemoved(kind, id) {
  return removedIdsOf(kind).includes(id);
}

function markRemoved(kind, id) {
  if (!id) return;
  const list = removedIdsOf(kind);
  if (!list.includes(id)) list.push(id);
}

function unmarkRemoved(kind, id) {
  const key = REMOVED_KEYS[kind];
  if (!key || !id) return;
  project[key] = (project[key] || []).filter((x) => x !== id);
}

/** 批量改写删除标记（改卡 id / 改包 ID 时用） */
function mapRemovedIds(fn) {
  for (const key of Object.values(REMOVED_KEYS)) {
    project[key] = [...new Set((project[key] || []).map(fn))];
  }
}

/** 清空流程里对某张卡的常量引用；返回清掉的处数 */
function clearFlowRefs(flow, id) {
  if (!flow || typeof flow !== "object" || !id) return 0;
  let n = 0;
  for (const node of flow.nodes || []) {
    const bags = [node.options, node.ui && node.ui.const];
    for (const bag of bags) {
      if (!bag || typeof bag !== "object") continue;
      for (const key of CARD_REF_KEYS) {
        if (bag[key] === id) {
          bag[key] = "";
          n += 1;
        }
      }
    }
  }
  return n;
}

/** 清空工程里所有流程对某张卡的引用；返回清掉的处数 */
function clearAllCardRefs(id) {
  let n = 0;
  for (const skill of project.skills || []) n += clearFlowRefs(skill.flow, id);
  for (const effect of project.effects || []) {
    for (const flow of Object.values(effect.flows || {})) n += clearFlowRefs(flow, id);
  }
  return n;
}

function rewriteFlowRefs(flow, oldId, newId) {
  if (!flow || typeof flow !== "object") return;
  for (const node of flow.nodes || []) {
    const bags = [node.options, node.ui && node.ui.const];
    for (const bag of bags) {
      if (!bag || typeof bag !== "object") continue;
      for (const key of CARD_REF_KEYS) {
        if (bag[key] === oldId) bag[key] = newId;
      }
    }
  }
}

/** 改一张卡的 id 时，同步工程里所有对它的引用 */
function rewriteAllRefs(oldId, newId) {
  if (!oldId || oldId === newId) return;
  for (const ch of project.characters || []) {
    ch.skillIds = (ch.skillIds || []).map((x) => (x === oldId ? newId : x));
  }
  mapRemovedIds((x) => (x === oldId ? newId : x));
  for (const skill of project.skills || []) rewriteFlowRefs(skill.flow, oldId, newId);
  for (const effect of project.effects || []) {
    // 效果挂载的技能（效果本身换包 / 换 id 时也要同步）
    effect.skillIds = (effect.skillIds || []).map((x) => (x === oldId ? newId : x));
    for (const trigger of effect.triggers || []) {
      rewriteFlowRefs((effect.flows || {})[trigger.block.id], oldId, newId);
    }
  }
}

/** 把一张卡切到另一个卡包（id 的包前缀一起改，并同步引用） */
function moveCardToPack(card, packId) {
  if (!card || !packId) return false;
  if (card.pack === packId) return true;
  const pack = ensurePack(packId);
  const parsed = parseId(card.id);
  if (parsed.ok) {
    const newId = buildId(pack.id, parsed.kind, parsed.key);
    if (newId !== card.id) {
      if (allCards().some((c) => c !== card && c.id === newId)) {
        setStatus(`切换卡包失败：${newId} 已被占用`, "bad");
        return false;
      }
      const oldId = card.id;
      card.id = newId;
      rewriteAllRefs(oldId, newId);
    }
  } else {
    setStatus("卡 id 不是「包_类型_标识」格式，只切换了所属卡包", "bad");
  }
  card.pack = pack.id;
  card.packName = pack.name;
  return true;
}

/** 切包后让「编辑中卡包」跟着这张卡走；选「全部卡包」时保持全部 */
function followCardPack(card) {
  if (active.editPack !== PACK_ALL && card && card.pack) active.editPack = card.pack;
}

/** 重命名卡包（只改显示名） */
function renamePack(id, name) {
  const meta = packEntry(id);
  const next = String(name || "").trim();
  if (!meta || !next) return false;
  meta.name = next;
  for (const card of allCards()) if (card.pack === id) card.packName = next;
  return true;
}

/**
 * 修改卡包 id：卡包清单、卡上的 pack、卡 id 的包前缀、以及所有引用一起改。
 * @returns {{ok: boolean, error?: string}}
 */
function renamePackId(oldId, rawNewId) {
  const newId = String(rawNewId || "").trim();
  if (!isValidPackId(newId)) {
    return { ok: false, error: "卡包 id 只能包含字母 / 数字 / . / -，且不能是 all" };
  }
  if (newId === oldId) return { ok: true };
  if (packEntry(newId)) return { ok: false, error: `卡包 id 已存在：${newId}` };
  const meta = packEntry(oldId);
  if (!meta) return { ok: false, error: "卡包不存在" };

  const moving = allCards().filter((c) => c.pack === oldId);
  const planned = new Map();
  for (const card of moving) {
    const parsed = parseId(card.id);
    if (parsed.ok) planned.set(card, buildId(newId, parsed.kind, parsed.key));
  }
  const outside = new Set(allCards().filter((c) => c.pack !== oldId).map((c) => c.id));
  for (const id of planned.values()) {
    if (outside.has(id)) return { ok: false, error: `卡 id 冲突：${id}` };
  }
  for (const [card, nextCardId] of planned) {
    const oldCardId = card.id;
    card.id = nextCardId;
    rewriteAllRefs(oldCardId, nextCardId);
  }
  for (const card of moving) {
    card.pack = newId;
    card.packName = meta.name;
  }
  mapRemovedIds((id) => {
    const parsed = parseId(id);
    return parsed.ok && parsed.pack === oldId ? buildId(newId, parsed.kind, parsed.key) : id;
  });
  meta.id = newId;
  if (active.editPack === oldId) active.editPack = newId;
  if (active.packId === oldId) active.packId = newId;
  return { ok: true };
}

/** 新建一个卡包 id（不含下划线：下划线是卡 id 的分隔符） */
function newPackId() {
  let n = 1;
  let id = "pack";
  while (packEntry(id)) {
    n += 1;
    id = `pack${n}`;
  }
  return id;
}

/** 当前标签页对应的卡包（存档 JSON / 复制用） */
function currentPackId() {
  // 在设计角色 / 技能 / 效果时，「编辑中卡包」选了具体包就跟着它
  if (active.tab !== "packs") {
    const editPack = normalizeEditPack();
    if (editPack !== PACK_ALL) return editPack;
  }
  const card = active.tab === "character" ? currentCharacter() : currentCard();
  if (card && card.pack) return card.pack;
  if (active.packId && packEntry(active.packId)) return active.packId;
  const first = packsOfProject().find((p) => p && p.id);
  return first ? first.id : DEFAULT_PACK_ID;
}

/** 卡包里引用了、但不在本卡包内的卡 id（导出时提示用） */
function missingPackRefs(file) {
  const skillIds = new Set((file.skills || []).map((s) => s.id));
  const effectIds = new Set((file.effects || []).map((e) => e.id));
  const unitIds = new Set((file.units || []).map((u) => u.id));
  const missing = new Set();
  const scanFlow = (flow) => {
    for (const node of (flow && flow.nodes) || []) {
      const o = node.options || {};
      if (o.unitId && !unitIds.has(o.unitId)) missing.add(o.unitId);
      if (o.skillId && !skillIds.has(o.skillId)) missing.add(o.skillId);
      if (o.effectId && !effectIds.has(o.effectId)) missing.add(o.effectId);
    }
  };
  for (const unit of file.units || []) {
    for (const sid of unit.skills || []) if (!skillIds.has(sid)) missing.add(sid);
  }
  for (const skill of file.skills || []) scanFlow(skill.flow);
  for (const effect of file.effects || []) {
    for (const sid of effect.skillIds || []) if (!skillIds.has(sid)) missing.add(sid);
    for (const flow of Object.values(effect.flows || {})) scanFlow(flow);
  }
  return [...missing];
}

/** 导出选中的卡包：打成模组 ZIP（卡面一起带上；同时把 JSON 备份到 localStorage） */
async function exportPack(packId) {
  const id = String(packId || "").trim();
  if (!id || !packEntry(id)) {
    setStatus("请先选择一个卡包", "bad");
    return null;
  }
  const file = packFileOf(project, id);
  try {
    localStorage.setItem("caeworld:export:" + id, JSON.stringify(file));
  } catch {
    /* 文件太大就只下载 */
  }

  let zip;
  try {
    setStatus(`正在打包「${packNameById(id)}」…`, "ok");
    zip = await makePackZip(file, {
      packId: id,
      resolveImage: (card) => resolveCardImage(card),
    });
  } catch (err) {
    setStatus(`打包失败：${String((err && err.message) || err)}`, "bad");
    return file;
  }

  const ok = downloadBlob(
    `${id}.zip`,
    new Blob([zip.bytes], { type: "application/zip" }),
    JSON.stringify(file, null, 2)
  );
  const missing = missingPackRefs(file);
  const extra = missing.length
    ? `；有 ${missing.length} 个引用不在本卡包（${missing.slice(0, 3).join("、")}${missing.length > 3 ? "…" : ""}）`
    : "";
  const art = `卡面 ${zip.images.length} 张 · 图标 ${(zip.icons || []).length} 个`;
  const warn = zip.warnings && zip.warnings.length ? `·${zip.warnings.length} 个图片 / 图标没打进去` : "";
  setStatus(
    ok
      ? `已导出「${packNameById(id)}」→ ${id}.zip（${art}${warn}）${extra}；若浏览器没弹出下载，可点底部「复制卡包」`
      : `下载失败，已把「${packNameById(id)}」的 JSON 复制到剪贴板${extra}`,
    ok ? "ok" : "bad"
  );
  return file;
}

/** 导出弹窗：先选一个卡包 */
function openExportModal() {
  const modal = $("#ed-export-modal");
  const sel = $("#ed-export-pack");
  if (!modal || !sel) return;
  const packs = packsOfProject().filter((p) => p && p.id);
  if (!packs.length) {
    setStatus("还没有卡包", "bad");
    return;
  }
  const current = currentPackId();
  sel.innerHTML = packOptionsHtml(current);
  sel.value = current;
  modal.hidden = false;
  sel.focus?.();
}

function closeExportModal() {
  const modal = $("#ed-export-modal");
  if (modal) modal.hidden = true;
}

function cardOptionsHtml(all, filtered) {
  if (!filtered.length) return `<option value="">（无）</option>`;
  return filtered
    .map((card) => {
      const i = all.indexOf(card);
      return `<option value="${i}">${escapeHtml(card.name || card.id)} · ${escapeHtml(card.id)} · ${escapeHtml(
        packNameOf(card)
      )}</option>`;
    })
    .join("");
}

function renderCardsList() {
  const chars = project.characters || [];
  const skills = project.skills || [];
  const effects = project.effects || [];

  // 三边共用的编辑中卡包：刷新下拉选项（包可能刚改名 / 新建）
  active.editPack = fillPackSelect($("#ed-edit-pack"), active.editPack);
  normalizeEditPack();
  const ch = currentCharacter();

  // 没有选中卡时禁用删除，避免按钮点了没反应
  const setDeleteState = (sel, enabled) => {
    const btn = $(sel);
    if (btn) btn.disabled = !enabled;
  };
  setDeleteState("#btn-delete-character", Boolean(ch));
  setDeleteState("#btn-delete-skill", Boolean(currentSkill()));
  setDeleteState("#btn-delete-effect", Boolean(currentEffect()));

  const charList = $("#ed-character-list");
  if (charList) {
    const filtered = chars.filter((c) => packMatch(c, active.editPack));
    charList.innerHTML = filtered.length
      ? filtered
          .map((c) => {
            const i = chars.indexOf(c);
            return `<option value="${i}">${escapeHtml(c.name || c.id)} · ${escapeHtml(c.id)} · ${escapeHtml(
              packNameOf(c)
            )}</option>`;
          })
          .join("")
      : `<option value="">（无角色）</option>`;
    if (filtered.includes(active.character)) charList.value = String(chars.indexOf(active.character));
  }

  const skillList = $("#ed-skill-list");
  if (skillList) {
    const filtered = skills.filter((s) => packMatch(s, active.editPack));
    skillList.innerHTML = cardOptionsHtml(skills, filtered);
    if (filtered.includes(active.skill)) skillList.value = String(skills.indexOf(active.skill));
  }
  const effectList = $("#ed-effect-list");
  if (effectList) {
    const filtered = effects.filter((e) => packMatch(e, active.editPack));
    effectList.innerHTML = cardOptionsHtml(effects, filtered);
    if (filtered.includes(active.effect)) effectList.value = String(effects.indexOf(active.effect));
  }

  // 角色卡预览 & 挂载技能列表（效果只能在战斗中附加，不在这里挂载）
  const preview = $("#ed-card-preview");
  if (preview) {
    preview.innerHTML = ch
      ? `
      <img src="${resolveCardImage(ch)}" alt="${escapeHtml(ch.name || "角色")}" onerror="this.src='${PLACEHOLDER}'" />
      <div class="card-meta">
        <strong>${escapeHtml(ch.name || "未命名角色")}</strong>
        <span>${escapeHtml(ch.id)}</span>
        <span class="quality q-${escapeHtml(ch.quality)}">${({ white: "白", blue: "蓝", gold: "金", rainbow: "彩" })[ch.quality] || ch.quality}</span>
      </div>
      <p class="muted card-source">数据来源：${escapeHtml(packNameOf(ch))}</p>`
      : `<p class="hint">还没有角色。点「新建角色」开始。</p>`;
  }
  const skillsBox = $("#ed-mount-skills");
  if (skillsBox) {
    skillsBox.innerHTML = ch
      ? mountPanelShell("character")
      : `<p class="hint">先选择一个角色。</p>`;
    if (ch) applyMountSearch(skillsBox, mountUi.character.query);
  }
}

/* ---------------------------- 角色表单 ---------------------------- */
function renderCharacter() {
  const ch = currentCharacter();
  if (!ch) {
    const stats = $("#ed-unit-stats");
    if (stats) stats.textContent = "还没有角色，点「新建角色」开始。";
    return;
  }
  const map = {
    "f-name": ch.name,
    "f-id": ch.id,
    "f-quality": ch.quality,
    "f-level": ch.level,
    "f-hp": ch.baseHp,
    "f-atk": ch.baseAtk,
    "f-def": ch.baseDef,
    "f-crit": ch.critRate,
    "f-critdmg": ch.critDamage,
    "f-speed": ch.speed,
    "f-actions": ch.actionsPerTurn ?? 1,
    "f-label": ch.label,
    "f-intro": ch.description,
  };
  for (const [id, value] of Object.entries(map)) {
    const el = $("#" + id);
    if (el && document.activeElement !== el) el.value = value === undefined || value === null ? "" : value;
  }
  // 路径框默认填「卡牌短 id.png」；null = 用户明确选择了占位图
  const imageInput = $("#f-image");
  if (imageInput && document.activeElement !== imageInput) imageInput.value = cardImagePath(ch);
  for (const attr of RESISTANCE_ATTRIBUTES) {
    const el = $(`#f-res-${attr}`);
    if (el && document.activeElement !== el) el.value = ch.resistances[attr];
  }
  const SWITCH_IDS = {
    occupiesSlot: "f-occupy",
    countsAsUnit: "f-count",
    invincible: "f-invincible",
    obtainable: "f-obtainable",
  };
  for (const [key, id] of Object.entries(SWITCH_IDS)) {
    const el = $("#" + id);
    // 旧工程没有 obtainable：没填过就按默认勾选
    const value = key === "obtainable" && ch.obtainable === undefined ? true : Boolean(ch[key]);
    if (el) el.checked = value;
  }
  const packSel = $("#f-pack");
  if (packSel && document.activeElement !== packSel) packSel.innerHTML = packOptionsHtml(ch.pack);
  const unit = characterToUnit(ch);
  const stats = $("#ed-unit-stats");
  if (stats) {
    stats.textContent = `Lv.${unit.level} · HP ${unit.baseHp} · ATK ${unit.baseAtk} · DEF ${unit.baseDef} · 行动顺序 ${unit.speed} · 每回合 ${unit.actionsPerTurn} 次 · 暴击 ${(
      unit.critRate * 100
    ).toFixed(0)}% / ${(unit.critDamage * 100).toFixed(0)}%`;
  }
  const img = $("#ed-card-image");
  if (img) img.src = resolveCardImage(ch);
}

/* ---------------------------- 技能 / 效果 ---------------------------- */
function renderSkillPanel() {
  const s = currentSkill();
  const box = $("#ed-skill-form");
  if (!box) return;
  if (!s) {
    box.innerHTML = `<p class="hint">还没有技能。点「新建技能」开始。</p>`;
    return;
  }
  const mounted = (project.characters || []).some((ch) => (ch.skillIds || []).includes(s.id));
  const mountedOnEffect = (project.effects || []).some((e) => (e.skillIds || []).includes(s.id));
  box.innerHTML = `
    ${
      mounted || mountedOnEffect
        ? ""
        : `<p class="hint">⚠ 这个技能没有挂载到任何角色或效果，战斗中不会生效；请到「设计角色」中间「挂载技能」或「设计效果」的「挂载技能」里勾选。</p>`
    }
    ${field("技能名", `<input data-skill="name" value="${escapeHtml(s.name)}" />`)}
    ${field("技能 id", `<input data-skill="id" value="${escapeHtml(s.id)}" />`, "扩展包_类型_标识，类型必须是 skill")}
    ${field("所属卡包", packSelectHtml('data-skill-pack="1"', s.pack), "切包会同时改卡 id 的包前缀并同步引用")}
    ${field("类型", select("data-skill=\"type\"", [
      ["active", "主动"],
      ["passive", "被动"],
    ], s.type))}
    ${field(
      "每回合可用次数",
      `<input data-skill="usesPerTurn" type="number" min="0" step="1" value="${Number(s.usesPerTurn) || 0}" />`,
      "0 = 不限；每个单位独立计数，回合开始时刷新"
    )}
    ${field(
      "总可用次数",
      `<input data-skill="usesTotal" type="number" min="0" step="1" value="${Number(s.usesTotal) || 0}" />`,
      "0 = 不限；整场对局每个单位独立计数，新上场的同名单位重新计数"
    )}
    ${field(
      "技能图标",
      `<input data-skill="image" value="${escapeHtml(cardIconPath(s))}" placeholder="${escapeHtml(
        defaultCardImageName(s)
      )}" />`,
      "留空时取所属模组 icons/skill/<短 id>.*；也可填完整路径 / URL"
    )}
    <div class="form-row icon-edit-row">
      <label class="btn small">选择图标<input type="file" data-icon-file="skill" accept="image/*" hidden /></label>
      <button class="btn small" type="button" data-action="icon-placeholder" data-icon-kind="skill">用占位图</button>
      <img class="ed-form-icon" data-icon-preview="skill" src="${resolveCardImage(s)}" alt="" onerror="this.src='${PLACEHOLDER}'" />
    </div>
    ${field("说明", `<textarea data-skill="description" rows="2">${escapeHtml(s.description || "")}</textarea>`)}
    <div class="trigger-head">
      <span>触发</span>
      <button class="btn small" type="button" data-action="add-skill-trigger">+ 新触发</button>
    </div>
    <p class="hint">每个触发选自己的条件，后续积木接在对应触发后面；同一技能可以放多个触发。新触发默认「单位释放该技能」，退场 / 入场等事件触发对主动和被动技能都会生效。</p><p class="hint">释放条件：把一个条件积木接到「单位释放该技能」触发积木的「条件」输入上；条件不满足时技能不可选中。不接条件 = 始终可释放。</p><p class="hint">退场分裂：触发条件选「单位退场时」，后接「召唤单位」或「召唤子单位」；单位 id 留空 = 召唤自己。</p>`;
}

function renderEffectPanel() {
  const e = currentEffect();
  const box = $("#ed-effect-form");
  if (!box) return;
  if (!e) {
    box.innerHTML = `<p class="hint">还没有效果。点「新建效果」开始。</p>`;
    return;
  }
  // 旧工程 / 旧内容包兼容：没有倾向时从旧的 negative 标记迁移，迁移后不再保留 negative 标记
  e.flags = Array.isArray(e.flags) ? e.flags : [];
  const inferredPolarity = effectPolarityOf(e);
  if (e.flags.includes("negative")) e.flags = e.flags.filter((f) => f !== "negative");
  e.polarity = inferredPolarity;
  if (typeof e.stackable !== "boolean") e.stackable = false;
  const maxStacks = Number(e.maxStacks);
  e.maxStacks = Number.isFinite(maxStacks) ? Math.max(0, Math.floor(maxStacks)) : 1;
  e.bar = Boolean(e.bar);
  e.barInvert = Boolean(e.barInvert) && e.bar;
  e.attrBonus = Array.isArray(e.attrBonus) ? e.attrBonus : [];
  e.skillIds = Array.isArray(e.skillIds) ? [...new Set(e.skillIds.filter((x) => typeof x === "string" && x))] : [];
  e.triggers = e.triggers || [];
  if (!e.triggers.some((t) => t.block.id === active.triggerId)) {
    active.triggerId = e.triggers[0] ? e.triggers[0].block.id : null;
  }
  box.innerHTML = `
    ${field("效果名", `<input data-effect="name" value="${escapeHtml(e.name)}" />`)}
    ${field("效果 id", `<input data-effect="id" value="${escapeHtml(e.id)}" />`, "扩展包_类型_标识，类型必须是 effect")}
    ${field("所属卡包", packSelectHtml('data-effect-pack="1"', e.pack), "切包会同时改卡 id 的包前缀并同步引用")}
    ${field(
      "倾向",
      select('data-effect="polarity"', [
        ["positive", "正面"],
        ["negative", "负面"],
        ["special", "特殊"],
      ], e.polarity),
      "必选：正面 / 负面 / 特殊（特殊不会被按正面或负面移除）"
    )}
    <div class="chips">
      <label><input type="checkbox" data-effect-flag="unremovable" ${(e.flags || []).includes("unremovable") ? "checked" : ""} /> 不可解除（需勾选「强制移除」）</label>
      <label><input type="checkbox" data-effect-auto="1" ${e.autoConsume ? "checked" : ""} /> 自动消耗（每次执行完该效果的流程后消耗 1 层）</label>
    </div>
    ${
      e.autoConsume
        ? `<p class="hint">每次该效果的触发流程执行完后消耗 1 层（触发条件未通过时不消耗）；只剩 1 层或未开启「层数计数」时直接移除整个效果。自动消耗无视「不可解除」。</p>`
        : ""
    }
    <div class="form-row">
      <label class="form-check"><input type="checkbox" data-effect-stack="1" ${e.stackable ? "checked" : ""} /> 层数计数</label>
    </div>
    ${
      e.stackable
        ? field(
            "层数上限",
            `<input type="number" min="0" step="1" data-effect-number="maxStacks" value="${e.maxStacks}" />`,
            "默认 1；0 表示无上限"
          )
        : ""
    }
    ${field(
      "效果图标",
      `<input data-effect="image" value="${escapeHtml(cardIconPath(e))}" placeholder="${escapeHtml(
        defaultCardImageName(e)
      )}" />`,
      "留空时取所属模组 icons/effect/<短 id>.*；也可填完整路径 / URL"
    )}
    <div class="form-row icon-edit-row">
      <label class="btn small">选择图标<input type="file" data-icon-file="effect" accept="image/*" hidden /></label>
      <button class="btn small" type="button" data-action="icon-placeholder" data-icon-kind="effect">用占位图</button>
      <img class="ed-form-icon" data-icon-preview="effect" src="${resolveCardImage(e)}" alt="" onerror="this.src='${PLACEHOLDER}'" />
    </div>
    ${field(
      "颜色",
      `<span class="effect-color-row">
        <input type="color" class="effect-color-picker" data-effect-color-picker="1" value="${effectColorOf(
          e
        )}" title="点击调整 HEX 颜色" />
        <input class="effect-color-text" data-effect="color" value="${escapeHtml(
          e.color || ""
        )}" placeholder="自动 ${effectColorOf(e)} / #RRGGBB / rgb(...)" />
        <button class="btn tiny" type="button" data-action="effect-color-reset">自动</button>
      </span>`,
      "留空时按效果倾向自动取色；点击色块调整 HEX，也可直接输入 rgb 色码"
    )}
    <div class="chips">
      <label><input type="checkbox" data-effect-bar="1" ${e.bar ? "checked" : ""} /> 条式显示（血条上方的进度条）</label>
      ${
        e.bar
          ? `<label><input type="checkbox" data-effect-bar-invert="1" ${
              e.barInvert ? "checked" : ""
            } /> 反转条（显示 (上限-当前)/上限）</label>`
          : ""
      }
    </div>
    ${
      e.bar
        ? `<p class="hint">条式显示的效果会从角色左上方图标移到血条上方，必须开启层数计数并设置大于 0 的上限。${
            !e.stackable || !(Number(e.maxStacks) > 0) ? "当前还没有有效上限。" : ""
          }</p>`
        : ""
    }
    ${field("说明", `<textarea data-effect="description" rows="2">${escapeHtml(e.description || "")}</textarea>`)}
    <div class="trigger-head">
      <span>挂载技能</span>
      <span class="muted">持有该效果时临时获得</span>
    </div>
    <p class="hint">持有该效果的单位会临时获得这里勾选的技能；效果被移除、掉层或自动消耗后立刻失去。按卡包分栏，当前编辑卡包排在最前。</p>
    <div id="ed-effect-mount" class="effect-mount-box">${mountPanelShell("effect")}</div>
    <div class="trigger-head">
      <span>属性修正</span>
      <button class="btn small" data-action="add-attrbonus">+ 添加属性修正</button>
    </div>
    <div class="attrbonus-list">
      ${(e.attrBonus || []).map((op, i) => {
        const key = String(op.attr || "");
        const value = Number(op.value) || 0;
        return `<div class="attrbonus-row">
          ${select(
            `data-attrbonus-attr="${i}"`,
            EFFECT_ATTR_BONUS_KEYS.map((k) => [k, ATTR_BONUS_LABEL[k] || k]),
            key
          )}
          <input type="number" step="0.01" data-attrbonus-value="${i}" value="${value}" />
          <button class="btn tiny danger" type="button" data-action="delete-attrbonus" data-index="${i}" title="删除这条属性修正">×</button>
        </div>`;
      }).join("") || `<p class="hint">没有属性修正。效果可以只做触发流程，也可以给持有者提供攻击力 / 防御力等面板加成（百分比存小数，5% = 0.05）。</p>`}
    </div>
    <div class="trigger-head">
      <span>触发流程</span>
      <button class="btn small" data-action="add-trigger">+ 新触发</button>
    </div>
    <div class="trigger-list">
      ${e.triggers.map((t) => {
        const info = TRIGGER_LABEL[t.block.event] || t.block.event;
        return `<button class="trigger-chip ${t.block.id === active.triggerId ? "is-active" : ""}" data-trigger="${escapeHtml(t.block.id)}">
          <span>${escapeHtml(info)}</span><em>${escapeHtml(t.block.id)}</em></button>`;
      }).join("") || `<p class="hint">还没有触发。效果只有存在时才会触发，先加一个触发。</p>`}
    </div>
    ${active.triggerId ? `<button class="btn small danger" data-action="delete-trigger">删除当前触发</button>` : ""}`;
  // 重建表单后把搜索词重新应用一次，否则输入框里还留着关键词、列表却全部展开
  applyMountSearch($("#ed-effect-mount"), mountUi.effect.query);
}

/* ---------------------------- 卡包面板 ---------------------------- */
function renderPackPanel() {
  const list = $("#ed-pack-list");
  const form = $("#ed-pack-form");
  const cardsBox = $("#ed-pack-cards");
  if (!list || !form) return;
  const packs = packsOfProject().filter((p) => p && p.id);
  if (!active.packId || !packEntry(active.packId)) {
    active.packId = packs[0] ? packs[0].id : DEFAULT_PACK_ID;
  }
  const meta = packEntry(active.packId) || ensurePack(active.packId);
  list.innerHTML = packs
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === meta.id ? "selected" : ""}>${escapeHtml(
          p.name || p.id
        )}（${escapeHtml(p.id)}）</option>`
    )
    .join("");
  list.value = meta.id;

  const groups = [
    { kind: "unit", label: "角色", cards: (project.characters || []).filter((c) => c && c.pack === meta.id) },
    { kind: "skill", label: "技能", cards: (project.skills || []).filter((s) => s && s.pack === meta.id) },
    { kind: "effect", label: "效果", cards: (project.effects || []).filter((e) => e && e.pack === meta.id) },
  ];

  form.innerHTML = `
    ${field("卡包名", `<input data-pack="name" value="${escapeHtml(meta.name || meta.id)}" />`)}
    ${field(
      "包 ID",
      `<input data-pack-id-input value="${escapeHtml(meta.id)}" />`,
      "改 ID 会同时改本包所有卡 id 的包前缀并同步引用；只能字母 / 数字 / . / -"
    )}
    <div class="form-actions">
      <button class="btn small" type="button" data-action="apply-pack-id">应用包 ID</button>
      <button class="btn small" type="button" data-action="export-pack">导出此卡包</button>
    </div>
    ${field("版本", `<input type="number" min="1" step="1" data-pack="version" value="${Number(meta.version) || 1}" />`)}
    ${field("作者", `<input data-pack="author" value="${escapeHtml(meta.author || "")}" />`)}
    ${field("说明", `<textarea data-pack="description" rows="3">${escapeHtml(meta.description || "")}</textarea>`)}
    <p class="muted">共 ${groups.reduce((n, g) => n + g.cards.length, 0)} 张卡；导出时会检查引用了、但不在本卡包里的角色 / 技能 / 效果。</p>`;

  if (cardsBox) {
    cardsBox.innerHTML = groups
      .map(
        (g) => `<div class="pack-card-group">
          <h3>${g.label}（${g.cards.length}）</h3>
          ${
            g.cards
              .map(
                (c) =>
                  `<button class="pack-card-item" type="button" data-pack-card="${g.kind}:${escapeHtml(c.id)}">
                    <span>${escapeHtml(c.name || c.id)}</span><code>${escapeHtml(c.id)}</code>
                  </button>`
              )
              .join("") || `<p class="hint">空</p>`
          }
        </div>`
      )
      .join("");
  }
}

const TRIGGER_LABEL = {
  turnStart: "回合开始时",
  turnEnd: "回合结束时",
  unitTurnStart: "单位行动开始时",
  unitTurnEnd: "单位行动结束时",
  skillCast: "单位释放技能",
  skillCastSelf: "单位释放该技能",
  attack: "单位攻击时",
  allyAttack: "我方单位攻击时",
  attacked: "单位受击时",
  lethalDamage: "单位受致命伤害时",
  unitEnter: "单位入场时",
  unitExit: "单位退场时",
  heal: "单位回复生命时",
  loseHp: "单位损失生命时",
  always: "始终",
};

/** 技能新触发的默认事件：单位释放此技能 */
const SKILL_DEFAULT_TRIGGER = "skillCastSelf";
/** 效果新触发的默认事件：单位行动结束时 */
const EFFECT_DEFAULT_TRIGGER = "unitTurnEnd";

/** 效果「属性修正」下拉的显示名 */
const ATTR_BONUS_LABEL = {
  atkPct: "攻击力提升 %",
  atkFlat: "攻击力提升值",
  defPct: "防御力提升 %",
  defFlat: "防御力提升值",
  hpPct: "生命值提升 %",
  hpFlat: "生命值提升值",
  critRate: "暴击率",
  critDamage: "暴击伤害",
  speed: "速度（行动顺序）",
  speedPct: "速度加成 %",
  dmgBoostPct: "伤害提升 %",
  damageTakenPct: "受到伤害提升 %",
  vulnPct: "易伤 %",
  resistDownPct: "抗性降低 %",
  physical: "物理抗性",
  magic: "魔法抗性",
  spirit: "精神抗性",
  "attrDmgBoostPct.physical": "物理伤害提升 %",
  "attrDmgBoostPct.magic": "魔法伤害提升 %",
  "attrDmgBoostPct.spirit": "精神伤害提升 %",
  "attrPenPct.physical": "物理穿透 %",
  "attrPenPct.magic": "魔法穿透 %",
  "attrPenPct.spirit": "精神穿透 %",
};

function field(label, control, hint) {
  return `<label class="form-field"><span>${escapeHtml(label)}</span>${control}${hint ? `<em>${escapeHtml(hint)}</em>` : ""}</label>`;
}

function select(attrs, options, value) {
  return `<select ${attrs}>${options
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(v) === String(value) ? "selected" : ""}>${escapeHtml(l)}</option>`)
    .join("")}</select>`;
}

/* ================================================================== */
/* 画布                                                                */
/* ================================================================== */
/**
 * 画布缩放：旧版的 66% 渲染比例 = 新版 100% 基准。
 * 界面显示 / 允许输入的倍率是 1% ~ 200%，换算成实际 scale 后再做平移与命中计算。
 */
const ZOOM_BASE = 0.66;
const ZOOM_MIN_PERCENT = 1;
const ZOOM_MAX_PERCENT = 200;
const zoomPercentOf = (zoom) => ((Number(zoom) || ZOOM_BASE) / ZOOM_BASE) * 100;
const zoomOfPercent = (percent) => (Number(percent) / 100) * ZOOM_BASE;
const clampZoomPercent = (percent) => Math.min(ZOOM_MAX_PERCENT, Math.max(ZOOM_MIN_PERCENT, Number(percent) || 0));

const canvasState = {
  view: { x: 40, y: 40, zoom: ZOOM_BASE },
  /** 画布交互模式：pan = 拖拽画布，cut = 切割连线（由工具条滑钮切换） */
  mode: "pan",
  drag: null,
  pan: null,
  link: null,
  selectedId: null,
  /** 切割状态：{ pointerId, lastX, lastY }；非空即表示正在切割连线 */
  erase: null,
  nodeEls: new Map(),
  /** 连线 id → 世界坐标采样点，擦除命中判定用 */
  linkSamples: new Map(),
};

/** 切割笔刷半径（屏幕像素），随画布缩放换算到世界坐标 */
const ERASE_RADIUS = 16;

/** 「模板」按钮插入的流程：默认包 · 史莱姆 · 撞击 */
const FLOW_TEMPLATE_SLIME_BEAT = {
  name: "撞击",
  nodes: [
    { id: "targetSide1", type: "targetSide", options: { side: "enemy" }, pos: { x: 0, y: 190 } },
    { id: "chooseUnit1", type: "chooseUnit", options: { multiple: false }, pos: { x: 230, y: 195 } },
    { id: "trg1", type: "trigger", options: { event: "skillCastSelf", unitScope: "self" }, pos: { x: 165, y: 0 } },
    {
      id: "atk1",
      type: "attack",
      options: { attribute: "physical", ignoreReduction: false, additional: false },
      pos: { x: 520, y: 75 },
    },
    { id: "selfData1", type: "selfData", options: { field: "atk" }, pos: { x: 270, y: 355 } },
  ],
  links: [
    { from: "targetSide1", port: "set", to: "chooseUnit1", portTo: "targets" },
    { from: "trg1", port: "next", to: "atk1", portTo: "in" },
    { from: "chooseUnit1", port: "set", to: "atk1", portTo: "targets" },
    { from: "selfData1", port: "value", to: "atk1", portTo: "value" },
  ],
};

const canvasEl = () => $("#blocks-canvas");
const worldEl = () => $("#blocks-world");

function showEraseCursor(clientX, clientY) {
  const cursor = $("#erase-cursor");
  const canvas = canvasEl();
  if (!cursor || !canvas) return;
  const box = canvas.getBoundingClientRect();
  cursor.style.left = `${clientX - box.left}px`;
  cursor.style.top = `${clientY - box.top}px`;
  cursor.style.display = "block";
}

function hideEraseCursor() {
  const cursor = $("#erase-cursor");
  if (cursor) cursor.style.display = "none";
}

function setEraseHint(show) {
  const hint = $("#erase-hint");
  if (hint) hint.hidden = !show;
}

function endEraseMode() {
  canvasState.erase = null;
  canvasEl()?.classList.remove("is-erasing");
  hideEraseCursor();
  setEraseHint(false);
}

/** 切换画布交互模式：pan = 拖拽画布，cut = 切割连线 */
function setCanvasMode(mode) {
  canvasState.mode = mode === "cut" ? "cut" : "pan";
  const cut = canvasState.mode === "cut";
  canvasEl()?.classList.toggle("is-cut-mode", cut);
  const input = $("#canvas-mode");
  if (input) {
    input.checked = cut;
    input.closest(".canvas-mode")?.classList.toggle("is-cut", cut);
  }
  if (!cut) endEraseMode();
}

/** 进入切割状态：之后拖动只擦线、不平移画布 */
function beginCutting(e) {
  canvasState.pan = null;
  canvasState.erase = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
  canvasEl()?.classList.add("is-erasing");
  showEraseCursor(e.clientX, e.clientY);
  setEraseHint(true);
  if (typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(10);
    } catch {
      /* 部分浏览器 / 省电模式不支持振动，忽略 */
    }
  }
}

/**
 * 按下画布（空白或连线）：按当前滑钮模式决定手势。
 * · 拖拽模式：拖动平移画布；
 * · 切割模式：拖动擦掉扫过的连线。
 * @param {PointerEvent} e
 */
function beginCanvasGesture(e) {
  // 阻止长按触发系统菜单 / 文本选择；画布上的点按语义由 pointerup 自己处理
  if (e.cancelable) e.preventDefault();
  canvasEl().setPointerCapture(e.pointerId);
  if (canvasState.mode === "cut") {
    beginCutting(e);
    return;
  }
  canvasState.pan = {
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    vx: canvasState.view.x,
    vy: canvasState.view.y,
    moved: false,
  };
}

function toWorld(clientX, clientY) {
  const box = canvasEl().getBoundingClientRect();
  return {
    x: (clientX - box.left - canvasState.view.x) / canvasState.view.zoom,
    y: (clientY - box.top - canvasState.view.y) / canvasState.view.zoom,
  };
}

function syncWorld() {
  const world = worldEl();
  if (!world) return;
  world.style.transform = `translate(${canvasState.view.x}px, ${canvasState.view.y}px) scale(${canvasState.view.zoom})`;
  const label = $("#zoom-label");
  if (label) label.value = String(Math.round(zoomPercentOf(canvasState.view.zoom)));
}

function blockDef(type) {
  return catalog.blocks[type];
}

function renderFlow() {
  const title = $("#flow-title");
  if (title) {
    const card = currentCard();
    title.textContent =
      active.tab === "effects"
        ? `效果流程 · ${flowTriggerLabel()}`
        : card
          ? `技能流程 · ${card.name || card.id}`
          : "流程";
  }
  const world = worldEl();
  if (!world) return;
  const flow = currentFlow();
  const templateBtn = $("#btn-template");
  if (templateBtn) {
    templateBtn.hidden = active.tab !== "skills";
    templateBtn.disabled = !flow;
  }
  canvasState.nodeEls.clear();
  canvasState.linkSamples.clear();
  world.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "links");
  svg.setAttribute("width", "6000");
  svg.setAttribute("height", "6000");
  world.appendChild(svg);

  const empty = $("#flow-empty");
  if (empty) {
    if (!flow) {
      empty.hidden = false;
      empty.textContent =
        active.tab === "effects"
          ? "先在左边选一个效果，并添加一个「触发流程」，再往画布拖积木。"
          : "先在左边新建/选择一个技能，再从积木盒拖积木进来。";
    } else if (!flow.nodes.length) {
      empty.hidden = false;
      empty.textContent = "把左边积木盒里的积木拖进来，或点一下积木名直接放到画布中央。";
    } else {
      empty.hidden = true;
    }
  }
  if (!flow) {
    syncWorld();
    return;
  }

  for (const node of flow.nodes) world.appendChild(renderBlock(node, flow));
  for (const link of flow.links || []) {
    const path = makeLinkPath(link);
    if (path) svg.appendChild(path);
  }
  syncWorld();
  validateFlow();
  renderJson();
}

/**
 * 积木的输入端口。有些端口单靠 catalog.ports 画不出来：
 *  · 运算积木的输入口是动态的（a/b 或 in1、in2…），按当前选项与已连接数补出来；
 *  · 「声明变量」的「值」端口类型随 type 选项变（数字 / 字符串 / 布尔→条件）。
 */
function dataInputPorts(node, flow) {
  const def = blockDef(node.type);
  if (!def) return [];
  const base = def.ports.filter((p) => p.direction === "in");
  // 「声明变量」的「值」端口类型随 type 选项变（数字 / 字符串 / 布尔→条件）
  if (node.type === "declareVariable") {
    const type = variablePortType(node.options && node.options.type);
    const label = { number: "值（数字）", string: "值（字符串）", condition: "值（布尔）" }[type] || "值";
    return base.map((p) => (p.id === "value" ? { ...p, type, label } : p));
  }
  if (node.type !== "math") return base;
  const connected = (flow.links || []).filter((l) => l.to === node.id).length;
  return inputPortIds(def, node.options || {}, connected).map((id, i) => ({
    id,
    label: id === "a" ? "a" : id === "b" ? "b" : `值 ${i + 1}`,
    direction: "in",
    type: "number",
  }));
}

/** 切换「声明变量」的类型后，清掉和新的值类型不再匹配的连线 */
function pruneVariableValue(flow, node) {
  const type = variablePortType(node.options && node.options.type);
  flow.links = (flow.links || []).filter((l) => {
    if (l.to !== node.id || l.portTo !== "value") return true;
    const fromNode = flow.nodes.find((n) => n.id === l.from);
    const def = fromNode && blockDef(fromNode.type);
    const out = def && def.ports.find((p) => p.id === l.port && p.direction === "out");
    const t = out && out.type;
    return !t || t === type || t === "any";
  });
}

/** 切换运算类型后，清掉不再存在的输入口连线（例如 add 的 b → round 只有一个 a） */
function pruneMathInputs(flow, node) {
  const def = blockDef("math");
  const op = node.options && node.options.operator;
  const unlimited = op === "max" || op === "min";
  const allowed = unlimited ? null : new Set(inputPortIds(def, node.options || {}, 0));
  flow.links = (flow.links || []).filter((l) => {
    if (l.to !== node.id) return true;
    if (unlimited) return /^in\d+$/.test(l.portTo);
    return allowed.has(l.portTo);
  });
}

function renderBlock(node, flow) {
  const def = blockDef(node.type);
  if (!node.pos || !Number.isFinite(node.pos.x) || !Number.isFinite(node.pos.y)) node.pos = { x: 60, y: 60 };
  const el = document.createElement("div");
  el.className = "block";
  el.dataset.id = node.id;
  el.dataset.group = def.group;
  el.style.left = `${node.pos.x}px`;
  el.style.top = `${node.pos.y}px`;
  el.style.setProperty("--block-color", def.color);
  if (canvasState.selectedId === node.id) el.classList.add("is-selected");

  const inPorts = dataInputPorts(node, flow);
  const outPorts = def.ports.filter((p) => p.direction === "out");
  const flowIn = inPorts.find((p) => !p.type);
  const flowOuts = outPorts.filter((p) => !p.type);
  const leftIn = inPorts.filter((p) => p.type);
  const rightOut = outPorts.filter((p) => p.type);

  const topHtml = `<div class="block-top">
      <div class="block-flow-in">${flowIn ? portHtml(flowIn, "in") : ""}</div>
      <div class="block-flow-out">${flowOuts.map((p) => portHtml(p, "out", p.label)).join("")}</div>
    </div>`;

  const rows = Math.max(leftIn.length, rightOut.length);
  const sidesHtml =
    rows === 0
      ? ""
      : `<div class="block-sides">${Array.from({ length: rows })
          .map((_, i) => {
            const li = leftIn[i];
            const ro = rightOut[i];
            const text = li ? li.label : ro ? ro.label : "";
            return `<div class="side-row">
              <span class="block-side-l">${li ? portHtml(li, "in") + `<span>${escapeHtml(li.label)}</span>` : ""}</span>
              ${text && li && ro ? `<span class="side-empty">/</span>` : ""}
              <span class="block-side-r">${ro ? `<span>${escapeHtml(ro.label || "")}</span>` + portHtml(ro, "out") : ""}</span>
            </div>`;
          })
          .join("")}</div>`;

  el.innerHTML = `${topHtml}
    <div class="block-head"><strong>${escapeHtml(def.title)}</strong><span>${escapeHtml(node.id)}</span></div>
    ${def.subtitle ? `<div class="block-sub">${escapeHtml(def.subtitle)}</div>` : ""}
    <div class="block-options">${optionsHtml(node)}</div>
    ${sidesHtml}`;
  canvasState.nodeEls.set(node.id, el);
  return el;
}

function portHtml(port, dir, label) {
  const type = port.type ? ` data-type="${port.type}"` : "";
  return `<span class="port port-${dir}" data-port="${escapeHtml(port.id)}" data-dir="${dir}"${type}${
    label ? ` data-label="${escapeHtml(label)}"` : ""
  } title="${escapeHtml(label || DATA_TYPE_LABEL[port.type] || port.id)}"></span>`;
}

function optionsHtml(node) {
  const def = blockDef(node.type);
  const opts = node.options || {};
  let html = "";
  for (const o of def.options || []) {
    if (o.showIf && !Object.entries(o.showIf).every(([k, v]) => String(opts[k]) === String(v))) continue;
    if (o.control === "select") {
      html += `<label class="opt"><span>${escapeHtml(o.label || o.key)}</span><select data-option="${o.key}">${(o.options || [])
        .map((x) => `<option value="${escapeHtml(x.value)}" ${String(x.value) === String(opts[o.key]) ? "selected" : ""}>${escapeHtml(x.label)}</option>`)
        .join("")}</select></label>`;
    } else if (o.control === "checkbox") {
      html += `<label class="opt opt-check"><input type="checkbox" data-option="${o.key}" ${opts[o.key] ? "checked" : ""}/><span>${escapeHtml(o.label || o.key)}</span></label>`;
    } else if (o.control === "number") {
      html += `<label class="opt"><span>${escapeHtml(o.label || o.key)}</span><input type="number" data-option="${o.key}" value="${escapeHtml(opts[o.key] ?? "")}"/></label>`;
    } else if (o.control === "text") {
      html += `<label class="opt"><span>${escapeHtml(o.label || o.key)}</span><input type="text" data-option="${o.key}" value="${escapeHtml(
        opts[o.key] ?? ""
      )}" placeholder="键入字符串"/></label>`;
    }
  }
  const constKeys = {
    summon: ["unitId"],
    summonChild: ["unitId"],
    giveSkill: ["skillId"],
    attachEffect: ["effectId", "value"],
    removeEffect: ["effectId"],
  }[node.type] || [];
  const numberConsts = new Set(["value"]);
  for (const key of constKeys) {
    const label = { unitId: "单位 id", skillId: "技能 id", effectId: "效果 id", value: "层数" }[key];
    const placeholder =
      key === "unitId" ? "留空 = 召唤自己" : key === "value" ? "留空 = 1 层" : "扩展包_类型_标识";
    const type = numberConsts.has(key) ? "number" : "text";
    const extra = key === "value" ? ' min="0" step="1"' : "";
    html += `<label class="opt"><span>${label}</span><input type="${type}"${extra} data-constant="${key}" value="${escapeHtml(
      opts[key] ?? ""
    )}" placeholder="${escapeHtml(placeholder)}"/></label>`;
  }
  return html;
}

/**
 * 端口中心点，返回「world 本地坐标」（SVG path 使用的坐标系）。
 *
 * 注意：getBoundingClientRect() 拿到的是**经过 scale 缩放后的屏幕像素**，
 * 而 svg.links 是 #blocks-world 的子元素、会跟着一起缩放，path 的 d 必须是
 * 未缩放的本地坐标。所以两矩形相减后要再除以 zoom，否则缩放后线条整体错位
 * （zoom=1 时恰好相等，只在缩放后暴露）。
 */
function portCenter(el) {
  const world = worldEl().getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const zoom = canvasState.view.zoom || 1;
  return {
    x: (r.left + r.width / 2 - world.left) / zoom,
    y: (r.top + r.height / 2 - world.top) / zoom,
  };
}

/**
 * 三次贝塞尔采样（世界坐标），擦除命中判定用。
 * 每约 10 屏幕像素取一个点，保证笔刷扫过曲线时不会从采样点之间漏过去。
 */
function sampleCubic(p0, p1, p2, p3) {
  const rough =
    Math.hypot(p1.x - p0.x, p1.y - p0.y) +
    Math.hypot(p2.x - p1.x, p2.y - p1.y) +
    Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const step = Math.max(4, 10 / (canvasState.view.zoom || 1));
  const steps = Math.min(480, Math.max(12, Math.ceil(rough / step)));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    points.push({
      x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
      y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
    });
  }
  return points;
}

function makeLinkPath(link) {
  const fromEl = canvasState.nodeEls.get(link.from);
  const toEl = canvasState.nodeEls.get(link.to);
  if (!fromEl || !toEl) return null;
  const fromPort = fromEl.querySelector(`.port[data-port="${cssEsc(link.port)}"][data-dir="out"]`);
  const toPort = toEl.querySelector(`.port[data-port="${cssEsc(link.portTo)}"][data-dir="in"]`);
  if (!fromPort || !toPort) return null;
  const a = portCenter(fromPort);
  const b = portCenter(toPort);
  const isFlow = !fromPort.dataset.type && !toPort.dataset.type;
  let d;
  let samples;
  if (isFlow) {
    const midY = Math.min(a.y, b.y) - 30;
    const c1 = { x: a.x, y: midY };
    const c2 = { x: b.x, y: midY };
    d = `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
    samples = sampleCubic(a, c1, c2, b);
  } else {
    const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
    const c1 = { x: a.x + dx, y: a.y };
    const c2 = { x: b.x - dx, y: b.y };
    d = `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
    samples = sampleCubic(a, c1, c2, b);
  }
  const id = linkId(link);
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "link-group");
  group.dataset.link = id;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("class", `link ${isFlow ? "link-flow" : "link-data"}`);
  if (isFlow) path.dataset.flow = "1";
  if (toPort.dataset.type) path.dataset.type = toPort.dataset.type;
  path.dataset.link = id;

  // 视觉线很细，手指按不住；上面盖一条透明的宽路径专门接收「按住连线」的按下事件
  const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hit.setAttribute("d", d);
  hit.setAttribute("class", "link-hit");
  hit.dataset.link = id;

  group.append(path, hit);
  canvasState.linkSamples.set(id, samples);
  return group;
}

function cssEsc(s) {
  return String(s).replace(/(["\\])/g, "\\$1");
}

function linkId(l) {
  return l.id || `${l.from}.${l.port}->${l.to}.${l.portTo}`;
}

function redrawLinks() {
  const flow = currentFlow();
  const svg = worldEl() && worldEl().querySelector("svg.links");
  if (!flow || !svg) return;
  svg.innerHTML = "";
  canvasState.linkSamples.clear();
  for (const link of flow.links || []) {
    const path = makeLinkPath(link);
    if (path) svg.appendChild(path);
  }
}

/* ---------------------------- 积木操作 ---------------------------- */
function addBlock(type) {
  const flow = currentFlow();
  if (!flow) {
    setStatus(active.tab === "effects" ? "先选一个效果和触发流程" : "先选一个技能", "bad");
    return;
  }
  // 技能流程可以放多个触发，每个触发接自己的内容；
  // 效果的每个触发是独立流程，一个流程里仍然只能有一个触发。
  if (type === "trigger" && active.tab !== "skills" && flow.nodes.some((n) => n.type === "trigger")) {
    setStatus("效果的每个触发需要单独流程，请点「+ 新触发」", "bad");
    return;
  }
  const base = { trigger: "trg", attack: "atk", heal: "heal", number: "num" }[type] || type;
  let i = 1;
  const used = new Set(flow.nodes.map((n) => n.id));
  while (used.has(`${base}${i}`)) i += 1;
  const id = `${base}${i}`;
  const def = blockDef(type);
  const options = {};
  for (const o of def.options || []) options[o.key] = o.default;
  // 触发条件按当前编辑对象给默认值
  if (type === "trigger") options.event = active.tab === "skills" ? SKILL_DEFAULT_TRIGGER : EFFECT_DEFAULT_TRIGGER;
  // 刚放下的「数值」积木给一个非 0 的默认值，免得连上去后伤害为 0 让人以为是 bug
  if (type === "number" && options.mode === "const" && !Number(options.value)) options.value = 10;
  if (type === "number" && options.mode === "range") {
    if (options.max <= options.min) options.max = Math.max(10, options.min + 10);
  }
  let pos;
  if (type === "trigger" && active.tab === "skills") {
    // 技能可以有多个触发：放在已有触发的下方，避免叠在攻击/数值积木上
    const triggers = flow.nodes.filter((n) => n.type === "trigger");
    const first = triggers[0];
    pos =
      first && first.pos
        ? { x: Math.round(first.pos.x), y: Math.round(first.pos.y + 220 * triggers.length) }
        : { x: 80, y: 80 };
  } else {
    const box = canvasEl().getBoundingClientRect();
    const center = toWorld(
      box.left + box.width / 2 + (Math.random() - 0.5) * 60,
      box.top + box.height / 2 + (Math.random() - 0.5) * 60
    );
    pos = { x: Math.round(center.x - 110), y: Math.round(center.y - 60) };
  }
  flow.nodes.push({ id, type, options, pos });
  if (type === "trigger" && active.tab === "effects") {
    const card = currentEffect();
    card.triggers = card.triggers || [];
    card.triggers.push({ block: { id, event: options.event, unitScope: "self" } });
    card.flows = card.flows || {};
    card.flows[id] = flow;
    active.triggerId = id;
    renderEffectPanel();
    renderCardsList();
  }
  selectNode(id);
  markDirty();
  refreshFlowView();
}

function selectNode(id) {
  canvasState.selectedId = id;
  $$(".block").forEach((el) => el.classList.toggle("is-selected", el.dataset.id === id));
  const del = $("#btn-delete-block");
  if (del) del.disabled = !id;
}

function deleteSelected() {
  const flow = currentFlow();
  const id = canvasState.selectedId;
  if (!flow || !id) return;
  flow.nodes = flow.nodes.filter((n) => n.id !== id);
  flow.links = (flow.links || []).filter((l) => l.from !== id && l.to !== id);
  if (active.tab === "effects") {
    const card = currentEffect();
    card.triggers = (card.triggers || []).filter((t) => t.block.id !== id);
    if (card.flows) delete card.flows[id];
    if (active.triggerId === id) active.triggerId = card.triggers[0] ? card.triggers[0].block.id : null;
    renderEffectPanel();
  }
  selectNode(null);
  markDirty();
  refreshFlowView();
}

function findInputPort(flow, node, portId) {
  const def = blockDef(node.type);
  // 「声明变量」的值端口类型随 type 选项变，不能用 catalog 里的静态类型
  if (node.type === "declareVariable" && portId === "value") {
    return { id: "value", direction: "in", type: variablePortType(node.options && node.options.type) };
  }
  const base = def.ports.find((p) => p.id === portId && p.direction === "in");
  if (base) return base;
  if (node.type === "math") {
    const op = node.options && node.options.operator;
    const unlimited = op === "max" || op === "min";
    const connected = (flow.links || []).filter((l) => l.to === node.id && l.portTo !== portId).length;
    const list = inputPortIds(def, node.options || {}, connected);
    if (list.includes(portId) || (unlimited && /^in\d+$/.test(portId))) {
      return { id: portId, direction: "in", type: "number" };
    }
  }
  return null;
}

function addLink(from, port, to, portTo) {
  const flow = currentFlow();
  if (!flow || from === to) return;
  const fromNode = flow.nodes.find((n) => n.id === from);
  const toNode = flow.nodes.find((n) => n.id === to);
  if (!fromNode || !toNode) return;
  const def = blockDef(fromNode.type);
  const outPort = def.ports.find((p) => p.id === port && p.direction === "out");
  const inPort = findInputPort(flow, toNode, portTo);
  if (!outPort || !inPort) return;
  const fType = outPort.type || null;
  const tType = inPort.type || null;
  flow.links = flow.links || [];
  if (!fType || !tType) {
    if (Boolean(fType) !== Boolean(tType)) {
      setStatus("执行流只能接执行流的端口", "bad");
      return;
    }
    // 执行流：出 1 进 1
    flow.links = flow.links.filter((l) => !(l.from === from && l.port === port) && !(l.to === to && l.portTo === portTo));
  } else {
    const ok = fType === tType || fType === "any" || tType === "any" || (fType === "target" && tType === "targetset");
    if (!ok) {
      setStatus(`类型不匹配：${DATA_TYPE_LABEL[fType] || fType} → ${DATA_TYPE_LABEL[tType] || tType}`, "bad");
      return;
    }
    flow.links = flow.links.filter((l) => !(l.to === to && l.portTo === portTo));
  }
  flow.links.push({ id: `${from}.${port}->${to}.${portTo}`, from, port, to, portTo });
  markDirty();
  // 运算积木的端口数量会随连接数变化，重绘整块画布才能长出/收起输入口
  refreshFlowView();
}

function refreshFlowView() {
  renderFlow();
}

/* ---------------------------- 指针事件 ---------------------------- */
function setupCanvas() {
  const el = canvasEl();
  if (!el) return;
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("text/block");
    if (type) addBlock(type);
  });
  el.addEventListener("change", onBlockOptionChange);
  el.addEventListener("input", onBlockOptionChange);
  window.addEventListener("resize", () => redrawLinks());

  const bind = (sel, fn) => {
    const el = $(sel);
    if (!el) return;
    el.onclick = fn;
  };
  bind("#btn-delete-block", deleteSelected);
  bind("#btn-fit", fitView);
  bind("#btn-locate", locateNearestBlock);
  bind("#btn-tidy", tidyFlow);
  bind("#btn-template", insertSlimeBeatTemplate);
  const modeInput = $("#canvas-mode");
  if (modeInput) {
    modeInput.addEventListener("change", () => setCanvasMode(modeInput.checked ? "cut" : "pan"));
  }
  setCanvasMode(canvasState.mode);
  bind("#btn-zoom-in", () => zoomBy(1.15));
  bind("#btn-zoom-out", () => zoomBy(1 / 1.15));
  const zoomInput = $("#zoom-label");
  if (zoomInput) {
    const apply = () => {
      const percent = Number(zoomInput.value);
      if (!Number.isFinite(percent)) {
        syncWorld();
        return;
      }
      setZoomPercent(percent);
    };
    zoomInput.addEventListener("change", apply);
    zoomInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      apply();
      zoomInput.blur();
    });
  }
  bind("#btn-clear-flow", () => {
    const flow = currentFlow();
    if (!flow) return;
    if (!confirm("清空当前流程的积木？")) return;
    flow.nodes = [];
    flow.links = [];
    if (active.tab === "effects") {
      const card = currentEffect();
      card.triggers = [];
      card.flows = {};
      active.triggerId = null;
      renderEffectPanel();
    }
    markDirty();
    refreshFlowView();
  });
}

/** 以画布中心（或指定屏幕点）为锚点设置缩放百分比（1% ~ 200%） */
function setZoomPercent(percent, cx, cy) {
  const box = canvasEl().getBoundingClientRect();
  const ax = cx === undefined ? box.width / 2 : cx;
  const ay = cy === undefined ? box.height / 2 : cy;
  const z = zoomOfPercent(clampZoomPercent(percent));
  const prev = canvasState.view.zoom || ZOOM_BASE;
  canvasState.view.x = ax - ((ax - canvasState.view.x) * z) / prev;
  canvasState.view.y = ay - ((ay - canvasState.view.y) * z) / prev;
  canvasState.view.zoom = z;
  syncWorld();
  redrawLinks();
}

function zoomBy(k) {
  setZoomPercent(zoomPercentOf(canvasState.view.zoom) * k);
}

function fitView() {
  const flow = currentFlow();
  const box = canvasEl().getBoundingClientRect();
  if (!flow || !flow.nodes.length) {
    canvasState.view = { x: 40, y: 40, zoom: ZOOM_BASE };
    syncWorld();
    redrawLinks();
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of flow.nodes) {
    const el = canvasState.nodeEls.get(node.id);
    const w = el?.offsetWidth || 224;
    const h = el?.offsetHeight || 150;
    const x = (node.pos && node.pos.x) || 0;
    const y = (node.pos && node.pos.y) || 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  const pad = 48;
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  // 适应时最多回到 100%，不把小流程放得比基准还大
  const fitZoom = Math.min(
    (box.width - pad * 2) / contentW,
    (box.height - pad * 2) / contentH,
    zoomOfPercent(100)
  );
  const z = zoomOfPercent(clampZoomPercent(zoomPercentOf(fitZoom)));
  canvasState.view.zoom = z;
  canvasState.view.x = box.width / 2 - ((minX + maxX) / 2) * z;
  canvasState.view.y = box.height / 2 - ((minY + maxY) / 2) * z;
  syncWorld();
  redrawLinks();
}

/** 「定位」：把视角移动到离当前视口中心最近的积木 */
function locateNearestBlock() {
  const flow = currentFlow();
  if (!flow || !flow.nodes.length) return;
  const box = canvasEl().getBoundingClientRect();
  const zoom = canvasState.view.zoom || 1;
  const center = {
    x: (box.width / 2 - canvasState.view.x) / zoom,
    y: (box.height / 2 - canvasState.view.y) / zoom,
  };
  let best = null;
  let bestDist = Infinity;
  for (const node of flow.nodes) {
    const el = canvasState.nodeEls.get(node.id);
    const w = el?.offsetWidth || 224;
    const h = el?.offsetHeight || 150;
    const cx = (node.pos?.x || 0) + w / 2;
    const cy = (node.pos?.y || 0) + h / 2;
    const dist = Math.hypot(cx - center.x, cy - center.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = { cx, cy };
    }
  }
  if (!best) return;
  canvasState.view.x = box.width / 2 - best.cx * zoom;
  canvasState.view.y = box.height / 2 - best.cy * zoom;
  syncWorld();
  redrawLinks();
}

function isFlowLink(flow, link) {
  const from = flow.nodes.find((n) => n.id === link.from);
  const to = flow.nodes.find((n) => n.id === link.to);
  if (!from || !to) return false;
  const defFrom = blockDef(from.type);
  const defTo = blockDef(to.type);
  const out = defFrom?.ports.find((p) => p.id === link.port && p.direction === "out");
  const inp = defTo?.ports.find((p) => p.id === link.portTo && p.direction === "in");
  return Boolean(out && inp && !out.type && !inp.type);
}

function flowPortRank(node, portId) {
  const def = blockDef(node.type);
  const i = def?.ports.findIndex((p) => p.id === portId && p.direction === "out") ?? 0;
  return i < 0 ? 99 : i;
}

/**
 * 「整理」：按执行流顺序把执行类积木排成一列，数据类积木排到左侧一列。
 * 位置用实测高度逐块下推，保证积木块之间不重叠；最后 fit 到可视范围。
 */
function tidyFlow() {
  const flow = currentFlow();
  if (!flow || !flow.nodes.length) return;
  const nodes = flow.nodes;
  const isExec = (node) => {
    const def = blockDef(node.type);
    return Boolean(def && def.ports.some((p) => !p.type));
  };

  const flowLinks = (flow.links || []).filter((l) => isFlowLink(flow, l));
  const execNodes = nodes.filter(isExec);
  const dataNodes = nodes.filter((n) => !isExec(n));

  // 从触发积木开始，按端口顺序深度优先执行流
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    const node = nodes.find((n) => n.id === id);
    if (!node || !isExec(node)) return;
    seen.add(id);
    order.push(node);
    const outs = flowLinks
      .filter((l) => l.from === id)
      .sort((a, b) => flowPortRank(node, a.port) - flowPortRank(node, b.port));
    for (const link of outs) visit(link.to);
  };
  const trigger = nodes.find((n) => n.type === "trigger") || execNodes[0];
  if (trigger) visit(trigger.id);
  for (const node of execNodes) visit(node.id);

  const heightOf = (id) => canvasState.nodeEls.get(id)?.offsetHeight || 150;
  const EXEC_X = 430;
  const DATA_X = 40;
  const GAP = 36;
  const execY = new Map();
  let cursor = 80;
  for (const node of order) {
    node.pos = { x: EXEC_X, y: cursor };
    execY.set(node.id, cursor);
    cursor += heightOf(node.id) + GAP;
  }

  // 数据积木：尽量靠近它服务的执行积木；没有执行消费者就排在末尾
  const consumers = new Map();
  for (const link of flow.links || []) {
    if (isFlowLink(flow, link)) continue;
    if (!consumers.has(link.from)) consumers.set(link.from, []);
    consumers.get(link.from).push(link.to);
  }
  const anchorCache = new Map();
  const anchorY = (id, seen = new Set()) => {
    if (anchorCache.has(id)) return anchorCache.get(id);
    if (execY.has(id)) return execY.get(id);
    if (seen.has(id)) return Infinity;
    seen.add(id);
    let best = Infinity;
    for (const toId of consumers.get(id) || []) {
      best = Math.min(best, anchorY(toId, seen));
    }
    anchorCache.set(id, best);
    return best;
  };
  const dataOrder = dataNodes
    .map((node) => ({ node, anchor: anchorY(node.id) }))
    .sort((a, b) => (a.anchor === b.anchor ? String(a.node.id).localeCompare(String(b.node.id)) : a.anchor - b.anchor));

  cursor = 80;
  for (const { node, anchor } of dataOrder) {
    const y = Number.isFinite(anchor) ? Math.max(cursor, anchor) : cursor;
    node.pos = { x: DATA_X, y };
    cursor = y + heightOf(node.id) + GAP;
  }

  markDirty();
  refreshFlowView();
  fitView();
}

/** 给新插入的模板节点找一个不与现有节点冲突的 id */
function uniqueFlowNodeId(base, used) {
  if (!used.has(base)) return base;
  const match = /^(.*?)(\d+)$/.exec(base);
  const prefix = match ? match[1] : base;
  let n = match ? Number(match[2]) + 1 : 2;
  let id = `${prefix}${n}`;
  while (used.has(id)) {
    n += 1;
    id = `${prefix}${n}`;
  }
  return id;
}

/** 把默认史莱姆「撞击」的积木与连线追加到当前技能流程 */
function insertSlimeBeatTemplate() {
  if (active.tab !== "skills") {
    setStatus("模板只用于技能流程", "bad");
    return;
  }
  const flow = currentFlow();
  if (!flow) {
    setStatus("先选择一个技能，再插入模板", "bad");
    return;
  }
  flow.nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  flow.links = Array.isArray(flow.links) ? flow.links : [];
  const template = FLOW_TEMPLATE_SLIME_BEAT;
  const nodes = flow.nodes;
  const used = new Set(nodes.map((n) => n.id));

  // 空流程从左上角开始；非空流程放在现有积木下方，避免叠在一起
  const minX = Math.min(...template.nodes.map((n) => n.pos.x));
  const minY = Math.min(...template.nodes.map((n) => n.pos.y));
  let originX = 80;
  let originY = 80;
  if (nodes.length) {
    const left = Math.min(...nodes.map((n) => Number(n.pos?.x) || 0));
    const bottom = Math.max(
      ...nodes.map((n) => {
        const el = canvasState.nodeEls.get(n.id);
        return (Number(n.pos?.y) || 0) + (el?.offsetHeight || 150);
      })
    );
    originX = Math.max(40, left);
    originY = bottom + 60;
  }

  const idMap = new Map();
  for (const node of template.nodes) {
    const id = uniqueFlowNodeId(node.id, used);
    used.add(id);
    idMap.set(node.id, id);
    flow.nodes.push({
      id,
      type: node.type,
      options: clone(node.options || {}),
      pos: { x: originX + node.pos.x - minX, y: originY + node.pos.y - minY },
    });
  }
  let linkCount = 0;
  for (const item of template.links) {
    const from = idMap.get(item.from);
    const to = idMap.get(item.to);
    if (!from || !to) continue;
    const link = { from, port: item.port, to, portTo: item.portTo };
    link.id = linkId(link);
    flow.links.push(link);
    linkCount += 1;
  }

  markDirty();
  refreshFlowView();
  fitView();
  setStatus(`已插入模板「${template.name}」：${template.nodes.length} 块积木 / ${linkCount} 条连线`, "ok");
}

function onPointerDown(e) {
  if (e.button === 2) return;
  // 切割 / 平移期间忽略后续手指，保证一次只处理一个手势
  if (canvasState.erase || canvasState.pan) return;
  canvasState.lastXY = { x: e.clientX, y: e.clientY };
  const portEl = e.target.closest(".port");
  const blockEl = e.target.closest(".block");
  const pathEl = e.target.closest("path.link, path.link-hit");

  if (portEl && blockEl && portEl.dataset.dir === "out") {
    e.preventDefault();
    canvasState.link = { from: blockEl.dataset.id, port: portEl.dataset.port };
    drawDragLine(e);
    canvasEl().setPointerCapture(e.pointerId);
    return;
  }
  // 按在连线上和按在空白处遵循同一套手势：由滑钮决定平移还是切割
  if (pathEl) {
    beginCanvasGesture(e);
    return;
  }
  // 积木里的下拉 / 勾选 / 输入框必须走原生交互：
  // 这里若继续 setPointerCapture，后续 click 会被重定向到画布，桌面端就点不动勾选框。
  const controlEl = blockEl && e.target.closest("input, select, textarea, button, label, option");
  if (controlEl) {
    selectNode(blockEl.dataset.id);
    return;
  }
  if (blockEl) {
    selectNode(blockEl.dataset.id);
    canvasState.drag = { id: blockEl.dataset.id, x: e.clientX, y: e.clientY, moved: false };
    canvasEl().setPointerCapture(e.pointerId);
    return;
  }
  beginCanvasGesture(e);
}

/**
 * 按视口坐标找落点元素。
 * 指针被捕获时 e.target 不可信，必须用 elementsFromPoint 取真实堆叠顺序。
 * 端口只有 12px，手指很难精确命中，因此在坐标没直接命中端口时，
 * 再在若干像素内做一次「最近端口」兜底（只考虑输入端口，避免连到相邻输出口）。
 */
function elementAtPoint(clientX, clientY, selector) {
  const direct = document.elementsFromPoint(clientX, clientY).find((n) => n.closest && n.closest(selector));
  if (direct) return direct.closest(selector);

  // 兜底：在落点附近找最近的可见元素
  let best = null;
  let bestDist = Infinity;
  const SLOP = 24;
  for (const el of $$(selector)) {
    if (el.dataset.dir !== "in") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const dist = Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
    if (dist <= SLOP && dist < bestDist) {
      best = el;
      bestDist = dist;
    }
  }
  return best;
}

function drawDragLine(e) {
  const world = worldEl();
  let g = $("#drag-line");
  if (!g) {
    g = document.createElementNS("http://www.w3.org/2000/svg", "path");
    g.id = "drag-line";
    g.setAttribute("class", "drag-line");
    const svg = world.querySelector("svg.links");
    if (svg) svg.appendChild(g);
  }
  const startEl = canvasState.nodeEls.get(canvasState.link.from)?.querySelector(`.port[data-port="${cssEsc(canvasState.link.port)}"]`);
  if (!startEl) return;
  const a = portCenter(startEl);
  const b = toWorld(e.clientX, e.clientY);
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  g.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
}

/* ---------------------------- 擦除 ---------------------------- */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 一条连线的采样折线是否落在笔刷扫过的线段附近 */
function polylineNearSegment(points, a, b, radius) {
  for (const p of points) {
    if (distanceToSegment(p.x, p.y, a.x, a.y, b.x, b.y) <= radius) return true;
  }
  return false;
}

/** 批量删除擦除命中的连线；同一次扫动只重绘一次 */
function removeLinks(ids) {
  const flow = currentFlow();
  if (!flow || !ids.length) return;
  const remove = new Set(ids);
  const before = (flow.links || []).length;
  flow.links = (flow.links || []).filter((link) => !remove.has(linkId(link)));
  if (flow.links.length === before) return;
  markDirty();
  // 运算积木的输入口会随连线数量收放，必须整块重绘
  if (flow.nodes.some((n) => n.type === "math" && ["max", "min"].includes(n.options && n.options.operator))) {
    refreshFlowView();
  } else {
    redrawLinks();
    renderJson();
  }
}

/** 笔刷从上一位置扫到当前位置，擦掉扫过的所有连线 */
function eraseAtPointer(e) {
  const erase = canvasState.erase;
  if (!erase) return;
  showEraseCursor(e.clientX, e.clientY);
  const flow = currentFlow();
  if (!flow) return;
  const a = toWorld(erase.lastX, erase.lastY);
  const b = toWorld(e.clientX, e.clientY);
  const radius = ERASE_RADIUS / (canvasState.view.zoom || 1);
  const hit = [];
  for (const link of flow.links || []) {
    const id = linkId(link);
    const samples = canvasState.linkSamples.get(id);
    if (samples && polylineNearSegment(samples, a, b, radius)) hit.push(id);
  }
  erase.lastX = e.clientX;
  erase.lastY = e.clientY;
  if (hit.length) removeLinks(hit);
}

function onPointerMove(e) {
  // 切割模式：只擦线，不平移画布
  if (canvasState.erase) {
    if (e.pointerId === canvasState.erase.pointerId) eraseAtPointer(e);
    return;
  }
  if (canvasState.link) {
    drawDragLine(e);
    return;
  }
  if (canvasState.drag) {
    const flow = currentFlow();
    const node = flow && flow.nodes.find((n) => n.id === canvasState.drag.id);
    const dx = (e.clientX - canvasState.drag.x) / canvasState.view.zoom;
    const dy = (e.clientY - canvasState.drag.y) / canvasState.view.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) canvasState.drag.moved = true;
    if (node) {
      node.pos.x += dx;
      node.pos.y += dy;
      const el = canvasState.nodeEls.get(node.id);
      if (el) {
        el.style.left = `${node.pos.x}px`;
        el.style.top = `${node.pos.y}px`;
      }
      redrawLinks();
    }
    canvasState.drag.x = e.clientX;
    canvasState.drag.y = e.clientY;
    return;
  }
  if (canvasState.pan) {
    if (e.pointerId !== canvasState.pan.pointerId) return;
    const dx = e.clientX - canvasState.pan.x;
    const dy = e.clientY - canvasState.pan.y;
    if (Math.hypot(dx, dy) > 4) canvasState.pan.moved = true;
    canvasState.view.x = canvasState.pan.vx + dx;
    canvasState.view.y = canvasState.pan.vy + dy;
    syncWorld();
    redrawLinks();
  }
}

function onPointerUp(e) {
  // 只处理发起当前画布手势的那根手指，别被第二根手指提前结束
  const gestureId = canvasState.erase
    ? canvasState.erase.pointerId
    : canvasState.pan
      ? canvasState.pan.pointerId
      : null;
  if (gestureId !== null && e.pointerId !== gestureId) return;

  if (canvasState.erase) {
    endEraseMode();
    canvasState.pan = null;
    return;
  }

  if (canvasState.link) {
    // 拖动连线时画布做了 setPointerCapture，pointerup 的 e.target 会被重定向成
    // 画布本身，直接读 e.target 永远命中不到端口。这里按下真实坐标取落点。
    const drop = elementAtPoint(e.clientX, e.clientY, ".port");
    const dropBlock = drop && drop.closest(".block");
    if (drop && dropBlock && drop.dataset.dir === "in") {
      addLink(canvasState.link.from, canvasState.link.port, dropBlock.dataset.id, drop.dataset.port);
    }
    canvasState.link = null;
    $("#drag-line")?.remove();
    try {
      if (canvasEl().hasPointerCapture?.(e.pointerId)) canvasEl().releasePointerCapture(e.pointerId);
    } catch {
      /* 某些浏览器在指针已释放时会抛错，忽略 */
    }
  }
  if (canvasState.drag) {
    if (canvasState.drag.moved) {
      markDirty();
      renderJson();
    }
    canvasState.drag = null;
  }
  if (canvasState.pan && !canvasState.pan.moved) selectNode(null);
  canvasState.pan = null;
}

/*
 * 上面的画布实现见下方指针对话；这里做一层指针捕获的兜底。
 */

/* ---------------------------- 积木选项修改 ---------------------------- */
function onBlockOptionChange(e) {
  const nodeEl = e.target.closest(".block");
  if (!nodeEl) return;
  const flow = currentFlow();
  const node = flow && flow.nodes.find((n) => n.id === nodeEl.dataset.id);
  if (!node) return;
  let changed = false;
  if (e.target.dataset.option) {
    const key = e.target.dataset.option;
    node.options = node.options || {};
    node.options[key] = e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? Number(e.target.value) : e.target.value;
    changed = true;
    if (node.type === "trigger" && active.tab === "effects") {
      const card = currentEffect();
      const t = (card.triggers || []).find((x) => x.block.id === node.id);
      if (t && key === "event") {
        t.block.event = node.options.event;
        active.triggerId = t.block.id;
        const flowLabel = $("#flow-title");
        if (flowLabel) flowLabel.textContent = `当前触发：${TRIGGER_LABEL[t.block.event] || t.block.event}`;
      }
    }
  }
  if (e.target.dataset.constant) {
    const key = e.target.dataset.constant;
    node.options = node.options || {};
    if (e.target.value === "") delete node.options[key];
    else node.options[key] = e.target.value;
    changed = true;
  }
  if (changed) {
    markDirty();
    if (node.type === "math" && e.target.dataset.option === "operator") pruneMathInputs(flow, node);
    if (node.type === "declareVariable" && e.target.dataset.option === "type") pruneVariableValue(flow, node);
    renderJson();
    if (e.target.tagName === "SELECT") renderFlow();
  }
}

/** 技能字段的写入（表单与编程接口共用） */
function applySkillField(card, key, value) {
  if (key === "id") {
    const old = card.id;
    card.id = String(value || "").trim();
    for (const ch of project.characters || []) {
      ch.skillIds = (ch.skillIds || []).map((x) => (x === old ? card.id : x));
    }
    // 效果挂载的技能也按 id 引用，改技能 id 时一起改
    for (const effect of project.effects || []) {
      effect.skillIds = (effect.skillIds || []).map((x) => (x === old ? card.id : x));
    }
    active.skill = card;
  } else if (key === "image") {
    card.image = String(value ?? "").trim();
  } else if (key === "usesPerTurn" || key === "usesTotal") {
    card[key] = Math.max(0, Math.floor(Number(value) || 0));
  } else card[key] = String(value ?? "");
}

function onSkillFormInput(e) {
  const s = currentSkill();
  if (!s) return;
  if (e.target.dataset.iconFile === "skill") {
    if (e.type !== "change") return;
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      s.image = String(reader.result || "");
      renderSkillPanel();
      renderCardsList();
      markDirty();
      renderJson();
    };
    reader.readAsDataURL(file);
    return;
  }
  if (e.target.dataset.skillPack !== undefined) {
    if (moveCardToPack(s, e.target.value)) {
      followCardPack(s);
      markDirty();
      renderAll();
    } else {
      renderSkillPanel();
    }
    return;
  }
  const key = e.target.dataset.skill;
  if (!key) return;
  applySkillField(s, key, e.target.value);
  if (key === "image") {
    const img = $('[data-icon-preview="skill"]');
    if (img) img.src = resolveCardImage(s);
  }
  markDirty();
  renderCardsList();
  renderJson();
}

function onEffectFormInput(e) {
  const card = currentEffect();
  if (!card) return;
  // 效果表单里嵌了「挂载技能区」：先交给它处理，避免被当成普通效果字段
  if (handleMountEvent("effect", e)) return;
  if (e.target.dataset.iconFile === "effect") {
    if (e.type !== "change") return;
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      card.image = String(reader.result || "");
      renderEffectPanel();
      renderCardsList();
      markDirty();
      renderJson();
    };
    reader.readAsDataURL(file);
    return;
  }
  if (e.target.dataset.effectBar !== undefined) {
    card.bar = Boolean(e.target.checked);
    if (card.bar) {
      card.stackable = true;
      const n = Number(card.maxStacks);
      if (!Number.isFinite(n) || n <= 0) card.maxStacks = 1;
    } else {
      card.barInvert = false;
    }
    markDirty();
    renderEffectPanel();
    renderJson();
    return;
  }
  if (e.target.dataset.effectBarInvert !== undefined) {
    card.barInvert = Boolean(e.target.checked);
    markDirty();
    renderJson();
    return;
  }
  if (e.target.dataset.effectColorPicker !== undefined) {
    card.color = parseEffectColor(e.target.value) || "";
    const text = $('[data-effect="color"]');
    if (text) {
      text.value = card.color;
      text.classList.remove("is-invalid");
    }
    markDirty();
    renderJson();
    return;
  }
  const flag = e.target.dataset.effectFlag;
  if (flag) {
    card.flags = Array.isArray(card.flags) ? card.flags : [];
    card.flags = e.target.checked ? [...new Set([...card.flags, flag])] : card.flags.filter((f) => f !== flag);
    markDirty();
    renderJson();
    return;
  }
  if (e.target.dataset.effectAuto !== undefined) {
    card.autoConsume = Boolean(e.target.checked);
    markDirty();
    renderJson();
    return;
  }
  if (e.target.dataset.effectPack !== undefined) {
    if (moveCardToPack(card, e.target.value)) {
      followCardPack(card);
      markDirty();
      renderAll();
    } else {
      renderEffectPanel();
    }
    return;
  }
  if (e.target.dataset.effectStack !== undefined) {
    card.stackable = Boolean(e.target.checked);
    if (!card.stackable) {
      const n = Number(card.maxStacks);
      card.maxStacks = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1;
      // 条式显示必须有上限；关掉层数计数时自动关掉条式显示
      card.bar = false;
      card.barInvert = false;
    }
    markDirty();
    // 「层数上限」只在勾选「层数计数」时显示
    renderEffectPanel();
    renderJson();
    return;
  }
  if (e.target.dataset.effectNumber) {
    const key = e.target.dataset.effectNumber;
    const n = Number(e.target.value);
    if (key === "maxStacks") {
      let next = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1;
      if (card.bar && next <= 0) {
        next = 1;
        e.target.value = "1";
      }
      card.maxStacks = next;
    }
    markDirty();
    renderJson();
    return;
  }
  // 属性修正：选属性 / 改数值（行内编辑不重绘表单，避免输入框失焦）
  const attrBonusIndex = e.target.dataset.attrbonusAttr;
  if (attrBonusIndex !== undefined) {
    const op = (card.attrBonus || [])[Number(attrBonusIndex)];
    if (!op) return;
    op.attr = e.target.value;
    markDirty();
    renderJson();
    return;
  }
  const attrBonusValue = e.target.dataset.attrbonusValue;
  if (attrBonusValue !== undefined) {
    const op = (card.attrBonus || [])[Number(attrBonusValue)];
    if (!op) return;
    const n = Number(e.target.value);
    op.value = Number.isFinite(n) ? n : 0;
    markDirty();
    renderJson();
    return;
  }
  const key = e.target.dataset.effect;
  if (!key) return;
  if (key === "color") {
    const raw = String(e.target.value || "").trim();
    if (!raw) {
      card.color = "";
      e.target.classList.remove("is-invalid");
      const picker = $("[data-effect-color-picker]");
      if (picker) picker.value = effectColorOf(card);
      markDirty();
      renderJson();
      return;
    }
    const parsed = parseEffectColor(raw);
    if (!parsed) {
      e.target.classList.add("is-invalid");
      if (e.type === "change") {
        e.target.value = card.color || "";
        e.target.classList.remove("is-invalid");
      }
      return;
    }
    card.color = parsed;
    e.target.classList.remove("is-invalid");
    if (e.type === "change" && e.target.value !== parsed) e.target.value = parsed;
    const picker = $("[data-effect-color-picker]");
    if (picker) picker.value = parsed;
    markDirty();
    renderJson();
    return;
  }
  if (key === "id") {
    card.id = e.target.value.trim();
    active.effect = card;
  } else if (key === "polarity") card.polarity = e.target.value || "positive";
  else if (key === "image") {
    card.image = String(e.target.value || "").trim();
  } else card[key] = e.target.value;
  if (key === "image") {
    const img = $('[data-icon-preview="effect"]');
    if (img) img.src = resolveCardImage(card);
  }
  markDirty();
  renderCardsList();
  renderJson();
}

/** 卡包表单：改名 / 版本 / 作者 / 说明（包 ID 走「应用包 ID」按钮） */
function onPackFormInput(e) {
  const meta = packEntry(active.packId);
  if (!meta) return;
  const key = e.target.dataset.pack;
  if (!key) return;
  if (key === "name") {
    const value = String(e.target.value || "");
    if (value.trim()) renamePack(meta.id, value);
  } else if (key === "version") {
    meta.version = Math.max(1, Math.floor(Number(e.target.value) || 1));
  } else if (key === "author") {
    meta.author = String(e.target.value || "");
  } else if (key === "description") {
    meta.description = String(e.target.value || "");
  }
  // 只更新下拉里的显示名，不重绘表单（避免输入框失焦）
  for (const opt of $$("#ed-pack-list option")) {
    if (opt.value === meta.id) opt.textContent = `${meta.name || meta.id}（${meta.id}）`;
  }
  markDirty();
  renderCardsList();
  renderJson();
}

function uniqueId(existing, base) {
  let id = base;
  let i = 2;
  while (existing.includes(id)) {
    id = `${base}_${i}`;
    i += 1;
  }
  return id;
}

function copyText(text) {
  if (!text) return false;
  const done = () => setStatus("已复制到剪贴板", "ok");
  const fail = () => setStatus("复制失败", "bad");
  try {
    const p = navigator.clipboard?.writeText(text);
    if (p && typeof p.then === "function") {
      p.then(done).catch(fail);
      return true;
    }
  } catch {
    /* 走下面的兜底 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand && document.execCommand("copy");
    area.remove();
    if (ok) {
      done();
      return true;
    }
  } catch {
    /* 忽略 */
  }
  fail();
  return false;
}

/**
 * 导入一个文件：ZIP 模组包 → 解出 JSON + 包内卡面（内嵌成 data URL）；
 * 其它按 JSON 读。工程 / 内容包 / 卡包都走原来的识别器。
 */
async function importFileIntoEditor(file) {
  if (!file) return;
  try {
    const bytes = await file.arrayBuffer();
    if (isZipBytes(bytes)) {
      await importZipPack(file, bytes);
      return;
    }
  } catch {
    /* 读不出来就退回按文本处理 */
  }
  readJsonFile(file, importContent);
}

/** 导入 ZIP 模组包到编辑器：卡面写进单位卡的 image 字段（data URL） */
async function importZipPack(file, bytes) {
  let pack;
  try {
    pack = unpackModZip(bytes, {
      fileName: file.name || "mod.zip",
      createUrls: false,
      includeEntries: true,
    });
  } catch (err) {
    setStatus(`ZIP 读取失败：${String((err && err.message) || err)}`, "bad");
    return;
  }
  const doc = pack.raw;
  const art = applyPackImagesToUnits(
    pack,
    pack.entries,
    Array.isArray(doc.units) ? doc.units : []
  );
  // 工程格式的单位叫 characters，同样把卡面塞进去
  if (doc.kind === PROJECT_KIND && Array.isArray(doc.characters)) {
    applyPackImagesToUnits(pack, pack.entries, doc.characters);
  }
  const skillArt = applyPackImagesToCards(pack, pack.entries, doc.skills, "skill");
  const effectArt = applyPackImagesToCards(pack, pack.entries, doc.effects, "effect");
  importContent(doc, file);
  const units = Array.isArray(doc.units)
    ? doc.units.length
    : Array.isArray(doc.characters)
      ? doc.characters.length
      : 0;
  setStatus(
    `已导入 ZIP 模组「${doc.name || pack.modName}」：${units} 个单位，内嵌卡面 ${art.matched} 张` +
      `，技能图标 ${skillArt.matched} 个，效果图标 ${effectArt.matched} 个${
        pack.warnings && pack.warnings.length ? `；${pack.warnings.length} 条提示` : ""
      }`,
    "ok"
  );
}

function importProject(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  // 工程文件、内容包、ZIP 模组包都走同一个识别器
  importFileIntoEditor(file);
}

/**
 * 删除一张卡（角色 / 技能 / 效果）。
 *  · 从工程移除，并记入 removed*Ids：重开编辑器时不会从内容包补回
 *  · 清空所有流程里对该 id 的常量引用，避免留下必然报错的悬空引用
 *  · 技能还会从角色的「挂载技能」里移除
 * @returns {{ok: boolean, kind?: string, id?: string, name?: string, cleared?: number, error?: string}}
 */
function deleteCard(kind, target) {
  const list =
    kind === "unit" ? project.characters : kind === "skill" ? project.skills : kind === "effect" ? project.effects : null;
  const card =
    target || (kind === "unit" ? currentCharacter() : kind === "skill" ? currentSkill() : kind === "effect" ? currentEffect() : null);
  if (!list || !card || !list.includes(card)) return { ok: false, error: "没有可删除的卡" };

  const id = card.id;
  const name = card.name || id;
  list.splice(list.indexOf(card), 1);
  markRemoved(kind, id);
  const cleared = clearAllCardRefs(id);

  if (kind === "skill") {
    for (const ch of project.characters || []) {
      ch.skillIds = (ch.skillIds || []).filter((x) => x !== id);
    }
    for (const effect of project.effects || []) {
      effect.skillIds = (effect.skillIds || []).filter((x) => x !== id);
    }
  }

  // 删除后在同一编辑中卡包里选下一张；没有就为空，不跳到别的卡包
  if (kind === "unit") {
    active.character = firstCardInPack(project.characters, active.editPack);
  } else if (kind === "skill") {
    active.skill = firstCardInPack(project.skills, active.editPack);
    canvasState.selectedId = null;
  } else {
    active.effect = firstCardInPack(project.effects, active.editPack);
    active.triggerId = null;
    canvasState.selectedId = null;
  }

  markDirty();
  renderAll();
  return { ok: true, kind, id, name, cleared };
}

const DELETE_LABEL = { unit: "角色", skill: "技能", effect: "效果" };
/** 待确认的删除请求：{ kind, card } */
let pendingDelete = null;

function deleteCardOf(kind) {
  return kind === "unit" ? currentCharacter() : kind === "skill" ? currentSkill() : currentEffect();
}

function deleteHint(kind) {
  if (kind === "skill") return "会从角色挂载里移除，并清空流程里引用它的积木。";
  if (kind === "unit") return "流程里引用这个角色的积木会被清空。";
  return "流程里引用这个效果的积木会被清空。";
}

/** 打开删除确认弹窗（真正删除在 confirmPendingDelete 里执行） */
function confirmDelete(kind) {
  const label = DELETE_LABEL[kind] || "卡";
  const card = deleteCardOf(kind);
  if (!card) {
    setStatus(`没有可删除的${label}`, "bad");
    return false;
  }
  const modal = $("#ed-delete-modal");
  const title = $("#ed-delete-title");
  const desc = $("#ed-delete-desc");
  if (!modal || !title || !desc) {
    // 极端情况下缺少弹窗节点：退回原生确认框
    if (!confirm(`删除${label}「${card.name || card.id}」？\n\n${deleteHint(kind)}`)) return false;
    pendingDelete = { kind, card };
    return Boolean(confirmPendingDelete());
  }
  pendingDelete = { kind, card };
  title.textContent = `删除${label}`;
  desc.textContent = `删除${label}「${card.name || card.id}」？${deleteHint(kind)}删除只影响本工程，不会修改内容包文件。`;
  modal.hidden = false;
  $("#btn-delete-confirm")?.focus?.();
  return true;
}

function closeDeleteModal() {
  pendingDelete = null;
  const modal = $("#ed-delete-modal");
  if (modal) modal.hidden = true;
}

/** 确认删除：按待确认请求里的卡 id 走 edit.delete*，避免弹窗期间选中变化删错卡 */
function confirmPendingDelete() {
  const request = pendingDelete;
  if (!request || !request.card) {
    closeDeleteModal();
    return null;
  }
  const { kind, card } = request;
  const label = DELETE_LABEL[kind] || "卡";
  const name = card.name || card.id;
  closeDeleteModal();

  const res =
    kind === "unit" ? edit.deleteCharacter(card.id) : kind === "skill" ? edit.deleteSkill(card.id) : edit.deleteEffect(card.id);
  if (!res || !res.ok) {
    setStatus(`删除${label}失败：${(res && res.error) || "未知原因"}`, "bad");
    return null;
  }
  // 立刻落盘，避免 400ms 后的自动保存状态把删除提示顶掉
  clearTimeout(saveTimer);
  const saved = flushSave();
  const tip = `已删除${label}「${name}」${res.cleared ? ` · 清空了 ${res.cleared} 处流程引用` : ""}`;
  setStatus(saved ? tip : `${tip}，但保存失败，请点顶栏「保存」重试`, saved ? "ok" : "bad");
  return res;
}

/* ================================================================== */
/* 启动                                                                */
/* ================================================================== */
/**
 * 真实的「设计」动作接口：表单子表、选下拉、连端口都走它。
 * 单元测试 / 控制台调试也用它，保证和界面上点按钮是同一条路径。
 */
const edit = {
  get project() {
    return project;
  },
  setProject,
  setActive(patch = {}) {
    const next = { ...patch };
    // 兼容旧调用：按 id 指定技能/效果时转成对象引用；之后一切编辑都认对象，改 id 不会丢当前卡
    if ("skillId" in next) {
      next.skill = (project.skills || []).find((s) => s.id === next.skillId) || null;
      delete next.skillId;
    }
    if ("effectId" in next) {
      next.effect = (project.effects || []).find((e) => e.id === next.effectId) || null;
      delete next.effectId;
    }
    if ("characterId" in next) {
      next.character = (project.characters || []).find((c) => c.id === next.characterId) || null;
      delete next.characterId;
    }
    Object.assign(active, next);
    if (active.character && !(project.characters || []).includes(active.character)) active.character = null;
    if (active.skill && !(project.skills || []).includes(active.skill)) active.skill = null;
    if (active.effect && !(project.effects || []).includes(active.effect)) active.effect = null;
    if (!active.tab) active.tab = "character";
    if (active.tab === "character" && !currentCharacter() && project.characters[0]) active.character = project.characters[0];
    if (active.tab === "skills" && !currentSkill() && project.skills[0]) active.skill = project.skills[0];
    if (active.tab === "effects" && !currentEffect() && project.effects[0]) active.effect = project.effects[0];
    switchTab(active.tab);
  },
  /** 修改角色字段 */
  setCharacter(key, value) {
    const ch = currentCharacter();
    if (!ch) throw new Error("当前没有角色");
    if (key === "image") ch.image = value === null ? null : String(value || "");
    else if (["level", "baseHp", "baseAtk", "baseDef", "critRate", "critDamage", "speed"].includes(key)) {
      ch[key] = Number(value) || 0;
    } else if (key === "actionsPerTurn") {
      ch.actionsPerTurn = Math.max(1, Math.floor(Number(value) || 1));
    } else if (["occupiesSlot", "countsAsUnit", "invincible", "obtainable"].includes(key)) ch[key] = Boolean(value);
    else if (["name", "id", "quality", "label", "description", "pack", "packName"].includes(key)) ch[key] = String(value ?? "");
    else throw new Error(`未知角色字段：${key}`);
    markDirty();
    renderCharacter();
    renderCardsList();
    renderJson();
  },
  setResistance(attr, value) {
    if (!RESISTANCE_ATTRIBUTES.includes(attr)) return;
    const ch = currentCharacter();
    if (!ch) return;
    ch.resistances[attr] = Number(value) || 0;
    markDirty();
    renderJson();
  },
  newCharacter(id, name) {
    const pack = newCardPack();
    const cid = id || uniqueId((project.characters || []).map((c) => c.id), buildId(pack.id, "unit", "char"));
    const ch = createCharacter();
    ch.id = cid;
    ch.name = name || "新角色";
    ch.pack = pack.id;
    ch.packName = pack.name;
    unmarkRemoved("unit", cid);
    project.characters.push(ch);
    active.character = ch;
    markDirty();
    switchTab("character");
    return ch;
  },
  newSkill(id, name) {
    const pack = newCardPack();
    const sid = id || uniqueId(project.skills.map((x) => x.id), buildId(pack.id, "skill", "new"));
    const card = createSkill(sid, name || "新技能");
    card.pack = pack.id;
    card.packName = pack.name;
    unmarkRemoved("skill", card.id);
    project.skills.push(card);
    active.skill = card;
    markDirty();
    switchTab("skills");
    return card;
  },
  newEffect(id, name) {
    const pack = newCardPack();
    const eid = id || uniqueId(project.effects.map((x) => x.id), buildId(pack.id, "effect", "new"));
    const card = createEffect(eid, name || "新效果");
    card.pack = pack.id;
    card.packName = pack.name;
    unmarkRemoved("effect", card.id);
    project.effects.push(card);
    active.effect = card;
    active.triggerId = null;
    markDirty();
    switchTab("effects");
    return card;
  },
  /** 删除当前角色（或按 id 指定）；返回 {ok, id, name, cleared} */
  deleteCharacter(id) {
    if (id === undefined) return deleteCard("unit");
    const target = (project.characters || []).find((c) => c.id === id);
    return target ? deleteCard("unit", target) : { ok: false, error: `找不到角色：${id}` };
  },
  /** 删除当前技能（或按 id 指定） */
  deleteSkill(id) {
    if (id === undefined) return deleteCard("skill");
    const target = (project.skills || []).find((s) => s.id === id);
    return target ? deleteCard("skill", target) : { ok: false, error: `找不到技能：${id}` };
  },
  /** 删除当前效果（或按 id 指定） */
  deleteEffect(id) {
    if (id === undefined) return deleteCard("effect");
    const target = (project.effects || []).find((e) => e.id === id);
    return target ? deleteCard("effect", target) : { ok: false, error: `找不到效果：${id}` };
  },
  /** 修改技能字段（走和表单一样的入口） */
  setSkillField(key, value) {
    const card = currentSkill();
    if (!card) throw new Error("当前没有技能");
    // 和表单输入走同一条路径：真实 DOM 事件改成直接调用处理逻辑
    applySkillField(card, key, value);
    markDirty();
    renderSkillPanel();
    renderCardsList();
    renderJson();
    return card;
  },
  setEffectField(key, value) {
    const card = currentEffect();
    if (!card) throw new Error("当前没有效果");
    if (key === "flags") card.flags = Array.isArray(value) ? value.slice() : [];
    else if (key === "id") {
      card.id = String(value || "").trim();
      active.effect = card;
    } else if (key === "attrBonus") card.attrBonus = normalizeEffectAttrBonus(value);
    else if (key === "autoConsume") card.autoConsume = Boolean(value);
    else if (key === "polarity") card.polarity = ["positive", "negative", "special"].includes(value) ? value : "positive";
    else if (key === "stackable") card.stackable = Boolean(value);
    else if (key === "maxStacks") {
      const n = Number(value);
      card.maxStacks = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1;
    } else card[key] = String(value ?? "");
    markDirty();
    renderEffectPanel();
    renderCardsList();
    renderJson();
    return card;
  },
  /** 给效果加一条属性修正（和「+ 添加属性修正」按钮一致） */
  addAttrBonus(attr = "atkPct", value = 0) {
    const card = currentEffect();
    if (!card) throw new Error("当前没有效果");
    card.attrBonus = Array.isArray(card.attrBonus) ? card.attrBonus : [];
    const op = { attr, value: Number(value) || 0 };
    card.attrBonus.push(op);
    markDirty();
    renderEffectPanel();
    renderJson();
    return op;
  },
  /** 删除第 index 条属性修正 */
  removeAttrBonus(index) {
    const card = currentEffect();
    if (!card) throw new Error("当前没有效果");
    const i = Number(index);
    card.attrBonus = (card.attrBonus || []).filter((_, idx) => idx !== i);
    markDirty();
    renderEffectPanel();
    renderJson();
    return card.attrBonus;
  },
  /** 给效果加一个触发流程（和「+ 新触发」按钮一致） */
  addTrigger(event = EFFECT_DEFAULT_TRIGGER) {
    const card = currentEffect();
    if (!card) throw new Error("当前没有效果");
    card.triggers = card.triggers || [];
    card.flows = card.flows || {};
    const id = uniqueId(card.triggers.map((t) => t.block.id), "trg", "");
    const flow = { schema: 1, kind: "flow", nodes: [], links: [] };
    const def = blockDef("trigger");
    const options = {};
    for (const o of def.options || []) options[o.key] = o.default;
    options.event = event;
    flow.nodes.push({ id, type: "trigger", options, pos: { x: 80, y: 80 } });
    card.triggers.push({ block: { id, event, unitScope: "self" } });
    card.flows[id] = flow;
    active.triggerId = id;
    markDirty();
    renderEffectPanel();
    renderFlow();
    renderJson();
    return id;
  },
  /** 往当前流程放一块积木（和点积木盒一致） */
  addBlock(type) {
    const flow = currentFlow();
    if (!flow) return null;
    const before = new Set(flow.nodes.map((n) => n.id));
    addBlock(type);
    return flow.nodes.find((n) => !before.has(n.id)) || null;
  },
  /** 连端口（和拖线一致；非法连接返回 false 并提示） */
  connect(from, port, to, portTo) {
    addLink(from, port, to, portTo);
    const flow = currentFlow();
    return Boolean((flow.links || []).some((l) => l.from === from && l.port === port && l.to === to && l.portTo === portTo));
  },
  deleteBlock(id) {
    canvasState.selectedId = id;
    deleteSelected();
  },
  /** 立即保存 + 返回当前流程 JSON / 完整工程 */
  saveNow() {
    clearTimeout(saveTimer);
    flushSave();
    return exportSnapshot();
  },
  exportSnapshot,
  currentFlow: () => buildFlowJson(),
  validate: () => validateProject(project),
  triggerLabel: flowTriggerLabel,
  /** 导入内容（卡包 / 内容包 / 单张卡 / 工程） */
  importContent,
  /** 新建卡包（不传 id 时自动生成 pack2 / pack3…） */
  addPack(id, name) {
    const packId = id || newPackId();
    if (packEntry(packId)) throw new Error(`卡包 id 已存在：${packId}`);
    const pack = createPack(packId, name || `新卡包 ${packId}`);
    packsOfProject().push(pack);
    active.packId = pack.id;
    markDirty();
    renderAll();
    return pack;
  },
  /** 重命名卡包（只改显示名） */
  setPackName(id, name) {
    const ok = renamePack(id, name);
    if (ok) {
      markDirty();
      renderAll();
    }
    return ok;
  },
  /** 修改卡包 id（级联改卡 id 与所有引用） */
  setPackId(oldId, newId) {
    const res = renamePackId(oldId, newId);
    if (res.ok) {
      markDirty();
      renderAll();
    }
    return res;
  },
  /** 把一张卡切到另一个卡包 */
  setCardPack(kind, id, packId) {
    const list = kind === "unit" ? project.characters : kind === "skill" ? project.skills : project.effects;
    const card = (list || []).find((c) => c.id === id);
    if (!card) return false;
    const ok = moveCardToPack(card, packId);
    if (ok) {
      followCardPack(card);
      markDirty();
      renderAll();
    }
    return ok;
  },
  /** 导出指定卡包（默认当前标签页所在的卡包） */
  exportPackFile(id = active.packId) {
    return exportPack(id);
  },
  /** 取一个卡包文件对象（不下载） */
  packFile(id = currentPackId()) {
    return packFileOf(project, id);
  },
};

/** 导出快照：整个工程 + 当前卡包文件 + 当前流程 */
function exportSnapshot() {
  const id = currentPackId();
  return {
    project: JSON.parse(JSON.stringify(project)),
    pack: JSON.parse(JSON.stringify(packFileOf(project, id))),
    flow: currentFlow() ? buildFlowJson() : null,
  };
}

export { setProject, projectToContent, edit, importContent, flowFromContent, unitCardToCharacter };

/** 模组启用 / 停用后重新汇总卡包（编辑器已经初始化过时用） */
export async function refreshEditorPacks({ force = false } = {}) {
  normalizeProject(project);
  const res = await hydrateFromPacks({ force });
  if (res.ok) {
    renderAll();
    // 只有真的补进了卡才写盘；否则每次打开编辑器都会把旧工程再保存一遍
    if (res.changed) markDirty();
  }
}

export async function initEditor() {
  normalizeProject(project);
  if (!project.characters.length) project.characters.push(createCharacter());
  if (!project.pack) project.pack = PACK;
  // 刚被清空 / 第一次打开的工程：强制重读一次卡包，避免直接从旧缓存补回旧版卡
  const freshProject =
    !project.updatedAt && !(project.skills || []).length && !(project.effects || []).length;
  if (!currentCharacter()) active.character = project.characters[0] || null;
  if (!currentSkill()) active.skill = (project.skills || [])[0] || null;
  if (!currentEffect()) active.effect = (project.effects || [])[0] || null;
  setupForms();
  setupMountCollapse();
  setupCanvas();
  // 设置页清除本地数据后：立即丢弃内存里的旧工程 / 旧卡组，重新从存储和卡包同步
  onDataCleared((kind) => {
    if (kind === "editor") {
      reloadEditorFromStorage().catch((err) =>
        setStatus("重新同步编辑器失败：" + String((err && err.message) || err), "bad")
      );
    } else if (kind === "packs") {
      refreshEditorPacks({ force: true }).catch((err) =>
        setStatus("重新读取卡包失败：" + String((err && err.message) || err), "bad")
      );
    } else if (kind === "localmods") {
      refreshEditorPacks().catch((err) =>
        setStatus("重新读取模组失败：" + String((err && err.message) || err), "bad")
      );
    } else if (kind === "all") {
      suppressPendingSaves();
    }
  });
  document.querySelector("#btn-back")?.addEventListener("click", () => {
    if (!dirty) return;
    flushSaveSync();
  });
  switchTab("character");
  renderCharacter();
  initialized = true;
  // 把默认包 + 已启用模组里的卡补进工程；已有编辑按 id 保留
  const res = await hydrateFromPacks({ force: freshProject });
  if (res.ok) {
    renderAll();
    if (res.changed) markDirty();
  }
}

/* ================================================================== */
/* 积木盒                                                              */
/* ================================================================== */
function renderPalette() {
  const groups = {};
  for (const block of Object.values(catalog.blocks)) {
    if (block.hidden) continue;
    if (block.group === "trigger" && active.tab === "skills" && block.kind !== "trigger") continue;
    (groups[block.group] = groups[block.group] || []).push(block);
  }
  const order = ["trigger", "action", "structure", "logic", "data-op", "data-unit", "data-set", "variable"];
  const html = order
    .filter((g) => groups[g])
    .map((g) => {
      const meta = BLOCK_GROUPS[g] || { label: g, color: "#5FB0E6" };
      const items = groups[g]
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      return `
      <div class="palette-group">
        <div class="palette-title" style="--g:${meta.color}">${escapeHtml(meta.label)}</div>
        <div class="palette-items">
          ${items
            .map(
              (b) =>
                `<button class="palette-item" type="button" data-block="${escapeHtml(b.kind)}" draggable="true" style="--g:${b.color}" title="${escapeHtml(
                  b.note || b.subtitle || b.title
                )}">${escapeHtml(b.title)}</button>`
            )
            .join("")}
        </div>
      </div>`;
    })
    .join("");
  for (const id of ["#ed-palette", "#ed-palette-2"]) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }
  // 重新绑定（palette 是重建的）
  $$(".palette-item").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => addBlock(btn.dataset.block));
    btn.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/block", btn.dataset.block));
  });
}

/* ================================================================== */
/* 导入卡包 / 内容包（把 data/*.json 或别的卡包弄进来继续改）              */
/* ================================================================== */
function acceptDropOnCharacter(e) {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) importFileIntoEditor(file);
  else if (e.dataTransfer) {
    // 也可以直接拖一段 JSON 文本进来
    const text = e.dataTransfer.getData("text/plain");
    if (text) {
      try {
        importContent(JSON.parse(text));
      } catch (err) {
        setStatus("导入失败：" + err.message, "bad");
      }
    }
  }
}

/**
 * 触发浏览器下载一个 JSON 文件。
 * 兼容性要点（之前「有时按导出没反应」的原因）：
 *  · 锚点必须挂进文档再 click，部分浏览器对游离节点不生效；
 *  · 只下载一个文件（多文件连发会被浏览器当自动下载拦截）；
 *  · 生成 / 点击失败时退回剪贴板，并给出可见提示。
 * @returns {boolean} 是否已触发下载
 */
function downloadBlob(name, blob, fallbackText = "") {
  let url = null;
  try {
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 部分移动端浏览器要在点击后稍等才读取 blob，太早 revoke 会导致空文件
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch (err) {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (fallbackText) copyText(fallbackText);
    return false;
  }
}

function downloadJson(name, data) {
  const text = JSON.stringify(data, null, 2);
  return downloadBlob(name, new Blob([text], { type: "application/json" }), text);
}

/** 把注册表里的单位卡转回角色表单需要的形状 */
function unitCardToCharacter(card) {
  const ch = createCharacter();
  Object.assign(ch, {
    id: card.id,
    name: card.name,
    pack: card.pack || DEFAULT_PACK_ID,
    packName: card.packName || (card.pack === DEFAULT_PACK_ID || !card.pack ? DEFAULT_PACK_NAME : String(card.pack)),
    quality: card.quality,
    level: card.level,
    baseHp: card.baseHp,
    baseAtk: card.baseAtk,
    baseDef: card.baseDef,
    critRate: card.critRate,
    critDamage: card.critDamage,
    speed: card.speed,
    actionsPerTurn: card.actionsPerTurn === undefined ? 1 : Math.max(1, Math.floor(Number(card.actionsPerTurn) || 1)),
    label: card.label || "",
    description: card.description || "",
    occupiesSlot: card.occupiesSlot,
    countsAsUnit: card.countsAsUnit,
    invincible: card.invincible,
    // 旧卡包没有这个字段：undefined 时保持 createCharacter() 的默认（true）
    obtainable: card.obtainable === undefined ? ch.obtainable : Boolean(card.obtainable),
    image: card.image === null ? null : card.image || "",
    skillIds: (card.skills || []).slice(),
    resistances: Object.fromEntries(
      RESISTANCE_ATTRIBUTES.map((a) => [a, Number(card.resistances?.[a] ?? createCharacter().resistances[a]) || 0])
    ),
  });
  return ch;
}

/**
 * 导入一份内容：
 *  - 编辑器工程（kind = caeworld-editor-project）→ 直接替换工程
 *  - 内容包 { units:[], skills:[], effects:[] } / 单张技能卡 / 单张效果卡 → 合并进来
 * 单位卡、技能卡里的流程会转成编辑器画布上的积木（位置按节点顺序自动排）。
 */
/** 文件名推导卡包 id（去掉扩展名） */
function packIdFromFile(file) {
  const raw = file && file.name ? String(file.name).replace(/\.[^.]+$/, "") : "";
  return isValidPackId(raw) ? raw : "imported";
}

/** 按 id 替换或追加一张卡 */
function upsertCard(list, card) {
  const idx = list.findIndex((x) => x && x.id === card.id);
  if (idx >= 0) list[idx] = card;
  else list.push(card);
}

/** 导入卡包文件（工程 + 内容合并格式） */
function importPackDoc(doc, file) {
  const id = isValidPackId(doc.id) ? String(doc.id) : packIdFromFile(file);
  const name = String(doc.name || id);
  const meta = ensurePack(id, name);
  meta.name = name;
  if (doc.version !== undefined) meta.version = Math.max(1, Math.floor(Number(doc.version) || 1));
  meta.author = String(doc.author || "");
  meta.description = String(doc.description || "");

  let n = 0;
  for (const u of Array.isArray(doc.units) ? doc.units : []) {
    if (!u || !u.id) continue;
    const ch = unitCardToCharacter(u);
    ch.pack = id;
    ch.packName = name;
    unmarkRemoved("unit", ch.id);
    upsertCard(project.characters || (project.characters = []), ch);
    n += 1;
  }
  for (const s of Array.isArray(doc.skills) ? doc.skills : []) {
    if (!s || !s.id) continue;
    const card = createSkill(s.id, s.name);
    unmarkRemoved("skill", card.id);
    card.type = s.type || "active";
    card.description = s.description || "";
    card.image = s.image === null ? null : s.image || "";
    card.pack = id;
    card.packName = name;
    card.usesPerTurn = Math.max(0, Math.floor(Number(s.usesPerTurn) || 0));
    card.usesTotal = Math.max(0, Math.floor(Number(s.usesTotal) || 0));
    card.flow = flowFromContent(s.flow);
    if (s.ui) card.ui = clone(s.ui);
    upsertCard(project.skills || (project.skills = []), card);
    n += 1;
  }
  for (const e of Array.isArray(doc.effects) ? doc.effects : []) {
    if (!e || !e.id) continue;
    const def = createEffect(e.id, e.name);
    unmarkRemoved("effect", def.id);
    def.flags = Array.isArray(e.flags) ? e.flags.filter((x) => x !== "negative") : [];
    def.polarity = effectPolarityOf(e);
    def.stackable = Boolean(e.stackable);
    def.maxStacks = Number.isFinite(Number(e.maxStacks)) ? Math.max(0, Math.floor(Number(e.maxStacks))) : 1;
    def.description = e.description || "";
    def.image = e.image === null ? null : e.image || "";
    def.color = typeof e.color === "string" ? e.color : "";
    def.bar = Boolean(e.bar);
    def.barInvert = Boolean(e.bar && e.barInvert);
    def.pack = id;
    def.packName = name;
    def.attrBonus = normalizeEffectAttrBonus(e.attrBonus);
    def.autoConsume = Boolean(e.autoConsume);
    def.skillIds = Array.isArray(e.skillIds) ? [...new Set(e.skillIds.filter((x) => typeof x === "string" && x))] : [];
    def.triggers = (e.triggers || [])
      .map((t) => ({
        block: {
          id: (t && (t.id || (t.block && t.block.id))) || "",
          event: (t && (t.event || (t.block && t.block.event))) || EFFECT_DEFAULT_TRIGGER,
          unitScope: (t && (t.unitScope || (t.block && t.block.unitScope))) || "self",
        },
      }))
      .filter((t) => t.block.id);
    def.flows = {};
    for (const t of def.triggers) def.flows[t.block.id] = flowFromContent((e.flows || {})[t.block.id]);
    if (e.ui) def.ui = clone(e.ui);
    upsertCard(project.effects || (project.effects = []), def);
    n += 1;
  }
  active.packId = id;
  markDirty();
  normalizeProject(project);
  renderAll();
  switchTab("packs");
  setStatus(`已导入卡包「${name}」：${n} 张卡`, "ok");
}

function importContent(doc, file) {
  if (!doc || typeof doc !== "object") {
    setStatus("不是有效的 JSON", "bad");
    return;
  }
  if (doc.kind === PROJECT_KIND) {
    setProject(doc);
    markDirty();
    setStatus("已导入工程（包含全部卡包）", "ok");
    return;
  }
  if (doc.kind === PACK_KIND) {
    importPackDoc(doc, file);
    return;
  }
  const units = doc.units || (doc.kind === "units" ? [doc] : []);
  const skills = doc.skills || (doc.kind === "skills" ? [doc] : []);
  const effects = doc.effects || (doc.kind === "effects" ? [doc] : []);
  if (!units.length && !skills.length && !effects.length && doc.id) {
    if (String(doc.id).includes("_skill_")) skills.push(doc);
    else if (String(doc.id).includes("_effect_")) effects.push(doc);
    else if (String(doc.id).includes("_unit_")) units.push(doc);
  }
  if (!units.length && !skills.length && !effects.length) {
    setStatus("没识别出单位/技能/效果内容", "bad");
    return;
  }
  // 旧内容包 / 单卡：统一归到一个卡包（优先用文件自带 pack，其次文件名）
  const packId = isValidPackId(doc.pack) ? String(doc.pack) : packIdFromFile(file);
  const packName = String(doc.packName || doc.modname || doc.name || packId);
  ensurePack(packId, packName);
  let n = 0;
  let importedCharacter = null;
  for (const u of units) {
    const ch = unitCardToCharacter(u);
    ch.pack = packId;
    ch.packName = packName;
    unmarkRemoved("unit", ch.id);
    upsertCard(project.characters || (project.characters = []), ch);
    importedCharacter = ch;
    n += 1;
  }
  for (const s of skills) {
    const card = createSkill(s.id, s.name);
    unmarkRemoved("skill", card.id);
    card.type = s.type || "active";
    card.description = s.description || "";
    card.image = s.image === null ? null : s.image || "";
    card.pack = packId;
    card.packName = packName;
    card.flow = flowFromContent(s.flow);
    if (s.ui) card.ui = clone(s.ui);
    upsertCard(project.skills || (project.skills = []), card);
    n += 1;
  }
  for (const e of effects) {
    const def = createEffect(e.id, e.name);
    unmarkRemoved("effect", def.id);
    def.flags = Array.isArray(e.flags) ? e.flags.filter((f) => f !== "negative") : [];
    def.polarity = effectPolarityOf(e);
    def.stackable = Boolean(e.stackable);
    def.maxStacks = Number.isFinite(Number(e.maxStacks)) ? Math.max(0, Math.floor(Number(e.maxStacks))) : 1;
    def.description = e.description || "";
    def.image = e.image === null ? null : e.image || "";
    def.color = typeof e.color === "string" ? e.color : "";
    def.bar = Boolean(e.bar);
    def.barInvert = Boolean(e.bar && e.barInvert);
    def.pack = packId;
    def.packName = packName;
    def.attrBonus = normalizeEffectAttrBonus(e.attrBonus);
    def.autoConsume = Boolean(e.autoConsume);
    def.skillIds = Array.isArray(e.skillIds) ? [...new Set(e.skillIds.filter((x) => typeof x === "string" && x))] : [];
    def.triggers = (e.triggers || []).map((t) => ({ block: { id: t.id, event: t.event, unitScope: t.unitScope || "self" } }));
    def.flows = {};
    for (const t of def.triggers) def.flows[t.block.id] = flowFromContent((e.flows || {})[t.block.id]);
    if (e.ui) def.ui = clone(e.ui);
    upsertCard(project.effects || (project.effects = []), def);
    n += 1;
  }
  if (importedCharacter) active.character = importedCharacter;
  // 导入完就能直接进战斗：把新技能挂到当前角色上（效果不挂载，只能在战斗中附加）
  const mountTarget = currentCharacter() || (project.characters || [])[0];
  if (mountTarget && skills.length) {
    mountTarget.skillIds = [...new Set([...(mountTarget.skillIds || []), ...skills.map((x) => x.id)])];
  }
  active.skill = skills.length ? project.skills.find((s) => s.id === skills[0].id) || project.skills[0] || null : project.skills[0] || null;
  active.effect = effects.length ? project.effects.find((e) => e.id === effects[0].id) || project.effects[0] || null : project.effects[0] || null;
  active.triggerId = null;
  active.packId = packId;
  markDirty();
  renderAll();
  switchTab(units.length ? "character" : skills.length ? "skills" : "effects");
  setStatus(`已导入 ${n} 项内容到卡包「${packName}」（技能已挂到当前角色）`, "ok");
}

/** 引擎流程 → 画布流程（补上位置；没有位置的按网格排开） */
function flowFromContent(flow) {
  if (!flow) return { schema: 1, kind: "flow", nodes: [], links: [] };
  const nodes = (flow.nodes || []).map((n, i) => ({
    id: n.id,
    type: n.type,
    options: { ...(n.options || {}) },
    pos: {
      x: Number.isFinite(n.pos && n.pos.x) ? n.pos.x : 60 + (i % 3) * 260,
      y: Number.isFinite(n.pos && n.pos.y) ? n.pos.y : 60 + Math.floor(i / 3) * 220,
    },
  }));
  const links = (flow.links || []).map((l) => ({ id: l.id, from: l.from, port: l.port, to: l.to, portTo: l.portTo }));
  return { schema: 1, kind: "flow", nodes, links };
}

function readJsonFile(file, done) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      done(JSON.parse(String(reader.result)), file);
    } catch (err) {
      setStatus("读取失败：" + err.message, "bad");
    }
  };
  reader.readAsText(file);
}

/* ================================================================== */
/* JSON 与校验                                                         */
/* ================================================================== */
/** 当前流程的「执行流程 JSON」：积木、填写、连接、位置 */
function buildFlowJson() {
  const flow = currentFlow();
  if (!flow) return null;
  return {
    schema: 1,
    kind: "flow",
    nodes: (flow.nodes || []).map((n) => ({
      id: n.id,
      type: n.type,
      options: n.options || {},
      pos: { x: Math.round((n.pos && n.pos.x) || 0), y: Math.round((n.pos && n.pos.y) || 0) },
    })),
    links: (flow.links || []).map((l) => ({
      id: linkId(l),
      from: l.from,
      port: l.port,
      to: l.to,
      portTo: l.portTo,
    })),
  };
}

/** 实时校验流程：有问题就显示在画布下方 */
function validateFlow() {
  const box = $("#flow-errors");
  const flow = buildFlowJson();
  if (!box) return true;
  if (!flow) {
    box.hidden = true;
    return true;
  }
  const r = prepareFlow(flow);
  if (r.ok) {
    box.hidden = true;
    box.textContent = "";
  } else {
    box.hidden = false;
    box.textContent = r.errors.join("；");
  }
  return r.ok;
}

/** 下方两个 JSON：执行流程（当前流程）+ 存档（当前卡包的卡包文件） */
function renderJson() {
  const flowBox = $("#json-flow");
  if (flowBox) {
    const flow = buildFlowJson();
    flowBox.textContent = flow ? JSON.stringify(flow, null, 2) : "{}";
  }
  const saveBox = $("#json-save");
  if (saveBox) {
    const packId = currentPackId();
    saveBox.textContent = JSON.stringify(packFileOf(project, packId), null, 2);
  }
  validateFlow();
}

/* ================================================================== */
/* 表单事件（角色 / 挂载 / 技能 / 效果 / 导入导出）                       */
/* ================================================================== */
function flushSaveSync() {
  if (savesSuppressed) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch {
    /* 忽略 */
  }
}

function setupMountCollapse() {
  const col = $("#ed-mount-col");
  const btn = $("#btn-toggle-mount");
  if (!col || !btn) return;
  const media = window.matchMedia("(max-width: 900px)");
  const apply = () => {
    // 电脑 / 横屏强制展开，并隐藏折叠按钮；移动端默认展开
    if (!media.matches) col.classList.remove("is-collapsed");
    const collapsed = col.classList.contains("is-collapsed");
    btn.hidden = !media.matches;
    btn.textContent = collapsed ? "展开" : "收起";
    btn.setAttribute("aria-expanded", String(!collapsed));
  };
  if (!btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      col.classList.toggle("is-collapsed");
      apply();
    });
    media.addEventListener?.("change", apply);
  }
  apply();
}

function setupForms() {
  const ch = () => {
    const cur = currentCharacter();
    if (cur) return cur;
    if (!(project.characters || []).length) project.characters.push(createCharacter());
    active.character = project.characters[0];
    return active.character;
  };
  const bind = (id, fn) => {
    const el = $("#" + id);
    if (!el) return;
    const handler = () => {
      fn(el);
      markDirty();
      renderCardsList();
      renderJson();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  };
  bind("f-name", (el) => (ch().name = el.value));
  bind("f-id", (el) => {
    ch().id = el.value.trim();
    // 默认卡面是「卡牌短 id.png」，改 id 时同步路径框
    renderCharacter();
  });
  bind("f-quality", (el) => (ch().quality = el.value));
  bind("f-level", (el) => (ch().level = Number(el.value) || 1));
  bind("f-hp", (el) => (ch().baseHp = Number(el.value) || 0));
  bind("f-atk", (el) => (ch().baseAtk = Number(el.value) || 0));
  bind("f-def", (el) => (ch().baseDef = Number(el.value) || 0));
  bind("f-crit", (el) => (ch().critRate = Number(el.value) || 0));
  bind("f-critdmg", (el) => (ch().critDamage = Number(el.value) || 0));
  bind("f-speed", (el) => (ch().speed = Number(el.value) || 0));
  bind("f-actions", (el) => (ch().actionsPerTurn = Math.max(1, Math.floor(Number(el.value) || 1))));
  bind("f-label", (el) => (ch().label = el.value));
  bind("f-intro", (el) => (ch().description = el.value));
  bind("f-image", (el) => {
    const value = el.value.trim();
    // 填的就是默认短 id.png 时存空，让默认路径跟着卡牌 id 走
    ch().image = value === defaultCardImageName(ch()) ? "" : value;
    renderCharacter();
  });
  for (const attr of RESISTANCE_ATTRIBUTES) {
    bind(`f-res-${attr}`, (el) => (ch().resistances[attr] = Number(el.value) || 0));
  }
  bind("f-occupy", (el) => (ch().occupiesSlot = el.checked));
  bind("f-count", (el) => (ch().countsAsUnit = el.checked));
  bind("f-invincible", (el) => (ch().invincible = el.checked));
  bind("f-obtainable", (el) => (ch().obtainable = el.checked));
  $("#f-pack")?.addEventListener("change", (e) => {
    const card = currentCharacter();
    if (!card) return;
    if (!moveCardToPack(card, e.target.value)) {
      renderCharacter();
      return;
    }
    followCardPack(card);
    markDirty();
    renderAll();
  });

  $("#f-image-file")?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      ch().image = String(reader.result);
      const input = $("#f-image");
      if (input) input.value = ch().image;
      renderCharacter();
      renderCardsList();
      markDirty();
      renderJson();
    };
    reader.readAsDataURL(file);
  });
  $("#btn-placeholder")?.addEventListener("click", () => {
    // null 表示「明确使用占位图」，不被默认 id.png 覆盖
    ch().image = null;
    const input = $("#f-image");
    if (input) input.value = "";
    renderCharacter();
    renderCardsList();
    markDirty();
    renderJson();
  });

  // 角色挂载技能区：搜索 / 排序 / 正倒序 / 勾选都由同一个委托处理
  for (const type of ["input", "change", "click"]) {
    $("#ed-mount-skills")?.addEventListener(type, (e) => {
      if (handleMountEvent("character", e)) e.stopPropagation();
    });
  }
  // 搜索框：捕获阶段再兜一层。部分浏览器 / 输入法插入文本时 input 不冒泡，
  // 只挂容器会收不到，表现为「输入了但列表不过滤」。
  document.addEventListener(
    "input",
    (e) => {
      const search = e.target.closest && e.target.closest("[data-mount-search]");
      if (!search) return;
      const panel = search.closest(".mount-panel");
      if (!panel) return;
      const scope = panel.dataset.mountScope === "effect" ? "effect" : "character";
      const ui = mountUi[scope] || (mountUi[scope] = { query: "", sort: "time", order: "asc" });
      ui.query = search.value;
      applyMountSearch(panel, ui.query);
    },
    true
  );
  // 顶部三个标签：角色 / 技能 / 效果。
  $$(".ed-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("#btn-new-character")?.addEventListener("click", () => edit.newCharacter());
  $("#btn-delete-character")?.addEventListener("click", () => confirmDelete("unit"));
  $("#ed-character-list")?.addEventListener("change", (e) => {
    active.character = project.characters[Number(e.target.value)] || null;
    renderAll();
  });
  $("#ed-edit-pack")?.addEventListener("change", (e) => {
    active.editPack = e.target.value || PACK_ALL;
    if (active.editPack !== PACK_ALL) active.packId = active.editPack;
    // 三个标签的当前卡都切到同一个包；没有卡的标签显示为空
    ensureAllInPack();
    renderAll();
  });

  $("#btn-new-skill")?.addEventListener("click", () => edit.newSkill());
  $("#btn-new-effect")?.addEventListener("click", () => edit.newEffect());
  $("#btn-delete-skill")?.addEventListener("click", () => confirmDelete("skill"));
  $("#btn-delete-effect")?.addEventListener("click", () => confirmDelete("effect"));
  $("#btn-delete-cancel")?.addEventListener("click", closeDeleteModal);
  $("#btn-delete-confirm")?.addEventListener("click", confirmPendingDelete);
  $("#ed-delete-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeDeleteModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#ed-delete-modal")?.hidden) closeDeleteModal();
  });
  $("#ed-skill-list")?.addEventListener("change", (e) => {
    active.skill = project.skills[Number(e.target.value)] || null;
    renderAll();
  });
  $("#ed-effect-list")?.addEventListener("change", (e) => {
    active.effect = project.effects[Number(e.target.value)] || null;
    active.triggerId = null;
    renderAll();
  });

  const onSkill = (e) => onSkillFormInput(e);
  $("#ed-skill-form")?.addEventListener("input", onSkill);
  $("#ed-skill-form")?.addEventListener("change", onSkill);
  $("#ed-skill-form")?.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="icon-placeholder"]')) {
      const card = currentSkill();
      if (!card) return;
      card.image = null;
      markDirty();
      renderSkillPanel();
      renderCardsList();
      renderJson();
      return;
    }
    if (!e.target.closest('[data-action="add-skill-trigger"]')) return;
    edit.addBlock("trigger");
  });

  const onEffect = (e) => onEffectFormInput(e);
  $("#ed-effect-form")?.addEventListener("input", onEffect);
  $("#ed-effect-form")?.addEventListener("change", onEffect);
  $("#ed-effect-form")?.addEventListener("click", (e) => {
    if (handleMountEvent("effect", e)) return;
    if (e.target.closest('[data-action="effect-color-reset"]')) {
      const card = currentEffect();
      if (!card) return;
      card.color = "";
      const text = $('[data-effect="color"]');
      if (text) {
        text.value = "";
        text.classList.remove("is-invalid");
      }
      const picker = $("[data-effect-color-picker]");
      if (picker) picker.value = effectColorOf(card);
      markDirty();
      renderJson();
      return;
    }
    if (e.target.closest('[data-action="icon-placeholder"]')) {
      const card = currentEffect();
      if (!card) return;
      card.image = null;
      markDirty();
      renderEffectPanel();
      renderCardsList();
      renderJson();
      return;
    }
    const chip = e.target.closest("[data-trigger]");
    if (chip) {
      active.triggerId = chip.dataset.trigger;
      renderAll();
      return;
    }
    if (e.target.closest('[data-action="add-trigger"]')) {
      edit.addTrigger();
      return;
    }
    if (e.target.closest('[data-action="delete-trigger"]')) {
      const card = currentEffect();
      if (!card || !active.triggerId) return;
      card.triggers = (card.triggers || []).filter((t) => t.block.id !== active.triggerId);
      if (card.flows) delete card.flows[active.triggerId];
      active.triggerId = card.triggers[0] ? card.triggers[0].block.id : null;
      markDirty();
      renderAll();
      return;
    }
    if (e.target.closest('[data-action="add-attrbonus"]')) {
      edit.addAttrBonus();
      return;
    }
    if (e.target.closest('[data-action="delete-attrbonus"]')) {
      const btn = e.target.closest("[data-index]");
      edit.removeAttrBonus(Number(btn && btn.dataset.index));
    }
  });

  $("#btn-export")?.addEventListener("click", openExportModal);
  $("#btn-export-cancel")?.addEventListener("click", closeExportModal);
  $("#btn-export-confirm")?.addEventListener("click", () => {
    const sel = $("#ed-export-pack");
    if (sel && sel.value) {
      active.packId = sel.value;
      renderPackPanel();
      renderJson();
      exportPack(sel.value);
    }
    closeExportModal();
  });
  $("#ed-export-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeExportModal();
  });
  $("#btn-import")?.addEventListener("click", () => $("#import-file")?.click());
  const cardCol = $("#ed-card-preview");
  if (cardCol && cardCol.parentElement) {
    const dropZone = cardCol.parentElement;
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("is-drop");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-drop"));
    dropZone.addEventListener("drop", (e) => {
      dropZone.classList.remove("is-drop");
      acceptDropOnCharacter(e);
    });
  }
  $("#import-file")?.addEventListener("change", importProject);
  $("#btn-save")?.addEventListener("click", () => {
    clearTimeout(saveTimer);
    flushSave();
  });
  $("#btn-copy-save")?.addEventListener("click", () => {
    copyText(JSON.stringify(packFileOf(project, currentPackId()), null, 2));
  });

  // 卡包面板
  $("#ed-pack-list")?.addEventListener("change", (e) => {
    active.packId = e.target.value || null;
    renderPackPanel();
    renderJson();
  });
  $("#btn-new-pack")?.addEventListener("click", () => {
    const id = newPackId();
    const pack = createPack(id, `新卡包 ${id}`);
    packsOfProject().push(pack);
    active.packId = id;
    markDirty();
    renderAll();
    setStatus(`已新建卡包「${pack.name}」`, "ok");
  });
  const onPackForm = (e) => onPackFormInput(e);
  $("#ed-pack-form")?.addEventListener("input", onPackForm);
  $("#ed-pack-form")?.addEventListener("change", onPackForm);
  $("#ed-pack-form")?.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="apply-pack-id"]')) {
      const meta = packEntry(active.packId);
      const input = $("#ed-pack-form [data-pack-id-input]");
      if (!meta || !input) return;
      const res = renamePackId(meta.id, input.value);
      if (!res.ok) {
        setStatus(res.error || "修改包 ID 失败", "bad");
        return;
      }
      markDirty();
      renderAll();
      setStatus(`已把包 ID 改为「${active.packId}」`, "ok");
      return;
    }
    if (e.target.closest('[data-action="export-pack"]') && active.packId) {
      exportPack(active.packId);
    }
  });
  $("#ed-pack-cards")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pack-card]");
    if (!btn) return;
    const [kind, ...rest] = String(btn.dataset.packCard).split(":");
    const id = rest.join(":");
    const card = allCards().find((c) => c.id === id);
    if (!card) return;
    if (kind === "unit") {
      active.character = card;
      switchTab("character");
    } else if (kind === "skill") {
      active.skill = card;
      switchTab("skills");
    } else {
      active.effect = card;
      active.triggerId = null;
      switchTab("effects");
    }
  });
  $("#btn-copy-flow")?.addEventListener("click", () => copyText($("#json-flow")?.textContent || "{}"));

  setupSaveDock();

  window.addEventListener("beforeunload", () => {
    if (dirty) flushSaveSync();
  });
}

/* ------------------------------------------------------------------ */
/* 存档 JSON：移动端固定底部 + 折叠成悬浮球                              */
/* ------------------------------------------------------------------ */
const SAVE_COLLAPSE_KEY = "caeworld:editor-json-collapsed";

function setupSaveDock() {
  const panel = $("#json-save-panel");
  const fab = $("#json-fab");
  const collapseBtn = $("#btn-collapse-save");
  const page = $("#editor-page");
  if (!panel || !fab || !collapseBtn) return;

  /** @param {boolean} collapsed */
  const apply = (collapsed) => {
    panel.classList.toggle("is-collapsed", collapsed);
    fab.hidden = !collapsed;
    // 移动端底部留白跟着折叠态变（.editor-page 上的 --save-bar-h）
    page?.classList.toggle("is-save-collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.title = collapsed ? "展开存档 JSON" : "折叠成悬浮球";
  };

  // 移动端默认折叠，给画布腾出空间；用户手动切换后记住选择
  let collapsed = window.matchMedia("(max-width: 900px)").matches;
  try {
    const saved = localStorage.getItem(SAVE_COLLAPSE_KEY);
    if (saved === "1") collapsed = true;
    else if (saved === "0") collapsed = false;
  } catch {
    /* 隐私模式读不到就按视口默认值 */
  }
  apply(collapsed);

  const toggle = (next) => {
    apply(next);
    try {
      localStorage.setItem(SAVE_COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* 存不住也不影响本次交互 */
    }
  };

  collapseBtn.addEventListener("click", () => toggle(!panel.classList.contains("is-collapsed")));
  fab.addEventListener("click", () => toggle(false));
}
