/**
 * mod-view.js —— 模组 / 模组管理
 *
 * 服务器模组：mods/index.txt 清单 + mods/ 文件（ZIP 或旧 JSON）。
 * 本地模组：从本页导入，JSON 存在 localStorage，ZIP 存在 IndexedDB。
 * 启用 / 停用：只影响本机，不修改服务器上的 index.txt。
 */
import {
  MODS_INDEX,
  loadAllMods,
  setModEnabled,
  importModFile,
  removeLocalMod,
  removeServerModCache,
  restoreServerMods,
  exportMod,
} from "./mods.js";

const $ = (sel, root = document) => root.querySelector(sel);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let bound = false;
let page = null;
let mods = [];
let errors = [];
let loading = false;

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
      // 「刷新」把本页删掉的服务器模组放回清单，并强制重新下载全部服务器模组
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
      const exportBtn = event.target.closest("[data-mod-export]");
      if (exportBtn) {
        const mod = mods.find((m) => m.id === exportBtn.dataset.modExport);
        if (!mod) return;
        setStatus(`正在导出「${mod.name}」…`);
        try {
          const out = await exportMod(mod);
          if (!out) return;
          downloadBlob(out.blob, out.name);
          setStatus(`已导出「${mod.name}」→ ${out.name}`);
        } catch (err) {
          setStatus(`导出失败：${String((err && err.message) || err)}`);
        }
        return;
      }
      const delBtn = event.target.closest("[data-mod-delete]");
      if (delBtn) {
        if (loading) return;
        const mod = mods.find((m) => m.id === delBtn.dataset.modDelete);
        if (!mod) return;
        if (mod.source === "local") {
          if (!confirm(`从本机删除导入的模组「${mod.name}」？`)) return;
          setStatus(`正在删除「${mod.name}」…`);
          await removeLocalMod(mod.id);
          await refresh();
          setStatus(`已删除本地模组「${mod.name}」`);
        } else {
          if (
            !confirm(
              `删除服务器模组「${mod.name}」在浏览器里的缓存？\n\n不会删除服务器文件；点「刷新」或重新打开页面后会重新从服务器缓存。`
            )
          )
            return;
          setStatus(`正在删除「${mod.name}」的浏览器缓存…`);
          await removeServerModCache(mod.id);
          await refresh();
          setStatus(`已删除「${mod.name}」的浏览器缓存，刷新后会重新缓存`);
        }
      }
    });
    $("#mod-list")?.addEventListener("change", (event) => {
      const toggle = event.target.closest("[data-mod-toggle]");
      if (!toggle) return;
      const id = toggle.dataset.modToggle;
      const mod = mods.find((m) => m.id === id);
      if (!mod) return;
      mod.enabled = Boolean(toggle.checked);
      setModEnabled(id, mod.enabled);
      render();
      setStatus(`${mods.length} 个模组 · 启用 ${mods.filter((m) => m.enabled).length}`);
    });
  }
  page.hidden = false;
  await refresh();
}

async function refresh({ force = false } = {}) {
  if (loading) return;
  loading = true;
  setStatus("正在读取模组…");
  try {
    const res = await loadAllMods({ includeDisabled: true, force });
    mods = res.mods;
    errors = res.errors || [];
    render();
    const enabled = mods.filter((m) => m.enabled).length;
    const zipCount = mods.filter((m) => m.isZip).length;
    const artCount = mods.reduce((n, m) => n + (m.imageCount || 0), 0);
    const iconCount = mods.reduce(
      (n, m) => n + (m.icons ? (m.icons.skill?.length || 0) + (m.icons.effect?.length || 0) : 0),
      0
    );
    setStatus(
      `${mods.length} 个模组（ZIP ${zipCount}）· 启用 ${enabled} · 卡面 ${artCount}` +
        (iconCount ? ` · 图标 ${iconCount}` : "") +
        (errors.length ? ` · ${errors.length} 个读取问题` : "")
    );
    if (errors.length) console.warn("[模组管理] 读取问题：", errors);
  } catch (err) {
    mods = [];
    errors = [String((err && err.message) || err)];
    render();
    setStatus("读取失败：" + errors[0]);
  } finally {
    loading = false;
  }
}

function setStatus(text) {
  const el = $("#mod-status");
  if (el) el.textContent = text ? `· ${text}` : "";
}

