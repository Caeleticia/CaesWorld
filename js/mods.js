/**
 * mods.js —— 模组包与内容源
 *
 * 约定（与本项目静态部署一致）：
 *   mods/index.txt   每行一个模组包文件名，作为「已安装」清单
 *   mods/<文件名>    模组包本体：ZIP（新格式）或 JSON（旧格式，继续兼容）
 *
 * ZIP 模组结构（modname = 模组名 = 卡包 id）：
 *
 *   modname.zip
 *   └── modname/
 *       ├── images/                单位卡面
 *       │   ├── unit1.jpg
 *       │   └── unit2.jpg
 *       ├── icons/
 *       │   ├── skill/             技能图标
 *       │   └── effect/            效果图标
 *       ├── modname.json
 *       └── README.md
 *
 * 卡 id 形如 `modname_unit_unit1`，图片按 id 最后一个字段命名（unit1.jpg）；
 * 技能 / 效果同理：icons/skill/<短 id>.*、icons/effect/<短 id>.*。
 * 图片字节解出来后会登记到引擎的图片表（registerModImages），
 * 渲染时由 resolveCardImage() / resolveCardIcon() 优先取用 —— 图片就存在模组包里，不再散落在 assets/。
 *
 * 浏览器无法写入服务器目录，所以：
 *   · 服务器上的模组从 mods/index.txt + mods/ 读取，原始字节缓存在 IndexedDB；
 *   · 「导入」的 JSON 模组存进 localStorage，ZIP 模组存进 IndexedDB；
 *   · 「启用 / 停用」存进 localStorage，不修改服务器文件。
 *
 * 默认包也统一走模组流程（mods/default.zip，pack id = default）。
 */
import {
  DEFAULT_PACK,
  cardsOf,
  normalizeProject,
  projectToRegistryInput,
  registerModImages,
  resolveCardImage,
} from "../engine/index.js";
import { buildModZip, isZipBytes, stemOf, unpackModZip } from "./mod-zip.js";
import { makePackZip } from "./pack-export.js";

export const MODS_DIR = "mods";
export const MODS_INDEX = "mods/index.txt";
export const DEFAULT_PACK_ID = "default";
export const DEFAULT_PACK_NAME = "默认包";
export const EDITOR_PACK_ID = "editor";
export const EDITOR_PACK_NAME = "编辑器工程";

const LOCAL_KEY = "caeworld:mods:local:v1";
const DISABLED_KEY = "caeworld:mods:disabled:v1";
const EDITOR_PACK_KEY = "caeworld:editor-pack";
const EDITOR_PROJECT_KEY = "caeworld:editor-project";

/* 本地导入的 ZIP 模组：localStorage 存不下图片，改用 IndexedDB */
const ZIP_DB_NAME = "caeworld-mods-zip";
const ZIP_DB_VERSION = 2;
const ZIP_STORE = "files";
/* 服务器模组的浏览器缓存：按 mods/index.txt 的文件名存原始字节，删掉后刷新会重新下载 */
const SERVER_STORE = "server";
const SERVER_CACHE_VERSION = 1;

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const fileNameOf = (name) => {
  const n = clean(name);
  if (!n) return "mod.json";
  return n.includes(".") ? n : `${n}.json`;
};
const zipFileNameOf = (name) => {
  const n = clean(name);
  if (!n) return "mod.zip";
  return n.toLowerCase().endsWith(".zip") ? n : `${n}.zip`;
};
const errText = (err) => String((err && err.message) || err);

/** 解析 mods/index.txt：每行一个文件名，# 开头为注释 */
export function parseModIndex(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 启用 / 停用（只存浏览器）                                            */
/* ------------------------------------------------------------------ */

/** 读 localStorage 里的本地 JSON 模组原始表：{ 文件名: 原始 JSON } */
export function readLocalModsRaw() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeLocalModsRaw(map) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
  } catch {
    /* 存不下就只保留当前内存状态 */
  }
}

export function readDisabledMods() {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeDisabledMods(list) {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...new Set(list)]));
  } catch {
    /* 忽略 */
  }
}

export function isModEnabled(id, disabled = readDisabledMods()) {
  return !disabled.includes(id);
}

