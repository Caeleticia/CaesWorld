/**
 * mod-view.js —— 模组 / 模组管理
 *
 * 服务器模组：mods/index.txt 清单 + mods/ 文件。
 * 本地模组：从本页导入，存在 localStorage。
 * 启用 / 停用：只影响本机，不修改服务器上的 index.txt。
 */
import {
  MODS_INDEX,
  loadAllMods,
  setModEnabled,
  importModFile,
  removeLocalMod,
  modToExport,
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
    $("#mod-refresh")?.addEventListener("click", () => refresh());
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
        if (mod) downloadJson(mod.fileName || `${mod.id}.json`, modToExport(mod));
        return;
      }
      const delBtn = event.target.closest("[data-mod-delete]");
      if (delBtn) {
        const mod = mods.find((m) => m.id === delBtn.dataset.modDelete);
        if (!mod || mod.source !== "local") return;
        if (!confirm(`从本机删除导入的模组「${mod.name}」？`)) return;
        removeLocalMod(mod.id);
        await refresh();
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

async function refresh() {
  if (loading) return;
  loading = true;
  setStatus("正在读取模组…");
  try {
    const res = await loadAllMods({ includeDisabled: true });
    mods = res.mods;
    errors = res.errors || [];
    render();
    const enabled = mods.filter((m) => m.enabled).length;
    setStatus(`${mods.length} 个模组 · 启用 ${enabled}${errors.length ? ` · ${errors.length} 个读取问题` : ""}`);
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
  return `单位 ${mod.units.length} · 技能 ${mod.skills.length} · 效果 ${mod.effects.length}`;
}

function render() {
  const list = $("#mod-list");
  if (!list) return;
  if (!mods.length) {
    list.innerHTML = `<p class="lib-empty">还没有模组。把文件放进 <code>mods/</code> 并写进 <code>${escapeHtml(
      MODS_INDEX
    )}</code>，或者点右上角「导入模组」。</p>`;
    return;
  }
  list.innerHTML = mods
    .map((mod) => {
      const sourceLabel = mod.source === "local" ? "本地导入" : "服务器";
      const sourceClass = mod.source === "local" ? "is-local" : "is-server";
      return `
      <article class="mod-row ${mod.enabled ? "" : "is-off"}">
        <div class="mod-row-main">
          <div class="mod-row-head">
            <strong>${escapeHtml(mod.name)}</strong>
            ${mod.version ? `<span class="mod-version">${escapeHtml(mod.version)}</span>` : ""}
            <span class="mod-source ${sourceClass}">${escapeHtml(sourceLabel)}</span>
            <span class="mod-file">${escapeHtml(mod.fileName)}</span>
          </div>
          ${mod.description ? `<p class="mod-desc">${escapeHtml(mod.description)}</p>` : ""}
          <div class="mod-meta">${escapeHtml(fmtCounts(mod))}</div>
        </div>
        <div class="mod-ops">
          <label class="mod-enable ${mod.enabled ? "is-on" : ""}">
            <input type="checkbox" data-mod-toggle="${escapeHtml(mod.id)}" ${mod.enabled ? "checked" : ""} />
            ${mod.enabled ? "已启用" : "已停用"}
          </label>
          <button class="btn tiny" type="button" data-mod-export="${escapeHtml(mod.id)}">导出</button>
          ${
            mod.source === "local"
              ? `<button class="btn tiny danger" type="button" data-mod-delete="${escapeHtml(mod.id)}">删除</button>`
              : ""
          }
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

function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
