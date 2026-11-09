/**
 * browser-cache.js —— 浏览器本地缓存（IndexedDB + Cache Storage）
 *
 * 目标：同一台设备第二次打开时，不再重新下载 / 解压 / 解析卡包。
 * 缓存是「用到才写」：
 *   · 打开卡牌库 / 训练场 / 同屏时才会读取模组，第一次读取成功后把
 *     解析好的卡包 JSON 与图片字节写入 IndexedDB；
 *   · 下次打开直接复用，不再走纯 JS 解压和大图重读。
 *
 * 注意：这些缓存都可以在「设置」里单独清除，不会影响服务器上的文件。
 */

export const MOD_DB_NAME = "caeworld-mods-zip";
export const MOD_DB_VERSION = 3;

/** IndexedDB 存储区 */
export const MOD_STORES = Object.freeze({
  FILES: "files", // 本地导入的 ZIP
  SERVER: "server", // 服务器模组的原始 ZIP 字节
  PARSED: "parsed", // 解析后的卡包 JSON（不含图片）
  ART: "art", // 卡面 / 图标 Blob
});

/** 图片缓存（Cache Storage）——给运行时用到的静态图片留的位置 */
export const IMAGE_CACHE_PREFIX = "caeworld-images-";

/** 打开缓存数据库；每次请求独立打开 / 关闭，避免长时间占用连接 */
export function openModDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持 IndexedDB，无法使用本地缓存"));
      return;
    }
    const req = indexedDB.open(MOD_DB_NAME, MOD_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MOD_STORES.FILES)) {
        db.createObjectStore(MOD_STORES.FILES, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(MOD_STORES.SERVER)) {
        db.createObjectStore(MOD_STORES.SERVER, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(MOD_STORES.PARSED)) {
        db.createObjectStore(MOD_STORES.PARSED, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(MOD_STORES.ART)) {
        db.createObjectStore(MOD_STORES.ART, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("无法打开 IndexedDB 缓存"));
    req.onblocked = () =>
      reject(new Error("本地缓存升级被其他页面占用，请关闭其他页面后刷新"));
  });
}

/** 在某个存储区执行一次操作；完成后关闭数据库连接 */
export function modDbRequest(storeName, mode, fn) {
  return openModDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let req;
        let tx;
        try {
          tx = db.transaction(storeName, mode);
          req = fn(tx.objectStore(storeName));
        } catch (err) {
          db.close();
          reject(err);
          return;
        }
        let result;
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => reject(req.error || new Error("IndexedDB 操作失败"));
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error || new Error("IndexedDB 事务中止"));
        };
      })
  );
}

export function readAll(storeName) {
  return modDbRequest(storeName, "readonly", (store) => store.getAll());
}

export function readRecord(storeName, key) {
  return modDbRequest(storeName, "readonly", (store) => store.get(key));
}

export function putRecord(storeName, value) {
  return modDbRequest(storeName, "readwrite", (store) => store.put(value));
}

export function deleteRecord(storeName, key) {
  return modDbRequest(storeName, "readwrite", (store) => store.delete(key));
}

export function clearStore(storeName) {
  return modDbRequest(storeName, "readwrite", (store) => store.clear());
}

/* ------------------------------------------------------------------ */
/* 卡包缓存                                                            */
/* ------------------------------------------------------------------ */

/** 解析后的卡包元信息（不含图片） */
export async function readParsedPack(name) {
  try {
    return await readRecord(MOD_STORES.PARSED, name);
  } catch {
    return null;
  }
}

export function writeParsedPack(name, stamp, meta) {
  return putRecord(MOD_STORES.PARSED, { name, stamp, meta });
}

/** 一个卡包的全部图片记录；key 形如 `file\0kind\0imageKey` */
export async function readArtForPack(name) {
  try {
    const list = await readAll(MOD_STORES.ART);
    return (Array.isArray(list) ? list : []).filter((rec) => rec && rec.name === name);
  } catch {
    return [];
  }
}

export function writeArtRecord(record) {
  return putRecord(MOD_STORES.ART, record);
}

export function artKeyOf(name, kind, imageKey) {
  return `${name}\u0000${kind}\u0000${String(imageKey || "").toLowerCase()}`;
}