export function setModEnabled(id, enabled) {
  const list = readDisabledMods().filter((x) => x !== id);
  if (!enabled) list.push(id);
  writeDisabledMods(list);
}

/* ------------------------------------------------------------------ */
/* 模组包规范化                                                         */
/* ------------------------------------------------------------------ */

/** 从 README 的一级标题里取一个可用的名字（JSON 没写名字时的兜底） */
function readmeTitle(text) {
  const m = String(text || "").match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

/**
 * 把卡数组统一打上卡包标记。
 * modId 用于「停用模组」过滤：卡包文件自带的 pack id 可能和文件名不同。
 */
function tagCards(list, pack, packName, modId) {
  return (Array.isArray(list) ? list : []).map((card) =>
    card && typeof card === "object" ? { ...card, pack, packName, ...(modId ? { modId } : {}) } : card
  );
}

/**
 * 把一份模组原始 JSON 规范化。
 * 支持：
 *   · 编辑器工程 { kind: "caeworld-editor-project", characters/character, skills, effects }
 *   · 内容包 { modname, version, description, units, skills, effects }
 *   · 单张单位 / 技能 / 效果卡
 * 若来自 ZIP，会附带包内元信息（README / 卡面清单 / 目录）。
 *
 * @param {object} raw
 * @param {{file?: string, source?: string, archive?: object|null}} [options]
 */
export function normalizeModPackage(raw, { file = "", source = "server", archive = null } = {}) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fileName = file || "mod.json";
  const id = fileName;
  const readme = archive && typeof archive.readme === "string" ? archive.readme : "";
  const name =
    clean(data.modname) ||
    clean(data.name) ||
    clean(data.title) ||
    readmeTitle(readme) ||
    (archive && clean(archive.modName)) ||
    stemOf(fileName);
  const version = clean(data.version);
  const description = clean(data.description);

  let units = [];
  let skills = [];
  let effects = [];

  if (data.kind === "caeworld-editor-project" || Array.isArray(data.characters) || data.character) {
    normalizeProject(data);
    const content = projectToRegistryInput(data);
    units = content.units || [];
    skills = content.skills || [];
    effects = content.effects || [];
  } else {
    // cardsOf 同时认数组 / { units: [...] } / 单张卡
    units = cardsOf(data.units, "unit");
    skills = cardsOf(data.skills, "skill");
    effects = cardsOf(data.effects, "effect");
    if (!units.length && !skills.length && !effects.length) {
      const kind = typeof data.id === "string" ? data.id.split("_")[1] : "";
      if (kind === "unit") units = [data];
      else if (kind === "skill") skills = [data];
      else if (kind === "effect") effects = [data];
    }
  }

  // 卡包文件里自带 id / name：卡按它归包（导出时卡 id 的包前缀也是它），
  // 停用过滤仍按文件名（mod.id）走。
  const declaredPackId =
    data.kind === "caeworld-pack" && typeof data.id === "string" && data.id.trim() ? data.id.trim() : "";
  const archivePackId = archive && typeof archive.modName === "string" ? archive.modName.trim() : "";
  const cardPackId = declaredPackId || archivePackId || id;
  const cardPackName = declaredPackId ? clean(data.name) || declaredPackId : name;

  const images = archive && Array.isArray(archive.images) ? archive.images : [];
  const warnings = archive && Array.isArray(archive.warnings) ? archive.warnings.slice() : [];

  return {
    id,
    fileName,
    name,
    version,
    description,
    source,
    enabled: isModEnabled(id),
    raw: data,
    /** 卡片归属的卡包 id / 显示名（可能和文件名不同） */
    packId: cardPackId,
    packName: cardPackName,
    /** ZIP 模组附加信息 */
    isZip: Boolean(archive),
    rootDir: archive && archive.rootDir ? archive.rootDir : "",
    readme,
    readmePath: archive && archive.readmePath ? archive.readmePath : "",
    images,
    imageCount: images.length,
    warnings,
    /** 原始 ZIP 字节（本地导入时保留，导出可直接还原） */
    zipBytes: archive && archive.zipBytes ? archive.zipBytes : null,
    units: tagCards(units, cardPackId, cardPackName, id),
    skills: tagCards(skills, cardPackId, cardPackName, id),
    effects: tagCards(effects, cardPackId, cardPackName, id),
  };
}

