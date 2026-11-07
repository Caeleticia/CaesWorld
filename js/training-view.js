/**
 * training-view.js —— 测试 / 训练场：配置界面
 *
 * 做三件事：
 *  1. 从当前卡组（data/pack/<卡组>/）+ 编辑器本地工程里读出「牌库」；
 *  2. 构筑红 / 蓝两套卡组（牌库 → 卡组、保存 / 切换 / 删除卡组）；
 *  3. 把设置（场上最多单位 / 无敌 / 人机）与当前阵容实时存到 localStorage，然后开战。
 *
 * 布局：
 *   横屏：牌库1 | 红方卡组 | 蓝方卡组 | 牌库2，下方设置区 + 开始对战
 *   竖屏：顶端滑钮切红 / 蓝，依次为牌库、该方卡组，下方设置区 + 开始对战
 * 不滚页面：.tw-stage 固定设计尺寸，JS 等比缩放 + 居中（见 training-stage.js）。
 */
import {
  loadPack,
  DEFAULT_PACK,
  ContentRegistry,
  projectToRegistryInput,
  resolveImage,
  PLACEHOLDER_IMAGE,
  QUALITY_LABEL,
} from "../engine/index.js";
import { createStageScaler } from "./training-stage.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const SIDES = ["red", "blue"];
const SIDE_LABEL = { red: "红方", blue: "蓝方" };
const LIB_LABEL = { red: "牌库 1", blue: "牌库 2" };

const PACK = localStorage.getItem("caeworld:editor-pack") || DEFAULT_PACK;
const STORAGE_KEY = "caeworld:training:v1";
const EDITOR_KEY = `caeworld:editor-project:${PACK}`;
const MAX_DECK = 20;
const MAX_FIELD = 8;

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
let initPromise = null;
let scaler = null;
let page = null;
let stage = null;
let toastTimer = 0;
let activeSide = "red";
let hadStoredConfig = false;
let firstLoad = true;

let config = defaultConfig();
let library = { pack: PACK, registry: null, units: [], byId: new Map(), errors: [], loaded: false };

const refs = {
  cols: null,
  libList: {},
  libCount: {},
  filter: {},
  deckList: {},
  deckCount: {},
  savedList: {},
  maxUnits: null,
  startHint: null,
  startBtn: null,
  seg: null,
  pack: null,
  toast: null,
};

function defaultConfig() {
  return {
    v: 1,
    maxUnits: 4,
    redInvincible: false,
    blueInvincible: false,
    redAI: false,
    blueAI: true,
    red: [],
    blue: [],
    saved: { red: [], blue: [] },
    activeDeck: { red: null, blue: null },
    activeSide: "red",
    updatedAt: null,
  };
}

function loadConfig() {
  const fallback = defaultConfig();
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* localStorage 不可用就只用内存状态 */
  }
  if (!raw) return { config: fallback, stored: false };
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return { config: fallback, stored: false };
  }
  if (!data || typeof data !== "object") return { config: fallback, stored: false };
  const out = fallback;
  out.maxUnits = clamp(Math.round(Number(data.maxUnits) || 4), 1, MAX_FIELD);
  for (const key of ["redInvincible", "blueInvincible", "redAI", "blueAI"]) {
    if (typeof data[key] === "boolean") out[key] = data[key];
  }
  for (const side of SIDES) {
    if (Array.isArray(data[side])) out[side] = data[side].filter((id) => typeof id === "string").slice(0, MAX_DECK);
    const saved = data.saved && data.saved[side];
    if (Array.isArray(saved)) {
      out.saved[side] = saved
        .filter((d) => d && Array.isArray(d.units))
        .map((d) => ({
          id: typeof d.id === "string" && d.id ? d.id : makeDeckId(),
          name: typeof d.name === "string" && d.name ? d.name : "卡组",
          units: d.units.filter((id) => typeof id === "string").slice(0, MAX_DECK),
        }))
        .filter((d) => d.units.length);
    }
    const active = data.activeDeck && data.activeDeck[side];
    out.activeDeck[side] = typeof active === "string" ? active : null;
  }
  out.activeSide = data.activeSide === "blue" ? "blue" : "red";
  out.updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;
  return { config: out, stored: true };
}

function saveConfig() {
  config.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn("[训练场] 本地保存失败", err);
  }
}