/* ------------------------------------------------------------------ */
/* 设置页：统计 / 分类清除                                              */
/* ------------------------------------------------------------------ */

function bytesOfRecord(rec) {
  if (!rec) return 0;
  if (Number.isFinite(rec.size) && rec.size > 0) return rec.size;
  const b = rec.bytes;
  if (b && Number.isFinite(b.byteLength)) return b.byteLength;
  if (rec.blob && Number.isFinite(rec.blob.size)) return rec.blob.size;
  return 0;
}

/** 缓存统计：按类别返回条数与字节数（读不到时返回 0，不抛错） */
export async function getCacheStats() {
  const out = {
    server: { count: 0, bytes: 0 },
    local: { count: 0, bytes: 0 },
    parsed: { count: 0, bytes: 0 },
    art: { count: 0, bytes: 0 },
    images: { count: 0, bytes: 0 },
  };
  try {
    const server = await readAll(MOD_STORES.SERVER);
    out.server.count = server.length;
    out.server.bytes = server.reduce((sum, rec) => sum + bytesOfRecord(rec), 0);
  } catch {
    /* 忽略 */
  }
  try {
    const local = await readAll(MOD_STORES.FILES);
    out.local.count = local.length;
    out.local.bytes = local.reduce((sum, rec) => sum + bytesOfRecord(rec), 0);
  } catch {
    /* 忽略 */
  }
  try {
    const parsed = await readAll(MOD_STORES.PARSED);
    out.parsed.count = parsed.length;
    out.parsed.bytes = parsed.reduce((sum, rec) => {
      try {
        return sum + new Blob([JSON.stringify(rec.meta || {})]).size;
      } catch {
        return sum;
      }
    }, 0);
  } catch {
    /* 忽略 */
  }
  try {
    const art = await readAll(MOD_STORES.ART);
    out.art.count = art.length;
    out.art.bytes = art.reduce((sum, rec) => sum + bytesOfRecord(rec), 0);
  } catch {
    /* 忽略 */
  }
  if (typeof caches !== "undefined" && caches && typeof caches.keys === "function") {
    try {
      const names = (await caches.keys()).filter((name) => name.startsWith(IMAGE_CACHE_PREFIX));
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        out.images.count += keys.length;
        for (const req of keys) {
          const res = await cache.match(req);
          const len = Number(res?.headers.get("content-length")) || 0;
          out.images.bytes += len;
        }
      }
    } catch {
      /* 忽略 */
    }
  }
  return out;
}

/** 清除卡面 / 图标缓存（IndexedDB 里的图片 Blob + Cache Storage 图片） */
export async function clearImageCache() {
  let removed = 0;
  try {
    const before = await readAll(MOD_STORES.ART);
    removed += (before || []).length;
    await clearStore(MOD_STORES.ART);
  } catch {
    /* 忽略 */
  }
  if (typeof caches !== "undefined" && caches && typeof caches.keys === "function") {
    try {
      const names = (await caches.keys()).filter((name) => name.startsWith(IMAGE_CACHE_PREFIX));
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        removed += keys.length;
        await caches.delete(name);
      }
    } catch {
      /* 忽略 */
    }
  }
  return removed;
}

/** 清除已下载 / 解析的服务器卡包缓存（不动本地导入的模组） */
export async function clearPackCache() {
  let removed = 0;
  try {
    const before = await readAll(MOD_STORES.SERVER);
    removed += (before || []).length;
    await clearStore(MOD_STORES.SERVER);
  } catch {
    /* 忽略 */
  }
  try {
    const before = await readAll(MOD_STORES.PARSED);
    removed += (before || []).length;
    await clearStore(MOD_STORES.PARSED);
  } catch {
    /* 忽略 */
  }
  return removed;
}

/** 清除本地导入的 ZIP 模组（JSON 模组由调用方从 localStorage 清） */
export async function clearLocalZipCache() {
  let removed = 0;
  try {
    const before = await readAll(MOD_STORES.FILES);
    removed += (before || []).length;
    await clearStore(MOD_STORES.FILES);
  } catch {
    /* 忽略 */
  }
  return removed;
}