function fmtCounts(mod) {
  const icons = mod.icons ? (mod.icons.skill?.length || 0) + (mod.icons.effect?.length || 0) : 0;
  return `单位 ${mod.units.length} · 技能 ${mod.skills.length} · 效果 ${mod.effects.length}` +
    (icons ? ` · 图标 ${icons}` : "");
}

function renderWarnings(mod) {
  const list = (mod.warnings || []).filter(Boolean);
  if (!list.length) return "";
  const shown = list.slice(0, 3);
  return `<div class="mod-warn">${shown.map((w) => escapeHtml(w)).join("<br>")}${
    list.length > shown.length ? `<br>…另有 ${list.length - shown.length} 条` : ""
  }</div>`;
}

function renderReadme(mod) {
  if (!mod.readme) return "";
  return `<details class="mod-readme">
    <summary>README</summary>
    <pre>${escapeHtml(mod.readme)}</pre>
  </details>`;
}

function renderArt(mod) {
  const images = (mod.images || []).filter((img) => img && img.url).slice(0, 6);
  if (!images.length) return "";
  return `<div class="mod-art">${images
    .map(
      (img) =>
        `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.key)}" title="${escapeHtml(
          `${img.key}.${img.ext}`
        )}" loading="lazy" />`
    )
    .join("")}${mod.images.length > images.length ? `<span class="mod-art-more">+${mod.images.length - images.length}</span>` : ""}</div>`;
}

function render() {
  const list = $("#mod-list");
  if (!list) return;
  if (!mods.length) {
    list.innerHTML = `<p class="lib-empty">还没有模组。把 ZIP 模组放进 <code>mods/</code> 并写进 <code>${escapeHtml(
      MODS_INDEX
    )}</code>，或者点右上角「导入模组」。</p>`;
    return;
  }
  list.innerHTML = mods
    .map((mod) => {
      const sourceLabel = mod.source === "local" ? "本地导入" : "服务器";
      const sourceClass = mod.source === "local" ? "is-local" : "is-server";
      const formatLabel = mod.isZip ? "ZIP" : "JSON";
      return `
      <article class="mod-row ${mod.enabled ? "" : "is-off"}">
        <div class="mod-row-main">
          <div class="mod-row-head">
            <strong>${escapeHtml(mod.name)}</strong>
            ${mod.version ? `<span class="mod-version">v${escapeHtml(mod.version)}</span>` : ""}
            <span class="mod-source ${sourceClass}">${escapeHtml(sourceLabel)}</span>
            <span class="mod-format ${mod.isZip ? "is-zip" : ""}">${formatLabel}</span>
            <span class="mod-file">${escapeHtml(mod.fileName)}</span>
          </div>
          ${mod.description ? `<p class="mod-desc">${escapeHtml(mod.description)}</p>` : ""}
          <div class="mod-meta">${escapeHtml(fmtCounts(mod))}${
            mod.isZip ? ` · 卡面 ${mod.imageCount || 0}` : ""
          }</div>
          ${renderWarnings(mod)}
          ${renderArt(mod)}
          ${renderReadme(mod)}
        </div>
        <div class="mod-ops">
          <label class="mod-enable ${mod.enabled ? "is-on" : ""}">
            <input type="checkbox" data-mod-toggle="${escapeHtml(mod.id)}" ${mod.enabled ? "checked" : ""} />
            ${mod.enabled ? "已启用" : "已停用"}
          </label>
          <button class="btn tiny" type="button" data-mod-export="${escapeHtml(mod.id)}">导出</button>
          <button class="btn tiny danger" type="button" data-mod-delete="${escapeHtml(
            mod.id
          )}" title="${
            mod.source === "local" ? "从本机删除" : "删除浏览器缓存；刷新后会重新缓存"
          }">${mod.source === "local" ? "删除" : "删除缓存"}</button>
        </div>
      </article>`;
    })
    .join("");
  if (errors.length) {
    list.insertAdjacentHTML(
      "beforeend",
      `<article class="mod-row is-off"><div class="mod-row-main"><div class="mod-row-head"><strong>读取问题</strong></div><p class="mod-desc">${errors
        .map((e) => escapeHtml(e))
        .join("\n")}</p></div></article>`
    );
  }
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
