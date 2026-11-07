/**
 * settings-view.js —— 设置页
 *
 * 目前只做一件事：清除当前站点在浏览器里保存的数据（localStorage /
 * sessionStorage / Cache Storage / IndexedDB）。
 *
 * 注意：这里不会、也无法删除服务器上的 mods/、data/、assets/ 文件；
 * 清除后重新载入页面会重新从服务器读取默认模组。
 */

const $ = (sel, root = document) => root.querySelector(sel);

let page = null;
let bound = false;
let busy = false;

export function initSettings() {
  page = $("#settings-page");
  if (!page) return;

  if (!bound) {
    bound = true;
    $("#settings-back")?.addEventListener("click", () => {
      location.hash = "#menu";
    });
    $("#settings-clear")?.addEventListener("click", openConfirm);
    $("#settings-confirm-cancel")?.addEventListener("click", closeConfirm);
    $("#settings-confirm-ok")?.addEventListener("click", () => {
      clearAllBrowserData().catch((err) => {
        setStatus("清除失败：" + String((err && err.message) || err), "bad");
        const btn = $("#settings-clear");
        if (btn) btn.disabled = false;
        busy = false;
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
  if (!busy) {
    const btn = $("#settings-clear");
    if (btn) btn.disabled = false;
  }
  setStatus("");
  refreshUsage();
}

function setStatus(text, kind = "") {
  const el = $("#settings-status");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.kind = kind;
}

function setUsage(text) {
  const el = $("#settings-usage");
  if (el) el.textContent = text;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function usedLocalStorageBytes() {
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key == null) continue;
    const value = localStorage.getItem(key) || "";
    // UTF-16 近似：key + value 的字符数 × 2
    bytes += (key.length + value.length) * 2;
  }
  return bytes;
}

function refreshUsage() {
  try {
    const count = localStorage.length;
    const bytes = usedLocalStorageBytes();
    setUsage(`本地存储：${count} 项，约 ${formatBytes(bytes)}。清除后会自动重新载入，并重新读取服务器上的默认内容。`);
  } catch (err) {
    setUsage("本地存储：当前浏览器不允许读取（" + String((err && err.message) || err) + "）");
  }
}

function openConfirm() {
  if (busy) return;
  const modal = $("#settings-confirm-modal");
  if (!modal) {
    if (!confirm("清除所有浏览器数据？服务器上的文件不会被删除。")) return;
    clearAllBrowserData().catch((err) => setStatus("清除失败：" + String((err && err.message) || err), "bad"));
    return;
  }
  modal.hidden = false;
  $("#settings-confirm-ok")?.focus?.();
}

function closeConfirm() {
  const modal = $("#settings-confirm-modal");
  if (modal) modal.hidden = true;
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

/**
 * 清除浏览器本地数据。只调用浏览器存储 API，不触碰服务器文件。
 * 完成后去掉 hash 并重新载入页面，避免内存里的旧状态继续显示。
 */
async function clearAllBrowserData() {
  if (busy) return;
  busy = true;
  closeConfirm();

  const btn = $("#settings-clear");
  if (btn) btn.disabled = true;
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

  refreshUsage();
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
