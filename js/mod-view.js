/**
 * mod-view.js —— 卡包 / 卡包管理
 *
 * 一个「卡包 id」只显示一行：编辑器里的副本、本地导入、服务器文件合并成同一个卡包。
 *   · 服务器存在同 id 的卡包 → 标为「服务端」（可更新）
 *   · 否则                     → 标为「本地」
 *
 * 每行按钮固定为：启用·停用 / 内容 / 导出 / 另存为 / 更新（仅服务端）/ 删除。
 * 启用状态按卡包记录（旧的按文件名 / editor:<id> 的键会在下次切换时归并掉）。
 * 「更新」不做版本比较，但会先确认删除所有本地修改，再同步为服务端最新版本。
 * 「另存为」把当前内容复制到一个新 id，存成本地卡包（默认停用）。
 */
import {
  MODS_INDEX,
  loadAllMods,
  loadServerMods,
  loadEditorPacks,
  forceUpdateServerPack,
  setPackEnabled,
  isPackEnabled,
  importModFile,
  removeLocalMod,
  removeLocalPacks,
  removeServerModCache,
  restoreServerMods,
  requestEditorPack,
  exportPackFile,
  savePackAsLocal,
} from "./mods.js";
import { isValidPackId, resolveCardImage, PLACEHOLDER_IMAGE } from "../engine/index.js";
import { renderCardsHtml, renderCardDetail } from "./library-view.js";
import { edit } from "./editor-view.js";

const $ = (sel, root = document) => root.querySelector(sel);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const errText = (err) => String((err && err.message) || err);

let bound = false;
let page = null;
let rows = [];
let errors = [];
let loading = false;
let contentRow = null;

export async function initModManager() {
  page = $("#mod-page");
  if (!page) return;
  if (!bound) {
    bound = true;
    $("#mod-back")?.addEventListener("click", () => {
      location.hash = "#menu";
    });
    $("#mod-refresh")?.addEventListener("click", async () => {
      if (loading) return;
      // 「刷新」把本页删掉的服务器卡包放回清单，并强制重新下载全部服务端文件
      restoreServerMods();
      await refresh({ force: true });
    });
    $("#mod-import")?.addEventListener("click", () => $("#mod-file")?.click());
    $("#mod-file")?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      setStatus(`正在导入「${file.name}」…`);
      const res = await importModFile(file);
      if (!res.ok) {
        setStatus(`导入失败：${res.error}`);
        return;
      }
      setStatus(`已导入「${res.mod.name}」，默认启用`);
      await refresh();
    });
    $("#mod-list")?.addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-mod-action]");
      if (!btn) return;
      const row = rowOfKey(btn.dataset.modKey);
      if (!row) return;
      const action = btn.dataset.modAction;
      if (action === "content") openContent(row);
      else if (action === "export") await exportRow(row);
      else if (action === "update") await updateRow(row);
      else if (action === "delete") await deleteRow(row);
      else if (action === "save-as") await saveAsRow(row);
    });
    $("#mod-list")?.addEventListener("change", (event) => {
      const toggle = event.target.closest("input[data-mod-toggle]");
      if (!toggle) return;
      const row = rowOfKey(toggle.dataset.modToggle);
      if (!row) return;
      toggleRow(row, Boolean(toggle.checked));
    });
    $("#mod-content-close")?.addEventListener("click", closeContent);
    $("#mod-content-modal")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeContent();
    });
    // 「内容」里的卡片按卡牌库样式展示，点开就是卡牌库同款详情
    $("#mod-content-body")?.addEventListener("click", (e) => {
      const card = e.target.closest("[data-card-kind]");
      if (!card) return;
      openModDetail(card.dataset.cardKind, card.dataset.cardId);
    });
    $("#mod-content-body")?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest("[data-card-kind]");
      if (!card) return;
      e.preventDefault();
      openModDetail(card.dataset.cardKind, card.dataset.cardId);
    });
    $("#mod-detail")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget || e.target.closest("[data-close-detail]")) {
        closeModDetail();
        return;
      }
      const opener = e.target.closest("[data-open-kind]");
      if (!opener) return;
      e.preventDefault();
      openModDetail(opener.dataset.openKind, opener.dataset.openId);
    });
    $("#mod-content-edit")?.addEventListener("click", () => {
      if (!contentRow || !contentRow.packId) return;
      // 任意卡包都能进编辑器：编辑器会先同步所有卡包，再把这张包选为「编辑中卡包」
      requestEditorPack(contentRow.packId);
      closeContent();
      location.hash = "#editor";
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#mod-detail")?.hidden) {
        closeModDetail();
        return;
      }
      if (!$("#mod-content-modal")?.hidden) closeContent();
    });
  }
  page.hidden = false;
  await refresh();
}