/* ------------------------------------------------------------------ */
/* IndexedDB：本地导入的 ZIP 模组 + 服务器模组缓存                       */
/* ------------------------------------------------------------------ */

function openZipDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持 IndexedDB，无法保存 ZIP 模组"));
      return;
    }
    const req = indexedDB.open(ZIP_DB_NAME, ZIP_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ZIP_STORE)) db.createObjectStore(ZIP_STORE, { keyPath: "name" });
      if (!db.objectStoreNames.contains(SERVER_STORE)) db.createObjectStore(SERVER_STORE, { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("无法打开 IndexedDB"));
    req.onblocked = () =>
      reject(new Error("IndexedDB 升级被其他页面占用，请关闭其他页面后刷新"));
  });
}

function dbRequest(storeName, mode, fn) {
  return openZipDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let req;
        const tx = db.transaction(storeName, mode);
        try {
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

function readZipRecords() {
  return dbRequest(ZIP_STORE, "readonly", (store) => store.getAll()).then((list) =>
    (Array.isArray(list) ? list : []).filter((rec) => rec && rec.name && rec.bytes)
  );
}

function putZipRecord(record) {
  return dbRequest(ZIP_STORE, "readwrite", (store) => store.put(record));
}

function deleteZipRecord(name) {
  return dbRequest(ZIP_STORE, "readwrite", (store) => store.delete(name));
}

function readServerRecords() {
  return dbRequest(SERVER_STORE, "readonly", (store) => store.getAll()).then((list) =>
    (Array.isArray(list) ? list : []).filter(
      (rec) => rec && rec.name && rec.bytes && rec.version === SERVER_CACHE_VERSION
    )
  );
}

function putServerRecord(record) {
  return dbRequest(SERVER_STORE, "readwrite", (store) => store.put(record));
}

function deleteServerRecord(name) {
  return dbRequest(SERVER_STORE, "readwrite", (store) => store.delete(name));
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

async function readText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 读服务器文件的完整响应；保留校验头，供下一次刷新判断缓存是否过期 */
async function readServerFile(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const bytes = await res.arrayBuffer();
  return {
    bytes,
    etag: res.headers.get("etag") || "",
    lastModified: res.headers.get("last-modified") || "",
    size: Number(res.headers.get("content-length")) || bytes.byteLength,
  };
}

/** 只读 HEAD，拿服务器文件的校验信息；不支持 HEAD 时返回 null（继续用缓存） */
async function headServerFile(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (res.status === 404 || res.status === 410) return { missing: true };
    if (!res.ok) return null;
    return {
      etag: res.headers.get("etag") || "",
      lastModified: res.headers.get("last-modified") || "",
      size: Number(res.headers.get("content-length")) || null,
    };
  } catch {
    return null;
  }
}

/** 缓存的校验信息是否仍和服务器一致（没有可比较的校验信息时倾向用缓存） */
function cacheMatches(record, info) {
  if (!info) return true;
  if (info.missing) return false;
  if (info.etag && record.etag) return info.etag === record.etag;
  if (info.lastModified && record.lastModified) return info.lastModified === record.lastModified;
  if (info.size != null && record.size != null) return Number(info.size) === Number(record.size);
  return true;
}

/** 服务器文件字节 → 模组对象（ZIP / 旧 JSON） */
function makeServerMod(bytes, fileName) {
  if (isZipBytes(bytes)) return makeZipMod(bytes, fileName, "server");
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  return normalizeModPackage(JSON.parse(text), { file: fileName, source: "server" });
}

/** 由 ZIP 字节生成模组（卡面先随对象带着，等合并完再登记，避免服务器 / 本地互相顶掉） */
function makeZipMod(bytes, fileName, source) {
  const pack = unpackModZip(bytes, { fileName });
  const mod = normalizeModPackage(pack.raw, {
    file: fileName,
    source,
    archive: { ...pack, zipBytes: bytes },
  });
  mod.imageUrls = pack.imageUrls;
  mod.icons = pack.icons || { skill: [], effect: [] };
  mod.iconUrls = pack.iconUrls || { skill: {}, effect: {} };
  return mod;
}

/** 把最终生效的模组卡面登记给引擎（同一个卡包以最后调用的为准） */
function applyModImages(mods) {
  for (const mod of mods) {
    if (mod.imageUrls) registerModImages(mod.packId, mod.imageUrls, "unit");
    if (mod.iconUrls && mod.iconUrls.skill) registerModImages(mod.packId, mod.iconUrls.skill, "skill");
    if (mod.iconUrls && mod.iconUrls.effect) registerModImages(mod.packId, mod.iconUrls.effect, "effect");
  }
}

/* 同一页面里多个页面（卡牌库 / 编辑器 / 训练场）会反复要模组；缓存一份即可。
   服务器模组的原始字节另存 IndexedDB，下次打开先读缓存；
   模组管理页「刷新」会强制重新下载全部服务器模组，删除缓存后刷新会补齐。 */
let serverCache = { promise: null };
let localCache = { promise: null };
/** 已在浏览器里删除、等下一次「刷新」重新缓存的服务器模组（只影响当前页面） */
const removedServerMods = new Set();

/** 清掉内存缓存（下次 load 重新读服务器 / IndexedDB） */
export function clearModCache() {
  serverCache = { promise: null };
  localCache = { promise: null };
}

/** 把当前页面删掉的服务器模组放回待加载列表；下一次 load 会重新缓存 */
export function restoreServerMods() {
  removedServerMods.clear();
  serverCache = { promise: null };
}

/** 删除某个服务器模组在浏览器里的缓存；刷新时会从服务器重新缓存 */
export async function removeServerModCache(id) {
  removedServerMods.add(id);
  try {
    await deleteServerRecord(id);
  } catch {
    /* IndexedDB 不可用时只靠 removedServerMods 隐藏 */
  }
  serverCache = { promise: null };
  return true;
}

function visibleServerMods(result) {
  if (!removedServerMods.size) return result;
  return { ...result, mods: result.mods.filter((mod) => !removedServerMods.has(mod.id)) };
}

/** 读服务器 mods/ 目录：以 index.txt 为清单，优先读浏览器缓存，缺失 / 过期 / force 时重新下载 */
export function loadServerMods({ force = false } = {}) {
  if (serverCache.promise && !force) return serverCache.promise.then(visibleServerMods);
  const promise = (async () => {
    const errors = [];
    let names = [];
    try {
      names = parseModIndex(await readText(MODS_INDEX));
    } catch (err) {
      return { mods: [], errors: [`${MODS_INDEX}: ${errText(err)}`] };
    }

    let cached = new Map();
    try {
      for (const rec of await readServerRecords()) cached.set(rec.name, rec);
    } catch {
      /* 没有 IndexedDB / 缓存损坏：全部按未缓存处理 */
    }

    // 服务器清单里已经没有的文件，顺手清掉旧缓存
    const wanted = new Set(names);
    for (const name of cached.keys()) {
      if (wanted.has(name)) continue;
      cached.delete(name);
      deleteServerRecord(name).catch(() => {});
    }

    const mods = [];
    for (const file of names) {
      if (removedServerMods.has(file)) continue;
      const url = `${MODS_DIR}/${encodeURIComponent(file)}`;
      let record = cached.get(file) || null;
      let fromCache = false;
      try {
        let mod = null;
        if (record && !force) {
          const info = await headServerFile(url);
          if (cacheMatches(record, info)) {
            mod = makeServerMod(record.bytes, file);
            fromCache = true;
          }
        }
        if (!mod) {
          const got = await readServerFile(url);
          mod = makeServerMod(got.bytes, file);
          record = {
            name: file,
            bytes: got.bytes,
            etag: got.etag,
            lastModified: got.lastModified,
            size: got.size,
            fetchedAt: Date.now(),
            version: SERVER_CACHE_VERSION,
          };
          try {
            await putServerRecord(record);
            cached.set(file, record);
          } catch {
            /* 缓存写不进去也不影响本次读取 */
          }
        }
        mods.push(mod);
      } catch (err) {
        // 网络失败时回退旧缓存，至少让已经下载过的模组还能用；404 说明服务器文件已删，不能回退
        const missing = err && (err.status === 404 || err.status === 410);
        if (fromCache || missing) {
          cached.delete(file);
          await deleteServerRecord(file).catch(() => {});
        }
        // 缓存本身解析失败：丢掉缓存并重新下载一次
        if (fromCache && !missing) {
          try {
            const got = await readServerFile(url);
            const mod = makeServerMod(got.bytes, file);
            record = {
              name: file,
              bytes: got.bytes,
              etag: got.etag,
              lastModified: got.lastModified,
              size: got.size,
              fetchedAt: Date.now(),
              version: SERVER_CACHE_VERSION,
            };
            try {
              await putServerRecord(record);
              cached.set(file, record);
            } catch {
              /* 缓存写不进去也不影响本次读取 */
            }
            mods.push(mod);
            continue;
          } catch {
            /* 重新下载也失败，走下面的错误 */
          }
        }
        if (record && record.bytes && !missing) {
          try {
            mods.push(makeServerMod(record.bytes, file));
            errors.push(`${file}: ${errText(err)}（已使用浏览器缓存）`);
            continue;
          } catch {
            /* 缓存本身也坏了，走下面的错误 */
          }
        }
        errors.push(`${file}: ${errText(err)}`);
      }
    }
    return { mods, errors };
  })();
  serverCache.promise = promise;
  promise.catch(() => {
    serverCache.promise = null;
  });
  return promise.then(visibleServerMods);
}

/** 读浏览器里导入的模组（localStorage 的 JSON + IndexedDB 的 ZIP） */
export function loadLocalMods({ force = false } = {}) {
  if (localCache.promise && !force) return localCache.promise;
  const promise = (async () => {
    const errors = [];
    const mods = [];

    for (const [file, raw] of Object.entries(readLocalModsRaw())) {
      try {
        mods.push(normalizeModPackage(raw, { file: fileNameOf(file), source: "local" }));
      } catch (err) {
        errors.push(`${file}: ${errText(err)}`);
      }
    }

    try {
      const records = await readZipRecords();
      for (const rec of records) {
        try {
          const bytes = rec.bytes instanceof ArrayBuffer ? rec.bytes : new Uint8Array(rec.bytes).buffer;
          mods.push(makeZipMod(bytes, rec.name, "local"));
        } catch (err) {
          errors.push(`${rec.name}: ${errText(err)}`);
        }
      }
    } catch (err) {
      // 没有 IndexedDB 且确实没有本地 zip 时，不必打扰用户
      errors.push(`本地 ZIP 模组读取失败：${errText(err)}`);
    }

    return { mods, errors };
  })();
  localCache.promise = promise;
  promise.catch(() => {
    localCache.promise = null;
  });
  return promise;
}

/**
 * 全部模组（服务器 + 本地）。
 * 同文件名时本地覆盖服务器；includeDisabled=false 时只返回启用的。
 */
export async function loadAllMods({ includeDisabled = true, force = false } = {}) {
  const [server, local] = await Promise.all([loadServerMods({ force }), loadLocalMods({ force })]);
  const byId = new Map();
  for (const mod of server.mods) byId.set(mod.id, mod);
  for (const mod of local.mods) byId.set(mod.id, mod);
  const disabled = readDisabledMods();
  const all = [...byId.values()].map((mod) => ({ ...mod, enabled: isModEnabled(mod.id, disabled) }));
  applyModImages(all);
  const mods = all.filter((mod) => includeDisabled || mod.enabled);
  return { mods, errors: [...server.errors, ...local.errors] };
}

/* ------------------------------------------------------------------ */
/* 编辑器工程 / 内容汇总                                                */
/* ------------------------------------------------------------------ */

/** 编辑器本地工程内容 */
export function loadEditorPackContent() {
  const errors = [];
  const packName = (() => {
    try {
      return localStorage.getItem(EDITOR_PACK_KEY) || DEFAULT_PACK;
    } catch {
      return DEFAULT_PACK;
    }
  })();
  try {
    const raw =
      localStorage.getItem(`${EDITOR_PROJECT_KEY}:${packName}`) ||
      localStorage.getItem(EDITOR_PROJECT_KEY);
    if (!raw) {
      return {
        id: EDITOR_PACK_ID,
        name: `${EDITOR_PACK_NAME}（${packName}）`,
        source: "editor",
        enabled: true,
        units: [],
        skills: [],
        effects: [],
        errors,
      };
    }
    const project = normalizeProject(JSON.parse(raw));
    const content = projectToRegistryInput(project);
    const packId = packName;
    const packLabel = packName === DEFAULT_PACK ? DEFAULT_PACK_NAME : packName;
    // 工程里已经带 pack 的卡保留原标记；没有的按当前卡组归包
    const keepOrTag = (list) =>
      (Array.isArray(list) ? list : []).map((card) =>
        card && typeof card === "object" && !card.pack
          ? { ...card, pack: packId, packName: packLabel }
          : card
      );
    return {
      id: EDITOR_PACK_ID,
      name: `${EDITOR_PACK_NAME}（${packName}）`,
      source: "editor",
      enabled: true,
      units: keepOrTag(content.units),
      skills: keepOrTag(content.skills),
      effects: keepOrTag(content.effects),
      errors,
    };
  } catch (err) {
    errors.push(`编辑器工程读取失败：${errText(err)}`);
    return {
      id: EDITOR_PACK_ID,
      name: `${EDITOR_PACK_NAME}（${packName}）`,
      source: "editor",
      enabled: true,
      units: [],
      skills: [],
      effects: [],
      errors,
    };
  }
}

/**
 * 汇总内容：启用的模组（默认包也是模组）+ 编辑器工程。
 * 同一 id 后面的来源覆盖前面的来源（编辑器优先、本地模组优先于服务器模组）。
 */
export async function loadContentPacks({ includeEditor = true } = {}) {
  const errors = [];
  const packs = [];

  const modsRes = await loadAllMods({ includeDisabled: true });
  errors.push(...modsRes.errors);
  const disabledMods = modsRes.mods.filter((m) => !m.enabled);
  const disabledModIds = disabledMods.map((m) => m.id);
  // 停用模组对应的卡包 id：编辑器工程里没有 modId，只能按 pack 清理
  const disabledPackIds = [
    ...new Set(
      disabledMods
        .flatMap((m) => [...(m.units || []), ...(m.skills || []), ...(m.effects || [])])
        .map((card) => card && card.pack)
        .filter(Boolean)
    ),
  ];
  packs.push(...modsRes.mods.filter((m) => m.enabled));

  if (includeEditor) {
    const editor = loadEditorPackContent();
    errors.push(...(editor.errors || []));
    packs.push(editor);
  }

  const disabled = new Set(disabledModIds);
  const disabledPacks = new Set(disabledPackIds);
  const merge = (key) => {
    const map = new Map();
    for (const pack of packs) {
      for (const card of pack[key] || []) {
        if (card && typeof card === "object" && card.id) map.set(card.id, card);
      }
    }
    // 模组卡按 modId 过滤；编辑器工程里的卡没有 modId，按所属卡包过滤
    return [...map.values()].filter(
      (card) => !disabledPacks.has(card.pack) && (!card.modId || !disabled.has(card.modId))
    );
  };

  return {
    packs,
    disabledModIds,
    disabledPackIds,
    units: merge("units"),
    skills: merge("skills"),
    effects: merge("effects"),
    errors,
  };
}

/* ------------------------------------------------------------------ */
/* 导入 / 删除 / 导出                                                   */
/* ------------------------------------------------------------------ */

/** 导入一份本地模组文件（File 对象，ZIP 或 JSON）。返回 { ok, mod, error } */
export async function importModFile(file) {
  if (!file) return { ok: false, error: "没有选择文件" };

  let bytes;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    return { ok: false, error: `读取文件失败：${errText(err)}` };
  }

  if (isZipBytes(bytes)) {
    const name = zipFileNameOf(file.name || "mod.zip");
    let mod;
    try {
      mod = makeZipMod(bytes, name, "local");
    } catch (err) {
      return { ok: false, error: `ZIP 模组读取失败：${errText(err)}` };
    }
    try {
      await putZipRecord({ name, bytes, importedAt: Date.now() });
    } catch (err) {
      return { ok: false, error: `保存到浏览器失败：${errText(err)}` };
    }
    clearModCache();
    setModEnabled(mod.id, true);
    return { ok: true, mod: { ...mod, enabled: true } };
  }

  let raw;
  try {
    const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `不是有效的 ZIP 或 JSON：${errText(err)}` };
  }
  const fileName = fileNameOf(file.name || "mod.json");
  let mod;
  try {
    mod = normalizeModPackage(raw, { file: fileName, source: "local" });
  } catch (err) {
    return { ok: false, error: `模组内容无效：${errText(err)}` };
  }
  const map = readLocalModsRaw();
  map[fileName] = raw;
  writeLocalModsRaw(map);
  clearModCache();
  setModEnabled(mod.id, true);
  return { ok: true, mod };
}

