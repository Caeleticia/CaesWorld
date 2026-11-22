/**
 * editor-media.js —— 编辑器草稿：文字留在 localStorage，卡面搬去 IndexedDB
 *
 * 为什么需要它
 * ------------
 * iOS / iPadOS 上所有浏览器都是 WebKit（Safari、Chrome、Edge、微信内置…），
 * 而 WebKit 对 localStorage 有硬上限：约 5MB，且按 UTF-16 记账，
 * 实际只能放约 250 万个字符。它和 Safari 17 起放开的 IndexedDB 配额
 * （浏览器最多可用磁盘 60%）不是一个池子。
 *
 * 编辑器却把卡面以 data URL 内嵌在工程 JSON 里：一张 300KB 的 PNG 变成
 * 约 400KB 文字（base64 膨胀 4/3），两个带图的卡包就能把 5MB 吃满。
 * 之后的每次自动保存都会抛 QuotaExceededError —— 草稿悄悄停止更新，
 * 用户继续编辑，刷新后才发现改动没了。
 *
 * 做法
 * ----
 *   · 保存时把工程里的大 data URL 换成 `idbimg:<内容哈希>` 引用，
 *     图片本身写进独立的 IndexedDB；
 *   · 读取时把引用换回原 data URL，内存里的工程对象和以前一模一样，
 *     渲染 / 导出 / 校验 / 补卡都不需要改；
 *   · 同一个图片按内容哈希只存一份，自动保存反复写工程不会重复占空间；
 *   · 旧草稿（内嵌图片的那种）在打开编辑器时自动搬家，腾出 localStorage。
 *
 * 本模块不依赖 DOM：Node 里可以用假的 indexedDB / localStorage 测试。
 */

const DB_NAME = "caeworld-editor-media";
const DB_VERSION = 1;
const STORE = "images";

/** 引用前缀：工程 JSON 里 `image: "idbimg:xxxx"` 表示图片在 IndexedDB */
export const MEDIA_REF_PREFIX = "idbimg:";

/** 只写不读的导出备份：占空间时可以丢（真正的备份已经下载成 ZIP 了） */
const EXPORT_KEY_PREFIX = "caeworld:export:";

/* ------------------------------------------------------------------ */
/* 引用 / 哈希                                                          */
/* ------------------------------------------------------------------ */

/** @param {unknown} value */
export function isMediaRef(value) {
  return typeof value === "string" && value.startsWith(MEDIA_REF_PREFIX);
}

/** FNV-1a 32 位：够短、够稳，用来给图片内容生成去重键 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** data URL → IndexedDB 主键（内容相同则键相同） */
export function mediaKeyOf(dataUrl) {
  const text = String(dataUrl || "");
  return `${fnv1a(text)}-${text.length.toString(36)}`;
}

/** data URL → 工程里保存的引用 */
export function mediaRefOf(dataUrl) {
  return MEDIA_REF_PREFIX + mediaKeyOf(dataUrl);
}

/* ------------------------------------------------------------------ */
/* 运行时缓存                                                           */
/* ------------------------------------------------------------------ */

/** ref → data URL：本次页面里已经读出来的图片，避免同一张图反复查库 */
const urlByRef = new Map();
/** 已经在 IndexedDB 里的主键：自动保存时不用重复写 */
const storedKeys = new Set();
/** data URL → ref：同一张图在多个卡片上出现时只算一次哈希 */
const refByUrl = new Map();

function refFor(url) {
  let ref = refByUrl.get(url);
  if (!ref) {
    ref = mediaRefOf(url);
    refByUrl.set(url, ref);
  }
  return ref;
}

/**
 * 工程 JSON 里所有「够大的图片 data URL」。
 * 直接扫 JSON 文本而不是逐个字段走对象：
 *   · 不关心图片挂在 card.image、积木底图还是将来新增的字段上，一处逻辑全覆盖；
 *   · 不用深拷贝整个工程，自动保存时少一次几 MB 的对象图遍历；
 *   · 替换只发生在字符串值内部，data URL 不含引号和反斜杠，不会破坏 JSON。
 */
const BIG_IMAGE_DATA_URL = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=+%-]+)*,[a-z0-9+/=%-]{1024,}/gi;

/* ------------------------------------------------------------------ */
/* IndexedDB                                                            */
/* ------------------------------------------------------------------ */

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || !indexedDB) {
      reject(new Error("当前浏览器不支持 IndexedDB"));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开编辑器图片库"));
    request.onblocked = () => reject(new Error("图片库升级被其他页面占用，请关闭其他页面后刷新"));
  });
}

/**
 * 在一个事务里跑一段操作，事务提交后关闭连接。
 * executor(store, setResult) 里给 IDBRequest 挂 onsuccess 再 setResult(...)。
 */