/* ------------------------------------------------------------------ */
/* 读取 / 状态                                                          */
/* ------------------------------------------------------------------ */

async function refresh({ force = false } = {}) {
  if (loading) return;
  loading = true;
  closeContent();
  setStatus("正在读取卡包…");
  try {
    let modsRes = { mods: [], errors: [] };
    let serverRes = { mods: [], errors: [] };
    try {
      modsRes = await loadAllMods({ includeDisabled: true, force });
    } catch (err) {
      modsRes = { mods: [], errors: [`卡包读取失败：${errText(err)}`] };
    }
    // 单独再取一次服务器清单：同文件名被本地副本盖掉时，仍然要能标成「服务端」并允许更新
    try {
      serverRes = await loadServerMods();
    } catch {
      serverRes = { mods: [], errors: [] };
    }
    const editor = loadEditorPacks();
    rows = buildRows(modsRes.mods, serverRes.mods, editor.packs);
    errors = [...(modsRes.errors || []), ...(editor.errors || [])];
    render();
    setStatus(statusText());
    if (errors.length) console.warn("[卡包管理] 读取问题：", errors);
  } catch (err) {
    rows = [];
    errors = [errText(err)];
    render();
    setStatus("读取失败：" + errors[0]);
  } finally {
    loading = false;
  }
}