/** 删除本地导入的模组（ZIP 从 IndexedDB，JSON 从 localStorage） */
export async function removeLocalMod(id) {
  const map = readLocalModsRaw();
  if (map[id]) {
    delete map[id];
    writeLocalModsRaw(map);
  }
  try {
    await deleteZipRecord(id);
  } catch {
    /* 不在 IndexedDB 里（旧 JSON 模组）就忽略 */
  }
  setModEnabled(id, true);
  clearModCache();
  return true;
}

/** 导出用数据：优先原样输出，保证编辑器工程仍可导回编辑器 */
export function modToExport(mod) {
  if (!mod) return null;
  if (mod.raw && typeof mod.raw === "object" && Object.keys(mod.raw).length) return mod.raw;
  return {
    modname: mod.name,
    version: mod.version,
    description: mod.description,
    units: { schema: 1, kind: "units", units: mod.units },
    skills: { schema: 1, kind: "skills", skills: mod.skills },
    effects: { schema: 1, kind: "effects", effects: mod.effects },
  };
}

/** 把模组重新打包成 ZIP 字节（服务器模组导出 / 本地 zip 丢失原件时兜底） */
export async function buildModZipBytes(mod) {
  if (!mod) throw new Error("没有模组");
  if (mod.zipBytes) return mod.zipBytes instanceof Uint8Array ? mod.zipBytes : new Uint8Array(mod.zipBytes);
  const rootDir = mod.rootDir || mod.packId || stemOf(mod.fileName) || "mod";
  const images = [];
  for (const image of mod.images || []) {
    if (!image || !image.url) continue;
    try {
      const res = await fetch(image.url);
      const data = await res.arrayBuffer();
      images.push({ name: image.name, data });
    } catch {
      /* 单个图片失败不阻断导出 */
    }
  }
  const icons = [];
  for (const kind of ["skill", "effect"]) {
    for (const icon of (mod.icons && mod.icons[kind]) || []) {
      if (!icon || !icon.url) continue;
      try {
        const res = await fetch(icon.url);
        const data = await res.arrayBuffer();
        icons.push({ kind, name: icon.name, data });
      } catch {
        /* 单个图标失败不阻断导出 */
      }
    }
  }
  return buildModZip({ rootDir, json: mod.raw, readme: mod.readme, images, icons });
}

/**
 * 导出模组：一律输出模组 ZIP（旧 JSON 模组会现打包成 zip，卡面一并带上）。
 * @returns {Promise<{blob: Blob, name: string, warnings?: string[]}|null>}
 */
export async function exportMod(mod) {
  if (!mod) return null;
  if (mod.isZip) {
    const bytes = await buildModZipBytes(mod);
    const name = mod.fileName && mod.fileName.toLowerCase().endsWith(".zip")
      ? mod.fileName
      : `${mod.rootDir || mod.packId || stemOf(mod.fileName)}.zip`;
    return { blob: new Blob([bytes], { type: "application/zip" }), name };
  }
  const packId = mod.packId || stemOf(mod.fileName) || "mod";
  const { bytes, warnings } = await makePackZip(modToExport(mod), {
    packId,
    readme: mod.readme || "",
    resolveImage: (card) =>
      resolveCardImage({ ...card, pack: card.pack || mod.packId, modId: mod.id }),
  });
  return { blob: new Blob([bytes], { type: "application/zip" }), name: `${packId}.zip`, warnings };
}
