/**
 * settings-view.js —— 设置页
 *
 * 浏览器本地数据按类别分开清除：
 *   缓存图片 / 卡组阵容 / 加载的卡包 / 本地导入模组 / 编辑器草稿 / 全部。
 *
 * 注意：这里不会、也无法删除服务器上的 mods/、data/、assets/ 文件；
 * 清除后重新载入页面会重新从服务器读取默认内容。
 */
import {
  clearImageCache,
  clearLocalZipCache,
  clearPackCache,
  getCacheStats,
} from "./browser-cache.js";
import { clearModCache, restoreServerMods } from "./mods.js";

const $ = (sel, root = document) => root.querySelector(sel);

const DECK_KEYS = ["caeworld:training:v1", "caeworld:local:v2", "caeworld:local:v1"];
const LOCAL_MOD_KEYS = ["caeworld:mods:local:v1", "caeworld:mods:disabled:v1"];
const EDITOR_KEYS = ["caeworld:editor-pack", "caeworld:editor-json-collapsed"];
const EDITOR_PREFIXES = ["caeworld:editor-project", "caeworld:export:"];

const ACTIONS = {
  images: {
    title: "清除缓存图片",
    desc: "删除本机缓存的卡面 / 技能图标 / 效果图标。下次打开卡牌库或战斗时会重新从卡包解出；服务器文件不受影响。",
    ok: "清除图片缓存",
  },
  decks: {
    title: "清除卡组 / 阵容",
    desc: "删除训练场、同屏对战的设置、当前阵容与已保存卡组 / ban 卡组。不会删除卡包或编辑器内容。",
    ok: "清除卡组",
  },
  packs: {
    title: "清除加载的卡包",
    desc: "删除从服务器下载并解析过的模组缓存。下次打开会重新下载并解压；本地导入的模组不受影响。",
    ok: "清除卡包缓存",
  },
  localmods: {
    title: "清除本地导入的模组",
    desc: "删除自己导入的 ZIP / JSON 模组及其启用状态。服务器上的模组不受影响。",
    ok: "清除本地模组",
  },
  editor: {
    title: "清除编辑器草稿",
    desc: "删除编辑器工程、当前卡包、导出临时备份与折叠状态。导出的 ZIP 文件已经下载到设备上，不会被删除。",
    ok: "清除编辑器草稿",
  },
  all: {
    title: "清除所有浏览器数据",
    desc: "删除本站在浏览器里保存的编辑器工程、本地模组、卡组设置、图片与卡包缓存。服务器上的文件不会被动到。此操作不可撤销。",
    ok: "确认清除",
  },
};

let page = null;
let bound = false;
let busy = false;
let pendingKind = null;

export function initSettings() {
  page = $("#settings-page");
  if (!page) return;

  if (!bound) {
    bound = true;
    $("#settings-back")?.addEventListener("click", () => {
      location.hash = "#menu";
    });
    $("#settings-clear")?.addEventListener("click", () => openConfirm("all"));
    document.querySelectorAll("[data-clear]").forEach((btn) => {
      btn.addEventListener("click", () => openConfirm(btn.dataset.clear));
    });
    $("#settings-confirm-cancel")?.addEventListener("click", closeConfirm);
    $("#settings-confirm-ok")?.addEventListener("click", () => {
      const kind = pendingKind;
      if (!kind) return;
      runClear(kind).catch((err) => {
        setStatus("清除失败：" + String((err && err.message) || err), "bad");
        setBusy(false);
      });
    });
    $("#settings-confirm-modal")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeConfirm();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#settings-confirm-modal")?.hidden) closeConfirm();
    });
  }

  page.hidden = false;
  closeConfirm();
  setBusy(false);
  setStatus("");
  refreshUsage();
}

function setStatus(text, kind = "") {
  const el = $("#settings-status");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.kind = kind;
}

function setUsage(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setBusy(next) {
  busy = Boolean(next);
  const all = $("#settings-clear");
  if (all) all.disabled = busy;
  document.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.disabled = busy;
  });
  const ok = $("#settings-confirm-ok");
  if (ok) ok.disabled = busy;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function readLocalBytes(keys = [], prefixes = []) {
  let bytes = 0;
  let count = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key == null) continue;
      const hit = keys.includes(key) || prefixes.some((prefix) => key.startsWith(prefix));
      if (!hit) continue;
      count += 1;
      bytes += (key.length + (localStorage.getItem(key) || "").length) * 2;
    }
  } catch {
    /* localStorage 不可用 */
  }
  return { count, bytes };
}

function usedLocalStorageBytes() {
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key == null) continue;
      bytes += (key.length + (localStorage.getItem(key) || "").length) * 2;
    }
  } catch {
    /* 忽略 */
  }
  return bytes;
}

