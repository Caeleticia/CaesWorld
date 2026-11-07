/**
 * library-view.js —— 设计 / 卡牌库
 *
 * 汇总「默认包 + 已启用模组 + 编辑器工程」的单位 / 技能 / 效果，
 * 支持按卡包与关键字筛选。
 */
import { loadContentPacks, DEFAULT_PACK_ID } from "./mods.js";
import { PLACEHOLDER_IMAGE, QUALITY_LABEL, resolveCardImage } from "../engine/index.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const firstChar = (s) => [...String(s || "?")][0] || "?";

let bound = false;
let page = null;
let data = null;
let tab = "units";
let pack = "all";
let search = "";
let loading = false;

export async function initLibrary() {
  page = $("#library-page");
  if (!page) return;
  if (!bound) {
    bound = true;
    $("#library-back")?.addEventListener("click", () => {
      location.hash = "#menu";
    });
    $("#library-refresh")?.addEventListener("click", () => refresh());
    $("#library-pack")?.addEventListener("change", (e) => {
      pack = e.target.value || "all";
      render();
    });
    $("#library-search")?.addEventListener("input", (e) => {
      search = e.target.value.trim().toLowerCase();
      render();
    });
    $$(".sub-tab", page).forEach((btn) => {
      btn.addEventListener("click", () => {
        tab = btn.dataset.libTab || "units";
        $$(".sub-tab", page).forEach((b) => b.classList.toggle("is-active", b === btn));
        render();
      });
    });
  }
  page.hidden = false;
  await refresh();
}

async function refresh() {
  if (loading) return;
  loading = true;
  setStatus("正在读取卡牌…");
  try {
    data = await loadContentPacks({ includeEditor: true });
    renderPackOptions();
    render();
    const errs = data.errors || [];
    const defaultLoaded = data.packs.some((p) => p.packId === DEFAULT_PACK_ID);
    const modCount = data.packs.filter(
      (p) => p.packId !== DEFAULT_PACK_ID && (p.source === "server" || p.source === "local")
    ).length;
    setStatus(
      `${defaultLoaded ? "默认包 + " : ""}${modCount} 个模组` +
        (errs.length ? ` · ${errs.length} 个读取问题` : "")
    );
    if (errs.length) console.warn("[卡牌库] 读取问题：", errs);
  } catch (err) {
    data = null;
    setStatus("读取失败：" + String((err && err.message) || err));
    render();
  } finally {
    loading = false;
  }
}

function setStatus(text) {
  const el = $("#library-status");
  if (el) el.textContent = text ? `· ${text}` : "";
}

function packOptions() {
  const map = new Map();
  for (const list of [data?.units || [], data?.skills || [], data?.effects || []]) {
    for (const card of list) {
      const id = card?.pack || "default";
      if (!map.has(id)) map.set(id, card?.packName || (id === "default" ? "默认包" : id));
    }
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function renderPackOptions() {
  const el = $("#library-pack");
  if (!el) return;
  const opts = packOptions();
  el.innerHTML =
    `<option value="all">全部卡包</option>` +
    opts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}（${escapeHtml(p.id)}）</option>`).join("");
  if (pack !== "all" && !opts.some((p) => p.id === pack)) pack = "all";
  el.value = pack;
}

function matches(card) {
  if (!card) return false;
  if (pack !== "all" && (card.pack || "default") !== pack) return false;
  if (!search) return true;
  return `${card.name || ""} ${card.id || ""}`.toLowerCase().includes(search);
}

function unitCard(card) {
  const q = QUALITY_LABEL[card.quality] || card.quality || "白";
  return `
  <article class="lib-card">
    <img class="lib-card-art" src="${resolveCardImage(card)}" alt="" loading="lazy" draggable="false"
         onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
    <div class="lib-card-main">
      <div class="lib-card-head">
        <strong>${escapeHtml(card.name || card.id)}</strong>
        <span class="lib-card-pack">${escapeHtml(card.packName || card.pack || "默认包")}</span>
      </div>
      <div class="lib-card-id">${escapeHtml(card.id)}</div>
      <div class="lib-card-meta">
        <span>品质 ${escapeHtml(q)}</span>
        <span>HP ${fmt(card.baseHp)}</span>
        <span>ATK ${fmt(card.baseAtk)}</span>
        <span>DEF ${fmt(card.baseDef)}</span>
        <span>技能 ${(card.skills || []).length}</span>
      </div>
    </div>
  </article>`;
}

function skillCard(card) {
  const type = card.type === "passive" ? "被动" : "主动";
  return `
  <article class="lib-card">
    <div class="lib-card-art lib-card-glyph">${escapeHtml(firstChar(card.name || card.id))}</div>
    <div class="lib-card-main">
      <div class="lib-card-head">
        <strong>${escapeHtml(card.name || card.id)}</strong>
        <span class="lib-card-pack">${escapeHtml(card.packName || card.pack || "默认包")}</span>
      </div>
      <div class="lib-card-id">${escapeHtml(card.id)}</div>
      <div class="lib-card-meta"><span>${escapeHtml(type)}</span><span>流程 ${card.flow?.nodes?.length || 0} 块</span></div>
      ${card.description ? `<p class="lib-card-desc">${escapeHtml(card.description)}</p>` : ""}
    </div>
  </article>`;
}

function effectCard(card) {
  const polarity = { positive: "正面", negative: "负面", special: "特殊" }[card.polarity] || "正面";
  const stack = card.stackable ? `层数 ${Number(card.maxStacks) === 0 ? "无上限" : Number(card.maxStacks) || 1}` : "不叠层";
  return `
  <article class="lib-card">
    <div class="lib-card-art lib-card-glyph">${escapeHtml(firstChar(card.name || card.id))}</div>
    <div class="lib-card-main">
      <div class="lib-card-head">
        <strong>${escapeHtml(card.name || card.id)}</strong>
        <span class="lib-card-pack">${escapeHtml(card.packName || card.pack || "默认包")}</span>
      </div>
      <div class="lib-card-id">${escapeHtml(card.id)}</div>
      <div class="lib-card-meta">
        <span>${escapeHtml(polarity)}</span>
        <span>${escapeHtml(stack)}</span>
        <span>触发 ${(card.triggers || []).length}</span>
      </div>
      ${card.description ? `<p class="lib-card-desc">${escapeHtml(card.description)}</p>` : ""}
    </div>
  </article>`;
}

function render() {
  const list = $("#library-list");
  const count = $("#library-count");
  if (!list) return;
  if (!data) {
    list.innerHTML = `<p class="lib-empty">卡牌库尚未载入。</p>`;
    if (count) count.textContent = "0";
    return;
  }
  const source = tab === "skills" ? data.skills : tab === "effects" ? data.effects : data.units;
  const items = (source || []).filter(matches);
  if (count) count.textContent = `${items.length}`;
  if (!items.length) {
    list.innerHTML = `<p class="lib-empty">没有符合条件的${tab === "skills" ? "技能" : tab === "effects" ? "效果" : "单位"}。</p>`;
    return;
  }
  const renderCard = tab === "skills" ? skillCard : tab === "effects" ? effectCard : unitCard;
  list.innerHTML = items.map(renderCard).join("");
}

function fmt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