/** 合并同一 id 的卡：后面的来源覆盖前面的（服务端 → 本地 → 编辑器） */
function mergeCards(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const card of Array.isArray(list) ? list : []) {
      if (card && typeof card === "object" && card.id) map.set(card.id, card);
    }
  }
  return [...map.values()];
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function firstVersion(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

/** 把「同一卡包的所有来源」合并成一行 */
function buildRows(mods, serverMods, editorPacks) {
  const groups = new Map();
  const ensure = (packId) => {
    const id = String(packId || "").trim();
    if (!id) return null;
    if (!groups.has(id)) groups.set(id, { packId: id, server: null, local: null, editor: null });
    return groups.get(id);
  };
  for (const mod of mods || []) {
    if (!mod) continue;
    const group = ensure(mod.packId || mod.id);
    if (!group) continue;
    if (mod.source === "server") group.server = group.server || mod;
    else group.local = group.local || mod;
  }
  for (const mod of serverMods || []) {
    if (!mod) continue;
    const group = ensure(mod.packId || mod.id);
    if (group) group.server = group.server || mod;
  }
  for (const pack of editorPacks || []) {
    if (!pack || !pack.id) continue;
    const group = ensure(pack.id);
    if (group) group.editor = pack;
  }
  return [...groups.values()]
    .map(rowOfGroup)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function rowOfGroup(group) {
  const { packId, server, local, editor: editorPack } = group;
  const units = mergeCards(server && server.units, local && local.units, editorPack && editorPack.units);
  const skills = mergeCards(server && server.skills, local && local.skills, editorPack && editorPack.skills);
  const effects = mergeCards(server && server.effects, local && local.effects, editorPack && editorPack.effects);
  const name = firstText(editorPack && editorPack.name, local && local.name, server && server.name, packId);
  const version = firstVersion(
    editorPack && editorPack.version,
    local && local.version,
    server && server.version,
    1
  );
  const description = firstText(
    editorPack && editorPack.description,
    local && local.description,
    server && server.description
  );
  const readme = firstText(local && local.readme, server && server.readme);
  const images = (local && local.images) || (server && server.images) || [];
  const icons = (local && local.icons) || (server && server.icons) || { skill: [], effect: [] };
  const warnings = [
    ...new Set([...((server && server.warnings) || []), ...((local && local.warnings) || [])]),
  ];
  const aliasKeys = [server && server.id, local && local.id, `editor:${packId}`].filter(Boolean);
  const editorCardCount =
    ((editorPack && editorPack.units) || []).length +
    ((editorPack && editorPack.skills) || []).length +
    ((editorPack && editorPack.effects) || []).length;
  const packFile = {
    schema: 1,
    kind: "caeworld-pack",
    id: packId,
    name,
    version,
    author: (editorPack && editorPack.author) || "",
    description,
    updatedAt: null,
    units,
    skills,
    effects,
  };
  return {
    key: packId,
    packId,
    name,
    version,
    description,
    label: server ? "服务端" : "本地",
    cls: server ? "is-server" : "is-local",
    server: server || null,
    local: local || null,
    editorPack: editorPack || null,
    aliasKeys,
    enabled: isPackEnabled(packId, aliasKeys),
    editorCopy: editorCardCount > 0,
    localCopy: Boolean(local) || editorCardCount > 0,
    fileLabel: (server && server.fileName) || (local && local.fileName) || "编辑器工程",
    readme,
    images,
    warnings,
    counts: {
      units: units.length,
      skills: skills.length,
      effects: effects.length,
      art: images.length,
      icons: ((icons.skill || []).length + (icons.effect || []).length) || 0,
    },
    packFile,
  };
}

function rowOfKey(key) {
  return rows.find((row) => row.key === key) || null;
}

function setStatus(text) {
  const el = $("#mod-status");
  if (el) el.textContent = text ? `· ${text}` : "";
}

/** 列表状态栏：一个卡包一行，按服务端 / 本地计数 */
function statusText() {
  const enabled = rows.filter((r) => r.enabled).length;
  const server = rows.filter((r) => r.server).length;
  return (
    `${rows.length} 个卡包（服务端 ${server} · 本地 ${rows.length - server}） · 启用 ${enabled}` +
    (errors.length ? ` · ${errors.length} 个读取问题` : "")
  );
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function countsText(row) {
  const c = row.counts;
  return (
    `单位 ${c.units} · 技能 ${c.skills} · 效果 ${c.effects}` +
    (c.art ? ` · 卡面 ${c.art}` : "") +
    (c.icons ? ` · 图标 ${c.icons}` : "")
  );
}

/** 行内一行卡面：只取有真实图片的单位卡，横向滚动 */
function renderArtRow(row) {
  const units = (row.packFile.units || []).filter(Boolean);
  const shots = [];
  let total = 0;
  for (const card of units) {
    const url = resolveCardImage(card);
    if (!url || url === PLACEHOLDER_IMAGE) continue;
    total += 1;
    if (shots.length >= 12) continue;
    const name = card.name || card.id || "";
    shots.push(
      `<img class="mod-art-thumb" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" title="${escapeHtml(
        name
      )}" loading="lazy" draggable="false" onerror="this.onerror=null;this.remove()" />`
    );
  }
  if (!shots.length) return "";
  const more = total - shots.length;
  return `<div class="mod-art-row">${shots.join("")}${
    more > 0 ? `<span class="mod-art-more">+${more}</span>` : ""
  }</div>`;
}

function renderWarnings(row) {
  const list = (row.warnings || []).filter(Boolean);
  if (!list.length) return "";
  const shown = list.slice(0, 2);
  return `<div class="mod-warn">${shown.map((w) => escapeHtml(w)).join("<br>")}${
    list.length > shown.length ? `<br>…另有 ${list.length - shown.length} 条` : ""
  }</div>`;
}

function renderErrors() {
  if (!errors.length) return "";
  return `<article class="mod-row is-off"><div class="mod-row-main"><div class="mod-row-head"><strong>读取问题</strong></div><p class="mod-desc">${errors
    .map((e) => escapeHtml(e))
    .join("\n")}</p></div></article>`;
}

function render() {
  const list = $("#mod-list");
  if (!list) return;
  if (!rows.length) {
    list.innerHTML =
      `<p class="lib-empty">还没有卡包。把 ZIP 放进 <code>mods/</code> 并写进 <code>${escapeHtml(
        MODS_INDEX
      )}</code>，或点右上角「导入模组」；编辑器里的卡包也会显示在这里。</p>` + renderErrors();
    return;
  }
  list.innerHTML =
    rows
      .map((row) => {
        const key = escapeHtml(row.key);
        return `
      <article class="mod-row ${row.enabled ? "" : "is-off"}">
        <div class="mod-row-main">
          <div class="mod-row-head">
            <strong>${escapeHtml(row.name)}</strong>
            ${row.version ? `<span class="mod-version">v${escapeHtml(row.version)}</span>` : ""}
            <span class="mod-source ${row.cls}">${escapeHtml(row.label)}</span>
            <span class="mod-file" title="卡包 id">${escapeHtml(row.packId)}</span>
            <span class="mod-file" title="来源文件">${escapeHtml(row.fileLabel)}</span>
            ${row.server && row.localCopy ? `<span class="mod-file" title="更新会删除这些本地副本">含本地副本</span>` : ""}
          </div>
          ${row.description ? `<p class="mod-desc">${escapeHtml(row.description)}</p>` : ""}
          <div class="mod-meta">${escapeHtml(countsText(row))}</div>
          ${renderArtRow(row)}
          ${renderWarnings(row)}
        </div>
        <div class="mod-ops">
          <label class="mod-enable ${row.enabled ? "is-on" : ""}" title="停用后这个卡包不再参与战斗 / 卡牌库 / 训练场；不会删除内容">
            <input type="checkbox" data-mod-toggle="${key}" ${row.enabled ? "checked" : ""} />
            ${row.enabled ? "已启用" : "已停用"}
          </label>
          <button class="btn tiny" type="button" data-mod-action="content" data-mod-key="${key}">内容</button>
          <button class="btn tiny" type="button" data-mod-action="export" data-mod-key="${key}">导出</button>
          <button class="btn tiny" type="button" data-mod-action="save-as" data-mod-key="${key}" title="复制到一个新 id，默认停用">另存为</button>
          ${
            row.server
              ? `<button class="btn tiny" type="button" data-mod-action="update" data-mod-key="${key}" title="删除本地修改并同步为服务器最新版本">更新</button>`
              : ""
          }
          <button class="btn tiny danger" type="button" data-mod-action="delete" data-mod-key="${key}" title="${deleteTitle(
            row
          )}">删除</button>
        </div>
      </article>`;
      })
      .join("") + renderErrors();
}

function deleteTitle(row) {
  return row.server
    ? "删除本机的本地副本与浏览器缓存；服务器文件不受影响"
    : "从本机删除这个卡包";
}

/* ------------------------------------------------------------------ */
/* 内容                                                                */
/* ------------------------------------------------------------------ */

function contentSection(title, kind, cards) {
  if (!cards.length) return "";
  return `<section class="mod-content-sec">
    <h3>${escapeHtml(title)}<small>${cards.length}</small></h3>
    ${renderCardsHtml(kind, cards)}
  </section>`;
}

/** 详情用的卡池：所有卡包合并后的内容（跨包挂载 / 关联也能查到） */
function detailContext() {
  const units = [];
  const skills = [];
  const effects = [];
  for (const row of rows) {
    units.push(...row.packFile.units);
    skills.push(...row.packFile.skills);
    effects.push(...row.packFile.effects);
  }
  return { units, skills, effects, titleId: "mod-detail-title" };
}

/** 打开一张卡的详情（复用卡牌库的详情渲染） */
function openModDetail(kind, id) {
  const modal = $("#mod-detail");
  const sheet = $("#mod-detail-sheet");
  if (!modal || !sheet) return;
  const ctx = detailContext();
  const list = kind === "skills" ? ctx.skills : kind === "effects" ? ctx.effects : ctx.units;
  const card = (list || []).find((item) => item && item.id === id);
  if (!card) return;
  sheet.innerHTML = renderCardDetail(kind, card, ctx);
  modal.hidden = false;
  const body = sheet.querySelector(".lib-detail-body");
  if (body) body.scrollTop = 0;
  sheet.querySelector("[data-close-detail]")?.focus();
}

function closeModDetail() {
  const modal = $("#mod-detail");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  const sheet = $("#mod-detail-sheet");
  if (sheet) sheet.innerHTML = "";
}

function openContent(row) {
  const modal = $("#mod-content-modal");
  const body = $("#mod-content-body");
  if (!modal || !body) return;
  contentRow = row;
  $("#mod-content-title").textContent = row.name;
  const head = [
    `<div class="mod-content-head">${escapeHtml(row.label)} · 卡包 id <code>${escapeHtml(row.packId)}</code>` +
      (row.server ? ` · 服务器文件 <code>${escapeHtml(row.server.fileName)}</code>` : "") +
      (row.local ? ` · 本地文件 <code>${escapeHtml(row.local.fileName)}</code>` : "") +
      (row.editorCopy ? " · 编辑器里有本地副本" : "") +
      (row.version ? ` · 版本 ${escapeHtml(row.version)}` : "") +
      `</div>`,
    row.description ? `<p class="mod-desc">${escapeHtml(row.description)}</p>` : "",
    row.readme
      ? `<details class="mod-readme"><summary>README</summary><pre>${escapeHtml(row.readme)}</pre></details>`
      : "",
    renderWarnings(row),
  ].join("");
  const sections = [
    contentSection("单位", "units", row.packFile.units),
    contentSection("技能", "skills", row.packFile.skills),
    contentSection("效果", "effects", row.packFile.effects),
  ].join("");
  body.innerHTML = head + (sections || `<p class="lib-empty">这个卡包还没有内容。</p>`);
  const editBtn = $("#mod-content-edit");
  if (editBtn) {
    editBtn.hidden = !row.packId;
    editBtn.textContent = "在编辑器中编辑";
  }
  modal.hidden = false;
  const box = modal.querySelector(".mod-content-box");
  if (box) box.scrollTop = 0;
  $("#mod-content-close")?.focus({ preventScroll: true });
}

function closeContent() {
  closeModDetail();
  const modal = $("#mod-content-modal");
  if (modal) modal.hidden = true;
  contentRow = null;
}

/* ------------------------------------------------------------------ */
/* 操作                                                                */
/* ------------------------------------------------------------------ */

function toggleRow(row, enabled) {
  row.enabled = enabled;
  setPackEnabled(row.packId, enabled, row.aliasKeys);
  render();
  setStatus(statusText());
}

async function exportRow(row) {
  setStatus(`正在导出「${row.name}」…`);
  try {
    const out = await exportPackFile(row.packFile, { packId: row.packId, readme: row.readme });
    downloadBlob(out.blob, out.name);
    setStatus(`已导出「${row.name}」→ ${out.name}`);
  } catch (err) {
    setStatus(`导出失败：${errText(err)}`);
  }
}

async function updateRow(row) {
  if (loading || !row.server) return;
  if (!confirm("确认：将会删除所有本地修改，并同步为服务端最新版本")) return;
  setStatus(`正在同步「${row.name}」为服务端最新版本…`);
  try {
    // 先把服务端最新文件拉下来，确认能读到再删本地修改
    const res = await forceUpdateServerPack(row.server);
    if (!res.ok) {
      setStatus(`更新失败：${res.error}`);
      return;
    }
    if (row.editorPack) edit.discardPack(row.packId, { allowDefault: true });
    const removedLocal = await removeLocalPacks(row.packId);
    setPackEnabled(row.packId, true, row.aliasKeys);
    await refresh();
    setStatus(
      `已同步「${row.name}」为服务端最新版本` +
        (removedLocal.length ? `；已删除本地导入：${removedLocal.join("、")}` : "")
    );
  } catch (err) {
    setStatus(`更新失败：${errText(err)}`);
  }
}

async function saveAsRow(row) {
  const suggestion = `${row.packId}copy`;
  const input = prompt(
    `把「${row.name}」另存为新的卡包 id：\n\n只能用字母 / 数字 / . / -，不能含下划线；会复制成一个默认停用的本地卡包。`,
    suggestion
  );
  if (input === null) return;
  const newId = input.trim();
  if (!newId) return;
  if (!isValidPackId(newId)) {
    alert("卡包 id 不合法：只能用字母 / 数字 / . / -，不能含下划线，也不能叫 all。");
    return;
  }
  if (rows.some((item) => item.packId === newId)) {
    alert(`卡包 id「${newId}」已经存在。`);
    return;
  }
  setStatus(`正在另存为「${newId}」…`);
  try {
    await savePackAsLocal(row.packFile, { newId, name: row.name, readme: row.readme });
    await refresh();
    setStatus(`已另存为本地卡包「${newId}」（默认停用）`);
  } catch (err) {
    setStatus(`另存为失败：${errText(err)}`);
  }
}

async function deleteRow(row) {
  if (loading) return;
  const hasServer = Boolean(row.server);
  const ok = confirm(
    hasServer
      ? `删除「${row.name}」在本机的副本？\n\n会移除编辑器里的副本、本地导入和浏览器缓存；服务器文件不受影响，刷新后会重新从服务器缓存。`
      : `删除「${row.name}」？\n\n会移除编辑器里的副本和本地导入，此操作不可撤销。`
  );
  if (!ok) return;
  setStatus(`正在删除「${row.name}」…`);
  if (row.editorPack) {
    // 有服务端文件时不写删除标记：之后还能从服务器重新补回
    if (hasServer) edit.discardPack(row.packId, { allowDefault: true });
    else edit.deletePack(row.packId);
  }
  if (row.local) await removeLocalMod(row.local.id);
  if (row.server) await removeServerModCache(row.server.id);
  await refresh();
  setStatus(
    hasServer
      ? `已删除「${row.name}」的本机副本，刷新后会重新从服务器缓存`
      : `已删除本地卡包「${row.name}」`
  );
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