function makeDeckId() {
  return `deck_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/* ------------------------------------------------------------------ */
/* 牌库：内容包 + 编辑器本地工程                                        */
/* ------------------------------------------------------------------ */
async function loadLibrary() {
  const errors = [];
  const merged = {
    units: new Map(),
    skills: new Map(),
    effects: new Map(),
  };
  const put = (map, list) => {
    for (const card of list || []) {
      if (card && typeof card.id === "string" && card.id) map.set(card.id, card);
    }
  };

  // 1) 内容包（data/pack/<卡组>/）
  try {
    const pack = await loadPack(PACK);
    if (pack) {
      put(merged.units, pack.units);
      put(merged.skills, pack.skills);
      put(merged.effects, pack.effects);
      if (pack.errors && pack.errors.length) errors.push(...pack.errors);
    }
  } catch (err) {
    errors.push(`内容包读取失败：${String(err.message || err)}`);
  }

  // 2) 编辑器本地工程（正在设计的角色 / 技能 / 效果也能直接拿来测）
  try {
    const raw = localStorage.getItem(EDITOR_KEY) || localStorage.getItem("caeworld:editor-project");
    if (raw) {
      const project = JSON.parse(raw);
      if (project && project.kind === "caeworld-editor-project") {
        const content = projectToRegistryInput(project);
        put(merged.units, content.units);
        put(merged.skills, content.skills);
        put(merged.effects, content.effects);
      }
    }
  } catch (err) {
    errors.push(`编辑器工程读取失败：${String(err.message || err)}`);
  }

  const registry = new ContentRegistry();
  const res = registry.load({
    units: [...merged.units.values()],
    skills: [...merged.skills.values()],
    effects: [...merged.effects.values()],
  });
  if (!res.ok) {
    for (const fail of res.failed) errors.push(`${fail.kind} ${fail.id || "(无 id)"} 未载入：${fail.errors.join("；")}`);
  }

  const units = [...registry.units.values()].map((card) => ({ card }));
  const byId = new Map(units.map((u) => [u.card.id, u]));
  library = { pack: PACK, registry, units, byId, errors, loaded: true };
}

/** 过滤掉已不存在于牌库里的单位（删卡 / 换卡组后） */
function sanitizeDecks() {
  const valid = new Set(library.units.map((u) => u.card.id));
  let changed = false;
  for (const side of SIDES) {
    const before = config[side].length;
    config[side] = config[side].filter((id) => valid.has(id));
    if (config[side].length !== before) changed = true;
    config.saved[side] = config.saved[side]
      .map((deck) => {
        const units = deck.units.filter((id) => valid.has(id));
        if (units.length !== deck.units.length) changed = true;
        return { ...deck, units };
      })
      .filter((deck) => deck.units.length);
    if (config.activeDeck[side] && !config.saved[side].some((d) => d.id === config.activeDeck[side])) {
      config.activeDeck[side] = null;
      changed = true;
    }
  }
  if (changed) saveConfig();
}

/** 第一次打开且本地什么都没有：拿牌库前两张当示例阵容 */
function seedDecksIfEmpty() {
  if (config.red.length || config.blue.length) return;
  const ids = library.units.slice(0, 2).map((u) => u.card.id);
  if (!ids.length) return;
  config.red = ids.slice();
  config.blue = ids.slice();
  saveConfig();
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */
export function initTraining() {
  if (initPromise) {
    // 再次进入：重新读一次牌库（编辑器可能刚改过卡）
    return initPromise.then(async () => {
      page.hidden = false;
      scaler?.apply();
      await refreshLibrary();
      renderAll();
    });
  }
  initPromise = (async () => {
    page = $("#training-page");
    stage = $("#training-stage");
    if (!page || !stage) return;
    const loaded = loadConfig();
    config = loaded.config;
    hadStoredConfig = loaded.stored;
    activeSide = config.activeSide === "blue" ? "blue" : "red";

    cacheRefs();
    buildPanels();
    cacheRefs(); // 面板是刚生成的，重新取一次面板内的节点
    bindEvents();
    syncSettings();
    scaler = createStageScaler(page, stage, () => refreshAdaptive());
    page.hidden = false;

    await refreshLibrary();
    renderAll();
  })();
  return initPromise;
}

async function refreshLibrary() {
  const hint = $("#training-hint");
  if (hint) hint.textContent = "正在载入牌库…";
  await loadLibrary();
  sanitizeDecks();
  if (firstLoad && !hadStoredConfig) seedDecksIfEmpty();
  firstLoad = false;
  if (hint) {
    hint.textContent = library.errors.length
      ? `牌库有 ${library.errors.length} 处问题`
      : `牌库 ${library.units.length} 张`;
  }
  if (library.errors.length) console.warn("[训练场] 牌库问题：", library.errors);
}

function cacheRefs() {
  refs.cols = $("#tcfg-cols");
  refs.maxUnits = $("#set-max-units");
  refs.startHint = $("#tstart-hint");
  refs.startBtn = $("#btn-start-battle");
  refs.seg = $("#training-seg");
  refs.pack = $("#training-pack");
  refs.toast = $("#training-toast");
  if (refs.pack) refs.pack.textContent = `卡组：${PACK}`;
  for (const side of SIDES) {
    refs.libList[side] = $(`[data-lib-list="${side}"]`);
    refs.libCount[side] = $(`[data-lib-count="${side}"]`);
    refs.filter[side] = $(`[data-lib-filter="${side}"]`);
    refs.deckList[side] = $(`[data-deck-list="${side}"]`);
    refs.deckCount[side] = $(`[data-deck-count="${side}"]`);
    refs.savedList[side] = $(`[data-saved-list="${side}"]`);
  }
}

function buildPanels() {
  if (!refs.cols) return;
  refs.cols.innerHTML = [
    libPanel("red"),
    deckPanel("red"),
    deckPanel("blue"),
    libPanel("blue"),
  ].join("");
}

function libPanel(side) {
  return `
  <section class="tcfg-panel tcfg-lib" data-lib="${side}">
    <header class="tcfg-head">
      <span class="tw-dot" data-side="${side}"></span>
      <h2>${LIB_LABEL[side]}<em> · ${SIDE_LABEL[side]}</em></h2>
      <span class="tcfg-count" data-lib-count="${side}">0 张</span>
    </header>
    <div class="tlib-filter">
      <input type="search" data-lib-filter="${side}" placeholder="筛选单位…" autocomplete="off" />
    </div>
    <div class="tlib-list" data-lib-list="${side}"></div>
  </section>`;
}

function deckPanel(side) {
  return `
  <section class="tcfg-panel tcfg-deck" data-deck="${side}" data-side="${side}">
    <header class="tcfg-head">
      <span class="tw-dot" data-side="${side}"></span>
      <h2>${SIDE_LABEL[side]}卡组</h2>
      <span class="tcfg-count" data-deck-count="${side}">0 个</span>
      <button class="btn tiny" type="button" data-clear-deck="${side}">清空</button>
    </header>
    <div class="tdeck-current">
      <div class="tdeck-list" data-deck-list="${side}"></div>
    </div>
    <div class="tdeck-saved">
      <div class="tsaved-head">
        <span>已保存卡组</span>
        <button class="btn tiny" type="button" data-save-deck="${side}">＋ 保存当前</button>
      </div>
      <div class="tsaved-list" data-saved-list="${side}"></div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */
function renderAll() {
  if (!library.loaded) return;
  for (const side of SIDES) {
    renderLibrary(side);
    renderDeck(side);
    renderSaved(side);
  }
  syncSettings();
  renderStartHint();
  refreshAdaptive();
}

function countMap(side) {
  const out = new Map();
  for (const id of config[side]) out.set(id, (out.get(id) || 0) + 1);
  return out;
}

function renderLibrary(side) {
  const list = refs.libList[side];
  if (!list) return;
  const needle = (refs.filter[side]?.value || "").trim().toLowerCase();
  const counts = countMap(side);
  const items = library.units.filter(({ card }) => {
    if (!needle) return true;
    return `${card.name} ${card.id}`.toLowerCase().includes(needle);
  });
  if (refs.libCount[side]) refs.libCount[side].textContent = `${items.length} 张`;
  if (!items.length) {
    list.innerHTML = `<p class="tlib-empty">${library.units.length ? "没有匹配的单位" : "牌库里还没有单位"}</p>`;
    return;
  }
  list.innerHTML = items
    .map(({ card }) => {
      const n = counts.get(card.id) || 0;
      const q = QUALITY_LABEL[card.quality] || card.quality;
      return `
      <button type="button" class="tlib-row" data-add="${side}" data-card="${escapeHtml(card.id)}"
              title="${escapeHtml(card.name || card.id)} · ${escapeHtml(card.id)}">
        <img class="tlib-thumb" src="${resolveImage(card.image)}" alt="" loading="lazy" draggable="false"
             onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
        <span class="tlib-text">
          <span class="tlib-name">${escapeHtml(card.name || card.id)}
            <span class="q-tag q-${escapeHtml(card.quality)}">${escapeHtml(q)}</span>
            ${n ? `<span class="tlib-in">已在卡组 ×${n}</span>` : ""}
          </span>
          <span class="tlib-meta">HP ${fmt(card.baseHp)} · ATK ${fmt(card.baseAtk)} · 技能 ${(card.skills || []).length}</span>
        </span>
        <span class="tlib-plus" aria-hidden="true">＋</span>
      </button>`;
    })
    .join("");
}

function deckRowHtml(side, id, index, total) {
  const card = library.byId.get(id)?.card;
  const name = card ? card.name || card.id : `未知单位 ${id}`;
  const meta = card ? `HP ${fmt(card.baseHp)} · ATK ${fmt(card.baseAtk)}` : "这张卡不在当前牌库里";
  return `
  <div class="tdeck-row" data-side="${side}" data-deck-row data-idx="${index}">
    <img class="tdeck-thumb" src="${resolveImage(card?.image)}" alt="" draggable="false"
         onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
    <span class="tlib-text">
      <span class="tdeck-name">${escapeHtml(name)}</span>
      <span class="tdeck-sub">${escapeHtml(meta)}</span>
    </span>
    <span class="tdeck-ops">
      <button class="tdecl-op" type="button" data-move="-1" data-side="${side}" data-idx="${index}"
              title="上移" ${index === 0 ? "disabled" : ""}>↑</button>
      <button class="tdecl-op" type="button" data-move="1" data-side="${side}" data-idx="${index}"
              title="下移" ${index === total - 1 ? "disabled" : ""}>↓</button>
      <button class="tdecl-op is-danger" type="button" data-remove="${side}" data-idx="${index}" title="移出卡组">×</button>
    </span>
    <span class="tdeck-idx">${index + 1}</span>
  </div>`;
}

function renderDeck(side) {
  const list = refs.deckList[side];
  if (!list) return;
  const ids = config[side];
  if (refs.deckCount[side]) refs.deckCount[side].textContent = `${ids.length} 个`;
  if (!ids.length) {
    list.innerHTML = `<p class="tdeck-empty">从${LIB_LABEL[side]}点单位加入。入场顺序就是这里的顺序；超出场上上限的单位会在后续回合补上场。</p>`;
    return;
  }
  list.innerHTML = ids.map((id, i) => deckRowHtml(side, id, i, ids.length)).join("");
}

function sameUnits(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function renderSaved(side) {
  const list = refs.savedList[side];
  if (!list) return;
  const decks = config.saved[side];
  if (!decks.length) {
    list.innerHTML = `<p class="tsaved-empty">还没有保存的卡组。配好阵容后点「＋ 保存当前」。</p>`;
    return;
  }
  list.innerHTML = decks
    .map((deck) => {
      const active = config.activeDeck[side] === deck.id;
      const dirty = active && !sameUnits(config[side], deck.units);
      return `
      <div class="tsaved-row">
        <button class="tsaved-chip ${active ? "is-active" : ""}" type="button" data-load-deck="${side}" data-deck-id="${escapeHtml(deck.id)}">
          <span class="tsaved-name">${escapeHtml(deck.name)}</span>
          ${dirty ? `<span class="tsaved-dirty">· 已修改</span>` : ""}
          <span class="tsaved-count">${deck.units.length} 个</span>
        </button>
        <button class="tsaved-del" type="button" data-del-deck="${side}" data-deck-id="${escapeHtml(deck.id)}" title="删除这个卡组">×</button>
      </div>`;
    })
    .join("");
}

function syncSettings() {
  if (refs.maxUnits) refs.maxUnits.value = String(config.maxUnits);
  const map = {
    redInvincible: $("#set-red-inv"),
    blueInvincible: $("#set-blue-inv"),
    redAI: $("#set-red-ai"),
    blueAI: $("#set-blue-ai"),
  };
  for (const [key, el] of Object.entries(map)) {
    if (!el) continue;
    el.checked = Boolean(config[key]);
    el.closest(".tset")?.classList.toggle("is-on", el.checked);
  }
}

/** 训练场可开战性检查 */
function problemsOf() {
  const problems = [];
  for (const side of SIDES) {
    if (!config[side].length) problems.push(`${SIDE_LABEL[side]}卡组为空`);
  }
  for (const side of SIDES) {
    for (const id of new Set(config[side])) {
      const card = library.byId.get(id)?.card;
      if (!card) {
        problems.push(`卡组里有不存在的单位：${id}`);
        continue;
      }
      for (const sid of card.skills || []) {
        if (!library.registry?.getSkill(sid)) problems.push(`「${card.name}」引用了不存在的技能 ${sid}`);
      }
    }
  }
  return [...new Set(problems)];
}

function renderStartHint() {
  if (!refs.startHint || !refs.startBtn) return;
  const problems = problemsOf();
  if (problems.length) {
    refs.startHint.textContent = problems.slice(0, 2).join("；") + (problems.length > 2 ? "…" : "");
    refs.startHint.classList.add("is-bad");
    refs.startBtn.disabled = true;
    return;
  }
  refs.startHint.classList.remove("is-bad");
  refs.startBtn.disabled = false;
  refs.startHint.textContent = `红 ${config.red.length} · 蓝 ${config.blue.length} 个单位`;
}

/* ------------------------------------------------------------------ */
/* 竖屏 / 横屏切换                                                     */
/* ------------------------------------------------------------------ */
function refreshAdaptive() {
  if (!page || !scaler) return;
  const orient = scaler.orient;
  if (refs.seg) {
    refs.seg.dataset.side = activeSide;
    $$(".tw-seg-btn", refs.seg).forEach((btn) => {
      const on = btn.dataset.side === activeSide;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
  const panels = $$(".tcfg-cols > .tcfg-panel", page);
  const portrait = orient === "portrait";
  for (const panel of panels) {
    const side = panel.dataset.lib || panel.dataset.deck;
    panel.classList.toggle("is-off", portrait && side !== activeSide);
    panel.style.order = "";
    if (portrait) panel.style.order = panel.dataset.lib ? "1" : "2";
  }
}

function setActiveSide(side) {
  if (!SIDES.includes(side) || side === activeSide) return;
  activeSide = side;
  config.activeSide = side;
  saveConfig();
  refreshAdaptive();
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */
function bindEvents() {
  // 牌库筛选
  for (const side of SIDES) {
    refs.filter[side]?.addEventListener("input", () => renderLibrary(side));
  }

  // 面板内所有按钮（牌库加入 / 卡组增删移 / 卡组保存切换删除）
  refs.cols?.addEventListener("click", onColsClick);

  // 设置
  refs.maxUnits?.addEventListener("change", () => {
    const v = clamp(Math.round(Number(refs.maxUnits.value) || 4), 1, MAX_FIELD);
    config.maxUnits = v;
    refs.maxUnits.value = String(v);
    saveConfig();
    renderStartHint();
  });
  const checks = [
    ["redInvincible", "#set-red-inv"],
    ["blueInvincible", "#set-blue-inv"],
    ["redAI", "#set-red-ai"],
    ["blueAI", "#set-blue-ai"],
  ];
  for (const [key, sel] of checks) {
    const el = $(sel);
    el?.addEventListener("change", () => {
      config[key] = el.checked;
      el.closest(".tset")?.classList.toggle("is-on", el.checked);
      saveConfig();
    });
  }

  // 竖屏滑钮
  refs.seg?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tw-seg-btn");
    if (btn) setActiveSide(btn.dataset.side);
  });

  // 开始对战
  refs.startBtn?.addEventListener("click", () => startMatch());

  // 返回主菜单：用 location.hash 触发 app.js 的 hashchange（不要用 <a href="#menu">，
  // 页面带 <base href="./">，fragment 链接会被解析成站点根目录造成整页刷新）
  $("#training-back")?.addEventListener("click", () => {
    location.hash = "#menu";
  });

  // 离开页面时保留现场（localStorage 已实时保存，不用额外处理）
}

function onColsClick(event) {
  const add = event.target.closest("[data-add]");
  if (add) {
    addUnit(add.dataset.add, add.dataset.card);
    return;
  }
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    removeUnit(remove.dataset.remove, Number(remove.dataset.idx));
    return;
  }
  const move = event.target.closest("[data-move]");
  if (move) {
    moveUnit(move.dataset.side, Number(move.dataset.idx), Number(move.dataset.move));
    return;
  }
  const save = event.target.closest("[data-save-deck]");
  if (save) {
    saveCurrentDeck(save.dataset.saveDeck);
    return;
  }
  const load = event.target.closest("[data-load-deck]");
  if (load) {
    loadDeck(load.dataset.loadDeck, load.dataset.deckId);
    return;
  }
  const del = event.target.closest("[data-del-deck]");
  if (del) {
    deleteDeck(del.dataset.delDeck, del.dataset.deckId);
    return;
  }
  const clear = event.target.closest("[data-clear-deck]");
  if (clear) {
    clearDeck(clear.dataset.clearDeck);
  }
}

function addUnit(side, cardId) {
  if (!SIDES.includes(side) || !library.byId.has(cardId)) return;
  if (config[side].length >= MAX_DECK) {
    toast(`卡组最多 ${MAX_DECK} 个单位`);
    return;
  }
  config[side].push(cardId);
  saveConfig();
  renderDeck(side);
  renderLibrary(side);
  renderSaved(side);
  renderStartHint();
  const panel = $(`.tcfg-deck[data-deck="${side}"]`);
  if (panel) {
    panel.classList.add("is-drop-target");
    setTimeout(() => panel.classList.remove("is-drop-target"), 220);
  }
}

function removeUnit(side, index) {
  if (!SIDES.includes(side) || !Number.isInteger(index)) return;
  if (index < 0 || index >= config[side].length) return;
  config[side].splice(index, 1);
  saveConfig();
  renderDeck(side);
  renderLibrary(side);
  renderSaved(side);
  renderStartHint();
}

function moveUnit(side, index, dir) {
  if (!SIDES.includes(side) || !Number.isInteger(index) || !Number.isInteger(dir)) return;
  const list = config[side];
  const to = index + dir;
  if (to < 0 || to >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(to, 0, item);
  saveConfig();
  renderDeck(side);
  renderStartHint();
}

function saveCurrentDeck(side) {
  if (!SIDES.includes(side)) return;
  if (!config[side].length) {
    toast(`${SIDE_LABEL[side]}卡组还是空的`);
    return;
  }
  const n = config.saved[side].length + 1;
  const deck = { id: makeDeckId(), name: `卡组 ${n}`, units: config[side].slice() };
  config.saved[side].push(deck);
  config.activeDeck[side] = deck.id;
  saveConfig();
  renderSaved(side);
  toast(`已保存「${deck.name}」`);
}

function loadDeck(side, deckId) {
  const deck = config.saved[side]?.find((d) => d.id === deckId);
  if (!deck) return;
  config[side] = deck.units.slice(0, MAX_DECK);
  config.activeDeck[side] = deck.id;
  saveConfig();
  renderDeck(side);
  renderLibrary(side);
  renderSaved(side);
  renderStartHint();
  toast(`已切换到「${deck.name}」`);
}

function deleteDeck(side, deckId) {
  if (!config.saved[side]) return;
  const idx = config.saved[side].findIndex((d) => d.id === deckId);
  if (idx < 0) return;
  const [removed] = config.saved[side].splice(idx, 1);
  if (config.activeDeck[side] === deckId) config.activeDeck[side] = null;
  saveConfig();
  renderSaved(side);
  toast(`已删除「${removed.name}」`);
}

function clearDeck(side) {
  if (!config[side].length) return;
  config[side] = [];
  config.activeDeck[side] = null;
  saveConfig();
  renderDeck(side);
  renderLibrary(side);
  renderSaved(side);
  renderStartHint();
}

function toast(text) {
  const el = refs.toast;
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  el.classList.remove("is-in");
  // 强制重启动画
  void el.offsetWidth;
  el.classList.add("is-in");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove("is-in");
  }, 2200);
}

/* ------------------------------------------------------------------ */
/* 开战                                                                */
/* ------------------------------------------------------------------ */
async function startMatch() {
  const problems = problemsOf();
  if (problems.length) {
    toast(problems[0]);
    return;
  }
  const snapshot = {
    maxUnits: config.maxUnits,
    red: config.red.slice(),
    blue: config.blue.slice(),
    redInvincible: Boolean(config.redInvincible),
    blueInvincible: Boolean(config.blueInvincible),
    redAI: Boolean(config.redAI),
    blueAI: Boolean(config.blueAI),
  };
  saveConfig();
  if (refs.startBtn) refs.startBtn.disabled = true;
  try {
    const battle = await import("./training-battle.js");
    battle.openBattle({
      registry: library.registry,
      config: snapshot,
      onExit: () => {
        page.hidden = false;
        scaler?.apply();
        renderAll();
      },
    });
    page.hidden = true;
  } catch (err) {
    console.error("[训练场] 战斗创建失败", err);
    page.hidden = false;
    toast(`战斗创建失败：${String(err.message || err)}`);
    if (refs.startBtn) refs.startBtn.disabled = false;
  }
}