function withStore(mode, executor) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let result;
        let tx;
        try {
          tx = db.transaction(STORE, mode);
        } catch (err) {
          db.close();
          reject(err);
          return;
        }
        const finish = (err) => {
          db.close();
          if (err) reject(err);
          else resolve(result);
        };
        tx.oncomplete = () => finish(null);
        tx.onerror = () => finish(tx.error || new Error("编辑器图片库读写失败"));
        tx.onabort = () => finish(tx.error || new Error("编辑器图片库事务被中止"));
        try {
          executor(tx.objectStore(STORE), (value) => {
            result = value;
          });
        } catch (err) {
          try {
            tx.abort();
          } catch {
            /* 事务可能已经结束 */
          }
          finish(err);
        }
      })
  );
}

async function dbGet(key) {
  let record = null;
  await withStore("readonly", (store, setResult) => {
    const req = store.get(key);
    req.onsuccess = () => setResult(req.result || null);
  });
  return record;
}

async function dbPut(record) {
  await withStore("readwrite", (store) => {
    store.put(record);
  });
}

/** 图片库里的张数与字符数（用于设置页显示占用） */
async function dbStats() {
  const records = await withStore("readonly", (store, setResult) => {
    const req = store.getAll();
    req.onsuccess = () => setResult(req.result || []);
  });
  const list = Array.isArray(records) ? records : [];
  return {
    count: list.length,
    bytes: list.reduce((sum, record) => sum + (Number(record && record.bytes) || 0), 0),
  };
}

/* ------------------------------------------------------------------ */
/* 图片读写                                                             */
/* ------------------------------------------------------------------ */

/**
 * 把一张 data URL 写进图片库（已存在则跳过）。
 * @param {string} dataUrl
 * @returns {Promise<string>} 工程里用的引用
 */
export async function putMedia(dataUrl) {
  const url = String(dataUrl || "");
  const key = mediaKeyOf(url);
  const ref = MEDIA_REF_PREFIX + key;
  if (!storedKeys.has(key)) {
    await dbPut({ key, url, bytes: url.length, at: Date.now() });
    storedKeys.add(key);
  }
  urlByRef.set(ref, url);
  return ref;
}

/**
 * 按引用取回 data URL；取不到返回空串（界面会退回占位图）。
 * @param {string} ref
 * @returns {Promise<string>}
 */
export async function getMedia(ref) {
  const key = String(ref || "").slice(MEDIA_REF_PREFIX.length);
  if (!key) return "";
  if (urlByRef.has(ref)) return urlByRef.get(ref);
  try {
    const record = await dbGet(key);
    if (record && record.url) {
      storedKeys.add(key);
      urlByRef.set(ref, record.url);
      return record.url;
    }
  } catch {
    /* 图片库不可用：当作没有这张图 */
  }
  return "";
}

/**
 * 批量落盘：把 tokenizeProject() 给出的 pending 写进图片库。
 * @param {Array<{ref: string, url: string}>} pending
 * @returns {Promise<{saved: number, failed: number}>}
 */
export async function persistMedia(pending) {
  let saved = 0;
  let failed = 0;
  for (const item of Array.isArray(pending) ? pending : []) {
    if (!item || !item.ref || !item.url) continue;
    const key = String(item.ref).slice(MEDIA_REF_PREFIX.length);
    if (storedKeys.has(key)) continue;
    try {
      await putMedia(item.url);
      saved += 1;
    } catch {
      failed += 1;
    }
  }
  return { saved, failed };
}

/* ------------------------------------------------------------------ */
/* 工程的序列化 / 反序列化                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成「适合放进 localStorage」的工程 JSON：大卡面换成 `idbimg:` 引用。
 * 不改动传入的工程对象（内存里仍然保留 data URL，渲染照旧）。
 * @param {object} project
 * @returns {{json: string, chars: number, pending: Array<{ref: string, url: string}>, refs: number}}
 */
export function tokenizeProject(project) {
  const pending = new Map();
  const unique = new Set();
  const text = JSON.stringify(project);
  const json = text.replace(BIG_IMAGE_DATA_URL, (url) => {
    const ref = refFor(url);
    unique.add(ref);
    const storageKey = ref.slice(MEDIA_REF_PREFIX.length);
    if (!storedKeys.has(storageKey) && !urlByRef.has(ref)) pending.set(ref, { ref, url });
    return ref;
  });
  return { json, chars: json.length, pending: [...pending.values()], refs: unique.size };
}

/**
 * 把工程里所有 `idbimg:` 引用换回 data URL（原地修改）。
 * 递归走整个工程而不只是 card.image：积木底图等选项里的图也走同一套引用。
 * @param {object} project
 * @returns {Promise<{hydrated: number, missing: number, refs: number}>}
 */
export async function hydrateProject(project) {
  const wanted = new Set();
  collectRefs(project, wanted);
  if (!wanted.size) return { hydrated: 0, missing: 0, refs: 0 };

  const urls = new Map();
  await Promise.all(
    [...wanted].map(async (ref) => {
      urls.set(ref, await getMedia(ref));
    })
  );

  const counts = { hydrated: 0, missing: 0 };
  replaceRefs(project, urls, counts);
  return { ...counts, refs: wanted.size };
}

