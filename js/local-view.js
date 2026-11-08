/**
 * local-view.js —— 游玩 / 同屏：配置界面
 *
 * 同屏采用「抽牌制」：牌库本身就是双方的抽牌池，不在配置界面构筑卡组。
 *   · 牌库 − ban 卡 = 双方各自独立抽的牌池；
 *   · 横屏：牌库 | ban 卡区 | 设置；
 *   · 竖屏：滑钮切换 ban卡 / 设置（初始 ban 卡）。
 *
 * 配置与已保存 ban 卡组单独存 localStorage（caeworld:local:v2）。
 */
import {
  DEFAULT_PACK,
  ContentRegistry,
  resolveCardImage,
  PLACEHOLDER_IMAGE,
  QUALITY_LABEL,
} from "../engine/index.js";
import { loadContentPacks } from "./mods.js";
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

const TABS = ["ban", "settings"];
const PACK = localStorage.getItem("caeworld:editor-pack") || DEFAULT_PACK;
const STORAGE_KEY = "caeworld:local:v2";
const LEGACY_KEY = "caeworld:local:v1";
const MAX_FIELD = 8;
const MAX_HAND = 20;
const MAX_REFILL = 20;

let initPromise = null;
let scaler = null;
let page = null;
let stage = null;
let toastTimer = 0;
let firstLoad = true;
let hadStoredConfig = false;

let config = defaultConfig();
let library = {
  pack: PACK,
  packs: [],
  registry: null,
  units: [],
  byId: new Map(),
  errors: [],
  loaded: false,
};
let activeTab = "ban";
let packFilter = "all";
let needle = "";

const refs = {
  seg: null,
  lib: null,
  libList: null,
  libCount: null,
  filter: null,
  pack: null,
  ban: null,
  banCount: null,
  banList: null,
  savedList: null,
  settings: null,
  maxUnits: null,
  initialDraw: null,
  refillEnabled: null,
  refillEvery: null,
  refillCount: null,
  allowSameName: null,
  redAI: null,
  blueAI: null,
  startHint: null,
  startBtn: null,
  toast: null,
};

function defaultConfig() {
  return {
    v: 2,
    maxUnits: 4,
    initialDraw: 8,
    refillEnabled: true,
    refillEvery: 3,
    refillCount: 2,
    allowSameName: true,
    redAI: false,
    blueAI: false,
    banned: [],
    seededUnavailable: [],
    savedBans: [],
    activeBan: null,
    activeSide: "ban",
    updatedAt: null,
  };
}