async function refreshUsage() {
  let stats = null;
  try {
    stats = await getCacheStats();
  } catch {
    stats = null;
  }
  const art = stats?.art || { count: 0, bytes: 0 };
  const imageCache = stats?.images || { count: 0, bytes: 0 };
  const server = stats?.server || { count: 0, bytes: 0 };
  const parsed = stats?.parsed || { count: 0, bytes: 0 };
  const localZip = stats?.local || { count: 0, bytes: 0 };

  setUsage(
    "#settings-usage-images",
    `约 ${formatBytes(art.bytes + imageCache.bytes)} · ${art.count + imageCache.count} 个图片`
  );

  const decks = readLocalBytes(DECK_KEYS);
  setUsage("#settings-usage-decks", decks.count ? `${decks.count} 项 · 约 ${formatBytes(decks.bytes)}` : "暂无");

  setUsage(
    "#settings-usage-packs",
    `原始包 ${server.count} 个 · 已解析 ${parsed.count} 个 · 约 ${formatBytes(server.bytes + parsed.bytes)}`
  );

  const localMods = readLocalBytes(LOCAL_MOD_KEYS);
  setUsage(
    "#settings-usage-localmods",
    localZip.count || localMods.count
      ? `${localZip.count} 个 ZIP · ${localMods.count} 项设置 · 约 ${formatBytes(localZip.bytes + localMods.bytes)}`
      : "暂无"
  );

  const editor = readLocalBytes(EDITOR_KEYS, EDITOR_PREFIXES);
  setUsage("#settings-usage-editor", editor.count ? `${editor.count} 项 · 约 ${formatBytes(editor.bytes)}` : "暂无");

  try {
    const count = localStorage.length;
    setUsage(
      "#settings-usage",
      `本地存储：${count} 项，约 ${formatBytes(usedLocalStorageBytes())}。各项可单独清除；清除后刷新页面生效。`
    );
  } catch (err) {
    setUsage("本地存储：当前浏览器不允许读取（" + String((err && err.message) || err) + "）");
  }
}

function openConfirm(kind) {
  if (busy) return;
  const meta = ACTIONS[kind];
  if (!meta) return;
  pendingKind = kind;
  const modal = $("#settings-confirm-modal");
  if (!modal) {
    if (!confirm(meta.title + "？")) return;
    runClear(kind).catch((err) => setStatus("清除失败：" + String((err && err.message) || err), "bad"));
    return;
  }
  const title = $("#settings-confirm-title");
  if (title) title.textContent = meta.title;
  const desc = $("#settings-confirm-desc");
  if (desc) desc.textContent = meta.desc;
  const ok = $("#settings-confirm-ok");
  if (ok) ok.textContent = meta.ok;
  modal.hidden = false;
  ok?.focus?.();
}

function closeConfirm() {
  const modal = $("#settings-confirm-modal");
  if (modal) modal.hidden = true;
  pendingKind = null;
}

function removeLocalKeys(keys = [], prefixes = []) {
  let removed = 0;
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key == null) continue;
      if (keys.includes(key) || prefixes.some((prefix) => key.startsWith(prefix))) doomed.push(key);
    }
    for (const key of doomed) {
      localStorage.removeItem(key);
      removed += 1;
    }
  } catch {
    /* localStorage 不可用 */
  }
  return removed;
}

function deleteDatabase(name) {
  return new Promise((resolve) => {
    if (!name) {
      resolve();
      return;
    }
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function clearAllBrowserData() {
  closeConfirm();
  setBusy(true);
  setStatus("正在清除浏览器数据…");

  const result = { local: 0, session: 0, caches: 0, idb: 0, errors: [] };

  try {
    result.local = localStorage.length;
    localStorage.clear();
  } catch (err) {
    result.errors.push("localStorage: " + String((err && err.message) || err));
  }

  try {
    result.session = sessionStorage.length;
    sessionStorage.clear();
  } catch (err) {
    result.errors.push("sessionStorage: " + String((err && err.message) || err));
  }

  try {
    if (typeof caches !== "undefined" && caches && typeof caches.keys === "function") {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      result.caches = keys.length;
    }
  } catch (err) {
    result.errors.push("Cache Storage: " + String((err && err.message) || err));
  }

  try {
    if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
      const list = await indexedDB.databases();
      result.idb = list.length;
      await Promise.all(list.map((db) => deleteDatabase(db && db.name)));
    }
  } catch (err) {
    result.errors.push("IndexedDB: " + String((err && err.message) || err));
  }

  if (result.errors.length) {
    setStatus("部分数据清除失败：" + result.errors[0], "bad");
  } else {
    setStatus(
      `已清除：localStorage ${result.local} 项 · sessionStorage ${result.session} 项 · 缓存 ${result.caches} 个 · IndexedDB ${result.idb} 个；正在重新载入…`,
      "ok"
    );
  }

  // 给状态栏一点时间；随后回主菜单并重新加载服务器内容
  const delay = result.errors.length ? 2200 : 900;
  setTimeout(() => {
    location.replace(location.pathname + location.search);
  }, delay);
}

async function clearCategory(kind) {
  switch (kind) {
    case "images": {
      const n = await clearImageCache();
      clearModCache();
      return { text: `已清除图片缓存（${n} 个文件），刷新页面后重新解出。` };
    }
    case "decks": {
      const n = removeLocalKeys(DECK_KEYS);
      return { text: `已清除卡组 / 阵容（${n} 项），刷新页面后生效。` };
    }
    case "packs": {
      const n = await clearPackCache();
      clearModCache();
      restoreServerMods();
      return { text: `已清除加载的卡包缓存（${n} 条），下次打开会重新下载。` };
    }
    case "localmods": {
      const n = removeLocalKeys(LOCAL_MOD_KEYS);
      const nZip = await clearLocalZipCache();
      clearModCache();
      return { text: `已清除本地导入的模组（ZIP ${nZip} 个 · 设置 ${n} 项）。` };
    }
    case "editor": {
      const n = removeLocalKeys(EDITOR_KEYS, EDITOR_PREFIXES);
      return { text: `已清除编辑器草稿（${n} 项），刷新页面后生效。` };
    }
    default:
      return { text: "没有可清除的数据。" };
  }
}

async function runClear(kind) {
  if (busy) return;
  closeConfirm();
  if (kind === "all") {
    await clearAllBrowserData();
    return;
  }
  setBusy(true);
  setStatus("正在清除…");
  try {
    const { text } = await clearCategory(kind);
    setStatus(text, "ok");
    await refreshUsage();
  } finally {
    setBusy(false);
  }
}