/** 收集工程里出现的引用（同一张图只查一次库） */
function collectRefs(value, found, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const item of entries) {
    if (typeof item === "string") {
      if (isMediaRef(item)) found.add(item);
    } else if (item && typeof item === "object") {
      collectRefs(item, found, seen);
    }
  }
}

/** 把能解析的引用换回 data URL；解析不到的保留原样并计数 */
function replaceRefs(value, urls, counts, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const keys = Array.isArray(value) ? value.keys() : Object.keys(value);
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string") {
      if (!isMediaRef(item)) continue;
      const url = urls.get(item);
      if (url) {
        value[key] = url;
        counts.hydrated += 1;
      } else {
        counts.missing += 1;
      }
    } else if (item && typeof item === "object") {
      replaceRefs(item, urls, counts, seen);
    }
  }
}

/* ------------------------------------------------------------------ */
/* localStorage 写入（带配额兜底）                                       */
/* ------------------------------------------------------------------ */

function readKey(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function removeKey(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** 丢掉只写不读的导出备份，返回腾出的项数 */
export function dropExportBackups(storage = globalThis.localStorage) {
  if (!storage) return 0;
  const doomed = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(EXPORT_KEY_PREFIX)) doomed.push(key);
    }
  } catch {
    return 0;
  }
  let removed = 0;
  for (const key of doomed) {
    if (removeKey(storage, key)) removed += 1;
  }
  return removed;
}

/**
 * 把工程 JSON 写进 localStorage，处理「空间已满」的三种情形：
 *   1. 先丢掉可以牺牲的导出备份（caeworld:export:*）再试；
 *   2. 新值比旧值小时「先删后写」—— 有些实现把待替换的旧值也算进配额；
 *   3. 仍然失败就如实报错，并把旧值恢复回去，绝不静默丢草稿。
 *
 * @param {Storage} storage
 * @param {string} key
 * @param {string} json
 * @param {{dropKeys?: string[]}} [options]
 * @returns {{ok: boolean, bytes: number, freed: number, replaced: boolean, error?: Error}}
 */
export function writeProjectJson(storage, key, json, options = {}) {
  const text = String(json ?? "");
  const stale = (Array.isArray(options.dropKeys) ? options.dropKeys : []).filter(
    (extra) => extra && extra !== key
  );

  const attempt = () => {
    try {
      storage.setItem(key, text);
      return null;
    } catch (err) {
      return err || new Error("写入失败");
    }
  };

  // 正常路径：写成功后顺手清掉调用方点名的老键和只写不读的导出备份
  let error = attempt();
  if (!error) {
    let freed = dropExportBackups(storage);
    for (const extra of stale) {
      if (removeKey(storage, extra)) freed += 1;
    }
    return { ok: true, bytes: text.length, freed, replaced: false };
  }

  // 空间不够：把「可以牺牲的旧值」挪开再写，失败就原样放回去
  const backups = [];
  const stash = (target) => {
    const value = readKey(storage, target);
    if (value !== null && removeKey(storage, target)) backups.push([target, value]);
  };

  let freed = dropExportBackups(storage);
  // 部分实现会把待替换的旧值也算进配额：新值明显更小时先删后写
  const previous = readKey(storage, key);
  if (previous !== null && previous.length > text.length) stash(key);
  for (const extra of stale) stash(extra);

  if (backups.length) {
    freed += backups.length;
    const again = attempt();
    if (!again) return { ok: true, bytes: text.length, freed, replaced: true };
    // 没写成功：把挪开的东西放回去（放不下就只能放弃，但报错是真的）
    for (const [k, v] of backups) {
      try {
        storage.setItem(k, v);
      } catch {
        /* 放不回去也没别的办法 */
      }
    }
    return { ok: false, bytes: text.length, freed: 0, replaced: false, error: again };
  }

  // 清理过导出备份后再试一次
  const again = attempt();
  return {
    ok: !again,
    bytes: text.length,
    freed,
    replaced: false,
    error: again || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* 统计 / 清理                                                          */
/* ------------------------------------------------------------------ */

/** 图片库占用：{ count, bytes }（bytes 按 JSON 字符数算，UTF-16 约 ×2） */
export async function editorMediaStats() {
  try {
    return await dbStats();
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/**
 * 清空图片库（设置页「清除编辑器草稿」用）。
 * @returns {Promise<boolean>} 是否真的删掉了数据库
 */
export async function clearEditorMedia() {
  urlByRef.clear();
  storedKeys.clear();
  refByUrl.clear();
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined" || !indexedDB) {
      resolve(false);
      return;
    }
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve(true);
    } catch {
      resolve(false);
    }
  });
}