function makeId() {
  return `ban_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function sanitizeList(list) {
  return Array.isArray(list) ? list.filter((id) => typeof id === "string" && id) : [];
}

function loadConfig() {
  const fallback = defaultConfig();
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
  } catch {
    /* localStorage 不可用时只用内存状态 */
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
  out.initialDraw = clamp(Math.round(Number(data.initialDraw) || 8), 1, MAX_HAND);
  out.refillEnabled = data.refillEnabled !== false;
  out.refillEvery = clamp(Math.round(Number(data.refillEvery) || 3), 1, 99);
  out.refillCount = clamp(Math.round(Number(data.refillCount) || 2), 0, MAX_REFILL);
  out.allowSameName = data.allowSameName !== false;
  out.redAI = Boolean(data.redAI);
  out.blueAI = Boolean(data.blueAI);
  out.banned = [...new Set(sanitizeList(data.banned))];
  out.seededUnavailable = [...new Set(sanitizeList(data.seededUnavailable))];
  out.savedBans = Array.isArray(data.savedBans)
    ? data.savedBans
        .filter((d) => d && Array.isArray(d.units))
        .map((d) => ({
          id: typeof d.id === "string" && d.id ? d.id : makeId(),
          name: typeof d.name === "string" && d.name ? d.name : "ban 卡组",
          units: [...new Set(sanitizeList(d.units))],
        }))
        .filter((d) => d.units.length)
    : [];
  out.activeBan = typeof data.activeBan === "string" ? data.activeBan : null;
  out.activeSide = TABS.includes(data.activeSide) ? data.activeSide : "ban";
  out.updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;
  return { config: out, stored: true };
}

function saveConfig() {
  config.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn("[同屏] 本地保存失败", err);
  }
}

/* ------------------------------------------------------------------ */
/* 牌库                                                                */
/* ------------------------------------------------------------------ */
async function loadLibrary() {
  const errors = [];
  let content = null;
  try {
    content = await loadContentPacks({ includeEditor: true });
    errors.push(...(content.errors || []));
  } catch (err) {
    errors.push(`牌库读取失败：${String((err && err.message) || err)}`);
    content = { packs: [], units: [], skills: [], effects: [] };
  }

  const registry = new ContentRegistry();
  const res = registry.load({
    units: content.units || [],
    skills: content.skills || [],
    effects: content.effects || [],
  });
  if (!res.ok) {
    for (const fail of res.failed) errors.push(`${fail.kind} ${fail.id || "(无 id)"} 未载入：${fail.errors.join("；")}`);
  }

  const units = [...registry.units.values()].map((card) => ({ card }));
  library = {
    pack: PACK,
    packs: content.packs || [],
    registry,
    units,
    byId: new Map(units.map((u) => [u.card.id, u])),
    errors,
    loaded: true,
  };
}

function validIds() {
  return new Set(library.units.map((u) => u.card.id));
}

function sanitizeConfig() {
  const valid = validIds();
  let changed = false;
  const before = config.banned.length;
  config.banned = [...new Set(config.banned.filter((id) => valid.has(id)))];
  if (config.banned.length !== before) changed = true;
  config.seededUnavailable = config.seededUnavailable.filter((id) => valid.has(id));
  config.savedBans = config.savedBans
    .map((d) => ({ ...d, units: d.units.filter((id) => valid.has(id)) }))
    .filter((d) => d.units.length);
  if (config.activeBan && !config.savedBans.some((d) => d.id === config.activeBan)) {
    config.activeBan = null;
    changed = true;
  }
  if (changed) saveConfig();
}

/** 不可获取的卡第一次出现时自动放进 ban 区；玩家移出后不再自动加回 */
function seedUnavailableBans() {
  const already = new Set(config.seededUnavailable);
  let changed = false;
  for (const { card } of library.units) {
    if (card.obtainable !== false || already.has(card.id)) continue;
    already.add(card.id);
    config.seededUnavailable.push(card.id);
    if (!config.banned.includes(card.id)) config.banned.push(card.id);
    changed = true;
  }
  if (changed) saveConfig();
}

/* ------------------------------------------------------------------ */
/* 抽牌池 / 初始化                                                     */
/* ------------------------------------------------------------------ */
function cardSkillOk(card) {
  return (card.skills || []).every((sid) => Boolean(library.registry?.getSkill(sid)));
}

/** 双方的抽牌池：牌库 − ban；技能缺失的卡无法安全上场，抽牌池里跳过。 */
function poolUnits() {
  return library.units.filter(({ card }) => !config.banned.includes(card.id) && cardSkillOk(card));
}

function invalidPoolUnits() {
  return library.units.filter(({ card }) => !config.banned.includes(card.id) && !cardSkillOk(card));
}

function poolIds() {
  return poolUnits().map(({ card }) => card.id);
}

export function initLocal() {
  if (initPromise) {
    return initPromise.then(async () => {
      page.hidden = false;
      scaler?.apply();
      await refreshLibrary();
      renderAll();
    });
  }
  initPromise = (async () => {
    page = $("#play-page");
    stage = $("#play-stage");
    if (!page || !stage) return;
    const loaded = loadConfig();
    config = loaded.config;
    hadStoredConfig = loaded.stored;
    activeTab = config.activeSide === "settings" ? "settings" : "ban";

    cacheRefs();
    bindEvents();
    syncSettings();
    scaler = createStageScaler(page, stage, () => {
      refreshAdaptive();
      if (library.loaded) renderAll();
    });
    page.hidden = false;

    await refreshLibrary();
    renderAll();
    preheatBattle();
  })();
  return initPromise;
}

async function refreshLibrary() {
  const hint = $("#play-hint");
  if (hint) hint.textContent = "正在载入牌库…";
  await loadLibrary();
  sanitizeConfig();
  seedUnavailableBans();
  firstLoad = false;
  if (hint) {
    hint.textContent = library.errors.length ? `牌库有 ${library.errors.length} 处问题` : `牌库 ${library.units.length} 张`;
  }
  if (library.errors.length) console.warn("[同屏] 牌库问题：", library.errors);
}

function cacheRefs() {
  refs.seg = $("#play-seg");
  refs.lib = $("#pcfg-lib");
  refs.libList = $("#pcfg-lib-list");
  refs.libCount = $("#pcfg-lib-count");
  refs.filter = $("#pcfg-filter");
  refs.pack = $("#pcfg-pack");
  refs.ban = $("#pcfg-ban");
  refs.banCount = $("#pcfg-ban-count");
  refs.banList = $("#pcfg-ban-list");
  refs.savedList = $("#pcfg-saved-list");
  refs.settings = $("#pcfg-settings");
  refs.maxUnits = $("#pcfg-max");
  refs.initialDraw = $("#pcfg-initial");
  refs.refillEnabled = $("#pcfg-refill");
  refs.refillEvery = $("#pcfg-refill-every");
  refs.refillCount = $("#pcfg-refill-count");
  refs.allowSameName = $("#pcfg-samename");
  refs.redAI = $("#pcfg-red-ai");
  refs.blueAI = $("#pcfg-blue-ai");
  refs.startHint = $("#pcfg-start-hint");
  refs.startBtn = $("#pcfg-start");
  refs.toast = $("#play-toast");
  if ($("#play-pack")) $("#play-pack").textContent = `牌库：${PACK}`;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */
function renderAll() {
  if (!library.loaded) return;
  renderPackFilter();
  renderLibrary();
  renderBan();
  syncSettings();
  renderStartHint();
  refreshAdaptive();
}

function packOptions() {
  const map = new Map();
  for (const { card } of library.units) {
    const id = card.pack || "default";
    if (!map.has(id)) map.set(id, card.packName || (id === "default" ? "默认包" : id));
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function renderPackFilter() {
  if (!refs.pack) return;
  const opts = packOptions();
  if (packFilter !== "all" && !opts.some((p) => p.id === packFilter)) packFilter = "all";
  refs.pack.innerHTML =
    `<option value="all">全部卡包</option>` +
    opts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  refs.pack.value = packFilter;
}

function renderLibrary() {
  if (!refs.libList) return;
  const items = library.units.filter(({ card }) => {
    if (packFilter !== "all" && (card.pack || "default") !== packFilter) return false;
    if (!needle) return true;
    return `${card.name} ${card.id}`.toLowerCase().includes(needle);
  });
  if (refs.libCount) refs.libCount.textContent = `${items.length} 张`;
  if (!items.length) {
    refs.libList.innerHTML = `<p class="tlib-empty">${library.units.length ? "没有匹配的单位" : "牌库里还没有单位"}</p>`;
    return;
  }
  refs.libList.innerHTML = items
    .map(({ card }) => {
      const q = QUALITY_LABEL[card.quality] || card.quality;
      const banned = config.banned.includes(card.id);
      const invalid = !cardSkillOk(card);
      const tags = [
        card.obtainable === false ? `<span class="lbt-tag is-locked">不可获取</span>` : "",
        banned ? `<span class="lbt-tag is-ban">已 ban</span>` : "",
        invalid ? `<span class="lbt-tag is-locked">技能缺失 · 不抽</span>` : "",
      ].join("");
      return `
      <button type="button" class="tlib-row ${banned ? "is-banned" : ""}" data-card="${escapeHtml(card.id)}"
              title="${escapeHtml(card.name || card.id)} · 点击${banned ? "移出 ban" : "加入 ban"}">
        <img class="tlib-thumb" src="${resolveCardImage(card)}" alt="" loading="lazy" draggable="false"
             onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
        <span class="tlib-text">
          <span class="tlib-name">${escapeHtml(card.name || card.id)}
            <span class="q-tag q-${escapeHtml(card.quality)}">${escapeHtml(q)}</span>
          </span>
          <span class="tlib-meta">HP ${fmt(card.baseHp)} · ATK ${fmt(card.baseAtk)} · 技能 ${(card.skills || []).length}${tags}</span>
        </span>
        <span class="tlib-plus" aria-hidden="true">${banned ? "×" : "＋"}</span>
      </button>`;
    })
    .join("");
}

function renderBan() {
  if (!refs.banList) return;
  const ids = config.banned;
  if (refs.banCount) refs.banCount.textContent = `${ids.length} 张`;
  if (!ids.length) {
    refs.banList.innerHTML = `<p class="tdeck-empty">ban 卡区为空。点牌库里的单位加入 / 移出 ban 区。</p>`;
  } else {
    refs.banList.innerHTML = ids
      .map((id, i) => {
        const card = library.byId.get(id)?.card;
        const name = card ? card.name || card.id : id;
        return `
        <div class="tdeck-row pcfg-ban-row" data-side="ban" data-ban-row data-idx="${i}">
          <img class="tdeck-thumb" src="${resolveCardImage(card)}" alt="" draggable="false"
               onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
          <span class="tlib-text">
            <span class="tdeck-name">${escapeHtml(name)}</span>
            <span class="tdeck-sub">${card ? `HP ${fmt(card.baseHp)} · ATK ${fmt(card.baseAtk)}` : "这张卡不在当前牌库里"}</span>
          </span>
          <span class="tdeck-ops">
            <button class="tdecl-op is-danger" type="button" data-unban="${escapeHtml(id)}" title="移出 ban 区">×</button>
          </span>
          <span class="tdeck-idx">${i + 1}</span>
        </div>`;
      })
      .join("");
  }

  if (!refs.savedList) return;
  if (!config.savedBans.length) {
    refs.savedList.innerHTML = `<p class="tsaved-empty">还没有保存的 ban 卡组。配好 ban 区后点「＋ 保存当前」。</p>`;
    return;
  }
  refs.savedList.innerHTML = config.savedBans
    .map((deck) => {
      const active = config.activeBan === deck.id;
      const dirty = active && !sameList(config.banned, deck.units);
      return `
      <div class="tsaved-row">
        <button class="tsaved-chip ${active ? "is-active" : ""}" type="button" data-load-ban="${escapeHtml(deck.id)}">
          <span class="tsaved-name">${escapeHtml(deck.name)}</span>
          ${dirty ? `<span class="tsaved-dirty">· 已修改</span>` : ""}
          <span class="tsaved-count">${deck.units.length} 张</span>
        </button>
        <button class="tsaved-del" type="button" data-del-ban="${escapeHtml(deck.id)}" title="删除这个 ban 卡组">×</button>
      </div>`;
    })
    .join("");
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

function syncSettings() {
  if (refs.maxUnits) refs.maxUnits.value = String(config.maxUnits);
  if (refs.initialDraw) refs.initialDraw.value = String(config.initialDraw);
  if (refs.refillEnabled) refs.refillEnabled.checked = Boolean(config.refillEnabled);
  if (refs.refillEvery) refs.refillEvery.value = String(config.refillEvery);
  if (refs.refillCount) refs.refillCount.value = String(config.refillCount);
  if (refs.allowSameName) refs.allowSameName.checked = Boolean(config.allowSameName);
  if (refs.redAI) refs.redAI.checked = Boolean(config.redAI);
  if (refs.blueAI) refs.blueAI.checked = Boolean(config.blueAI);
  for (const el of [refs.refillEnabled, refs.allowSameName, refs.redAI, refs.blueAI]) {
    el?.closest(".tset")?.classList.toggle("is-on", Boolean(el.checked));
  }
  for (const el of $$(".pcfg-refill-only", page)) el.hidden = !config.refillEnabled;
}

function problemsOf() {
  const problems = [];
  if (!poolIds().length) problems.push("抽牌池为空：牌库里的卡都被 ban 了，或全部缺少技能");
  return problems;
}

function renderStartHint() {
  if (!refs.startHint || !refs.startBtn) return;
  const problems = problemsOf();
  if (problems.length) {
    refs.startHint.textContent = problems[0];
    refs.startHint.classList.add("is-bad");
    refs.startBtn.disabled = true;
    return;
  }
  refs.startHint.classList.remove("is-bad");
  refs.startBtn.disabled = false;
  const bad = invalidPoolUnits().length;
  refs.startHint.textContent = `可抽 ${poolIds().length} 张 · ban ${config.banned.length} 张${bad ? ` · 跳过 ${bad} 张技能缺失` : ""}`;
}

/* ------------------------------------------------------------------ */
/* 自适应                                                              */
/* ------------------------------------------------------------------ */
function refreshAdaptive() {
  if (!page || !scaler) return;
  const portrait = scaler.orient === "portrait";
  if (refs.seg) {
    refs.seg.dataset.side = activeTab;
    const thumb = refs.seg.querySelector(".tw-seg-thumb");
    if (thumb) {
      const idx = Math.max(0, TABS.indexOf(activeTab));
      thumb.style.transform = "none";
      thumb.style.left = `calc(${idx * 50}% + 3px)`;
    }
    $$(".tw-seg-btn", refs.seg).forEach((btn) => {
      const on = btn.dataset.side === activeTab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
  $$(".pcfg-panel", page).forEach((panel) => panel.classList.remove("is-off"));
  if (portrait) {
    if (refs.lib) refs.lib.classList.toggle("is-off", activeTab === "settings");
    if (refs.ban) refs.ban.classList.toggle("is-off", activeTab === "settings");
    if (refs.settings) refs.settings.classList.toggle("is-off", activeTab !== "settings");
  }
}

function setActiveTab(tab) {
  if (!TABS.includes(tab) || tab === activeTab) return;
  activeTab = tab;
  config.activeSide = tab;
  saveConfig();
  refreshAdaptive();
  renderAll();
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */
function bindEvents() {
  refs.seg?.addEventListener("click", (event) => {
    const btn = event.target.closest(".tw-seg-btn");
    if (btn) setActiveTab(btn.dataset.side);
  });

  refs.filter?.addEventListener("input", () => {
    needle = (refs.filter.value || "").trim().toLowerCase();
    renderLibrary();
  });
  refs.pack?.addEventListener("change", () => {
    packFilter = refs.pack.value || "all";
    renderLibrary();
  });

  refs.libList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-card]");
    if (row) toggleBan(row.dataset.card);
  });

  refs.banList?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-unban]");
    if (btn) toggleBan(btn.dataset.unban);
  });
  refs.savedList?.addEventListener("click", (event) => {
    const load = event.target.closest("[data-load-ban]");
    if (load) return loadBanGroup(load.dataset.loadBan);
    const del = event.target.closest("[data-del-ban]");
    if (del) return deleteBanGroup(del.dataset.delBan);
  });
  $("#pcfg-save-ban")?.addEventListener("click", saveBanGroup);
  $("#pcfg-ban-clear")?.addEventListener("click", () => {
    if (!config.banned.length) return;
    config.banned = [];
    config.activeBan = null;
    saveConfig();
    renderAll();
  });

  const numberSettings = [
    [refs.maxUnits, "maxUnits", 1, MAX_FIELD],
    [refs.initialDraw, "initialDraw", 1, MAX_HAND],
    [refs.refillEvery, "refillEvery", 1, 99],
    [refs.refillCount, "refillCount", 0, MAX_REFILL],
  ];
  for (const [el, key, min, max] of numberSettings) {
    el?.addEventListener("change", () => {
      const fallback = key === "maxUnits" ? 4 : key === "initialDraw" ? 8 : key === "refillEvery" ? 3 : 2;
      const v = Math.round(Number(el.value) || fallback);
      config[key] = clamp(v, min, max);
      el.value = String(config[key]);
      saveConfig();
      renderStartHint();
    });
  }
  const checkSettings = [
    [refs.refillEnabled, "refillEnabled"],
    [refs.allowSameName, "allowSameName"],
    [refs.redAI, "redAI"],
    [refs.blueAI, "blueAI"],
  ];
  for (const [el, key] of checkSettings) {
    el?.addEventListener("change", () => {
      config[key] = el.checked;
      el.closest(".tset")?.classList.toggle("is-on", el.checked);
      saveConfig();
      syncSettings();
      renderStartHint();
    });
  }

  refs.startBtn?.addEventListener("click", startMatch);
  $("#play-back")?.addEventListener("click", () => {
    location.hash = "#menu";
  });
}

function toggleBan(cardId) {
  if (!library.byId.has(cardId)) return;
  const idx = config.banned.indexOf(cardId);
  if (idx >= 0) {
    config.banned.splice(idx, 1);
    toast(`已移出 ban：${library.byId.get(cardId)?.card.name || cardId}`);
  } else {
    config.banned.push(cardId);
    toast(`已 ban：${library.byId.get(cardId)?.card.name || cardId}`);
  }
  config.activeBan = null;
  saveConfig();
  renderAll();
}

function saveBanGroup() {
  if (!config.banned.length) {
    toast("ban 卡区还是空的");
    return;
  }
  const deck = { id: makeId(), name: `ban 组 ${config.savedBans.length + 1}`, units: config.banned.slice() };
  config.savedBans.push(deck);
  config.activeBan = deck.id;
  saveConfig();
  renderAll();
  toast(`已保存「${deck.name}」`);
}

function loadBanGroup(id) {
  const deck = config.savedBans.find((d) => d.id === id);
  if (!deck) return;
  config.banned = deck.units.slice();
  config.activeBan = deck.id;
  saveConfig();
  renderAll();
  toast(`已切换到「${deck.name}」`);
}

function deleteBanGroup(id) {
  const idx = config.savedBans.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const [removed] = config.savedBans.splice(idx, 1);
  if (config.activeBan === id) config.activeBan = null;
  saveConfig();
  renderAll();
  toast(`已删除「${removed.name}」`);
}

function toast(text) {
  const el = refs.toast;
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  el.classList.remove("is-in");
  void el.offsetWidth;
  el.classList.add("is-in");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove("is-in");
  }, 2200);
}

/* ------------------------------------------------------------------ */
/* 战斗模块懒加载                                                      */
/* ------------------------------------------------------------------ */
const BATTLE_URL = "./local-battle.js";
const BATTLE_RETRY_DELAYS = [200, 600];
let battleModule = null;

function importBattle(attempt = 0) {
  if (battleModule) return Promise.resolve(battleModule);
  const url = attempt ? `${BATTLE_URL}?r=${attempt}` : BATTLE_URL;
  return import(url).then(
    (mod) => {
      battleModule = mod;
      return mod;
    },
    (err) => {
      const delay = BATTLE_RETRY_DELAYS[attempt];
      if (delay == null) throw err;
      return new Promise((resolve) => setTimeout(resolve, delay)).then(() => importBattle(attempt + 1));
    },
  );
}

function preheatBattle() {
  if (battleModule) return;
  importBattle().catch(() => {
    /* 预热失败不打扰用户：开战时还会再试 */
  });
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
  const ids = poolIds();
  if (!ids.length) {
    toast("抽牌池为空");
    return;
  }
  const snapshot = {
    maxUnits: config.maxUnits,
    initialHand: config.initialDraw,
    refillEnabled: Boolean(config.refillEnabled),
    refillEvery: config.refillEvery,
    refillCount: config.refillCount,
    allowSameName: Boolean(config.allowSameName),
    redAI: Boolean(config.redAI),
    blueAI: Boolean(config.blueAI),
    // 抽牌制：双方各有一份「牌库 − ban」的独立抽牌池
    red: ids.slice(),
    blue: ids.slice(),
  };
  saveConfig();
  if (refs.startBtn) refs.startBtn.disabled = true;
  let battle;
  try {
    battle = await importBattle();
  } catch (err) {
    console.error("[同屏] 战斗模块加载失败", err);
    page.hidden = false;
    toast("战斗模块加载失败，刷新页面后重试");
    if (refs.startBtn) refs.startBtn.disabled = false;
    return;
  }
  try {
    battle.openLocalBattle({
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
    console.error("[同屏] 战斗创建失败", err);
    page.hidden = false;
    toast(`战斗创建失败：${String(err.message || err)}`);
    if (refs.startBtn) refs.startBtn.disabled = false;
  }
}
