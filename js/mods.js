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
  packFileOf,
  projectToRegistryInput,
  registerModImages,
  resolveCardImage,
  migrateLegacyTriggerModes,
} from "../engine/index.js";
import { buildModZip, isZipBytes, stemOf, unpackModZip } from "./mod-zip.js";
import { makePackZip } from "./pack-export.js";
import {
  MOD_STORES,
  artKeyOf,
  readArtForPack,
  readParsedPack,
  readAll,
  writeArtRecord,
  writeParsedPack,
  deleteRecord,
  putRecord,
} from "./browser-cache.js";

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
const ZIP_STORE = MOD_STORES.FILES;
/* 服务器模组的浏览器缓存：按 mods/index.txt 的文件名存原始字节，删掉后刷新会重新下载 */
const SERVER_STORE = MOD_STORES.SERVER;
const SERVER_CACHE_VERSION = 2;

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

const editorKeyOf = (packId) => `${EDITOR_PACK_ID}:${packId}`;

/**
 * 卡包是否启用。
 * 兼容旧数据：停用清单里可能还是文件名（mod.id）或 `editor:<包id>`，
 * 现在统一按「卡包 id」理解，别名命中同样算停用。
 */
export function isPackEnabled(packId, aliases = [], entries = readDisabledMods()) {
  const id = String(packId || "").trim();
  if (!id) return true;
  return !(
    entries.includes(id) ||
    entries.includes(editorKeyOf(id)) ||
    aliases.some((key) => key && entries.includes(key))
  );
}

/** 启用 / 停用一个卡包：统一写卡包 id，并清掉同包的旧键（文件名 / editor:<包id>） */
export function setPackEnabled(packId, enabled, aliases = []) {
  const id = String(packId || "").trim();
  if (!id) return;
  const drop = new Set([id, editorKeyOf(id), ...aliases.filter(Boolean)]);
  const list = readDisabledMods().filter((key) => !drop.has(key));
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

  // 旧触发迁移：加载时就地迁移（幂等），避免新版「单位集按单位分别触发」改变旧卡行为
  const migrateCard = (card) => {
    if (!card || typeof card !== "object") return;
    if (card.flow) migrateLegacyTriggerModes(card.flow);
    for (const flow of Object.values(card.flows || {})) migrateLegacyTriggerModes(flow);
    for (const member of card.members || []) {
      if (member && member.flow) migrateLegacyTriggerModes(member.flow);
    }
  };
  for (const card of [...units, ...skills, ...effects]) migrateCard(card);

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
    // 实际的启用状态按「卡包」在 loadAllMods 里统一计算
    enabled: true,
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

function readZipRecords() {
  return readAll(ZIP_STORE).then((list) =>
    (Array.isArray(list) ? list : []).filter((rec) => rec && rec.name && rec.bytes)
  );
}

function putZipRecord(record) {
  return putRecord(ZIP_STORE, record);
}

function deleteZipRecord(name) {
  return deleteRecord(ZIP_STORE, name);
}

function readServerRecords() {
  return readAll(SERVER_STORE).then((list) =>
    (Array.isArray(list) ? list : []).filter(
      (rec) => rec && rec.name && rec.bytes && rec.version === SERVER_CACHE_VERSION
    )
  );
}

function putServerRecord(record) {
  return putRecord(SERVER_STORE, record);
}

function deleteServerRecord(name) {
  return deleteRecord(SERVER_STORE, name);
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

/**
 * 缓存的校验信息是否仍和服务器一致。
 * 所有拿得到的校验信息都必须一致才算命中 —— 不能只看第一个：
 * Android 的 /storage/emulated/0 是 FUSE 挂载，文件内容改了 mtime 也可能不变，
 * 只看 Last-Modified 会把「大小已经变了」的新包误判成旧缓存。
 * 没有可比较的校验信息时倾向用缓存（离线 / 不支持 HEAD 的服务器）。
 */
function cacheMatches(record, info) {
  if (!info) return true;
  if (info.missing) return false;
  if (info.etag && record.etag && info.etag !== record.etag) return false;
  if (info.lastModified && record.lastModified && info.lastModified !== record.lastModified) return false;
  if (info.size != null && record.size != null && Number(info.size) !== Number(record.size)) return false;
  return true;
}

/** 缓存校验戳：服务器文件变化时让解析缓存失效 */
function serverStamp(record) {
  if (!record) return "";
  return [record.etag || "", record.lastModified || "", record.size || "", record.fetchedAt || ""].join("|");
}

function localStamp(record) {
  if (!record) return "";
  return String(record.importedAt || (record.bytes && record.bytes.byteLength) || "");
}

function imageMetaOf(item) {
  return { name: item.name, path: item.path, key: item.key, ext: item.ext, size: item.size };
}

/**
 * 用缓存里的「卡包 JSON + 图片 Blob」重建解包结果，避免再次纯 JS 解压。
 * 任何一张图片缺失都返回 null，回落到重新解包（保证清掉图片缓存后仍能正常显示）。
 */
function restoreZipPack(fileName, meta, art) {
  if (!meta || !Array.isArray(meta.images) || !meta.icons) return null;
  const skillMeta = Array.isArray(meta.icons.skill) ? meta.icons.skill : [];
  const effectMeta = Array.isArray(meta.icons.effect) ? meta.icons.effect : [];
  const wanted = [
    ...meta.images.map((item) => ["unit", item]),
    ...skillMeta.map((item) => ["skill", item]),
    ...effectMeta.map((item) => ["effect", item]),
  ];
  const blobs = new Map();
  for (const rec of Array.isArray(art) ? art : []) {
    if (rec && rec.key && rec.blob) blobs.set(rec.key, rec.blob);
  }
  for (const [kind, item] of wanted) {
    if (!item || !blobs.has(artKeyOf(fileName, kind, item.key))) return null;
  }

  const make = (kind, item) => {
    const blob = blobs.get(artKeyOf(fileName, kind, item.key));
    let url = "";
    try {
      url = URL.createObjectURL(blob);
    } catch {
      return null;
    }
    return { ...item, url, blob };
  };
  const images = meta.images.map((item) => make("unit", item));
  const skillIcons = skillMeta.map((item) => make("skill", item));
  const effectIcons = effectMeta.map((item) => make("effect", item));
  if ([...images, ...skillIcons, ...effectIcons].some((item) => !item)) {
    for (const item of [...images, ...skillIcons, ...effectIcons]) {
      if (item && item.url) {
        try {
          URL.revokeObjectURL(item.url);
        } catch {
          /* 忽略 */
        }
      }
    }
    return null;
  }
  const toUrls = (list) => Object.fromEntries(list.map((item) => [item.key, item.url]));
  return {
    raw: meta.raw,
    rootDir: meta.rootDir || "",
    modName: meta.modName || "",
    jsonPath: meta.jsonPath || "",
    readme: meta.readme || "",
    readmePath: meta.readmePath || "",
    warnings: Array.isArray(meta.warnings) ? meta.warnings : [],
    fileCount: meta.fileCount || 0,
    images,
    imageUrls: toUrls(images),
    icons: { skill: skillIcons, effect: effectIcons },
    iconUrls: { skill: toUrls(skillIcons), effect: toUrls(effectIcons) },
  };
}

/** 解析成功后把「JSON + 图片 Blob」写进浏览器缓存；写入失败不影响本次使用 */
function cacheZipPack(fileName, stamp, pack) {
  if (!fileName || !stamp) return;
  const meta = {
    raw: pack.raw,
    rootDir: pack.rootDir,
    modName: pack.modName,
    jsonPath: pack.jsonPath,
    readme: pack.readme,
    readmePath: pack.readmePath,
    warnings: pack.warnings,
    fileCount: pack.fileCount,
    images: (pack.images || []).map(imageMetaOf),
    icons: {
      skill: ((pack.icons && pack.icons.skill) || []).map(imageMetaOf),
      effect: ((pack.icons && pack.icons.effect) || []).map(imageMetaOf),
    },
  };
  const writes = [writeParsedPack(fileName, stamp, meta)];
  const arts = [
    ...(pack.images || []).map((item) => ["unit", item]),
    ...(((pack.icons && pack.icons.skill) || []).map((item) => ["skill", item])),
    ...(((pack.icons && pack.icons.effect) || []).map((item) => ["effect", item])),
  ];
  for (const [kind, item] of arts) {
    if (!item || !item.blob) continue;
    writes.push(
      writeArtRecord({
        key: artKeyOf(fileName, kind, item.key),
        name: fileName,
        kind,
        imageKey: item.key,
        blob: item.blob,
        size: item.size || item.blob.size || 0,
      })
    );
  }
  Promise.all(writes).catch(() => {
    /* 缓存写不进去（容量 / 隐私模式）时忽略，下次重新解包即可 */
  });
}

/** 服务器文件字节 → 模组对象（ZIP / 旧 JSON） */
async function makeServerMod(bytes, fileName, stamp = "") {
  if (isZipBytes(bytes)) return makeZipMod(bytes, fileName, "server", stamp);
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  return normalizeModPackage(JSON.parse(text), { file: fileName, source: "server" });
}

/** 由 ZIP 字节生成模组：优先用浏览器缓存（不再解压），缓存缺失时才解包并回写 */
async function makeZipMod(bytes, fileName, source, stamp = "") {
  let pack = null;
  if (stamp) {
    const cached = await readParsedPack(fileName);
    if (cached && cached.stamp === stamp && cached.meta) {
      const art = await readArtForPack(fileName);
      pack = restoreZipPack(fileName, cached.meta, art);
    }
  }
  if (!pack) {
    pack = unpackModZip(bytes, { fileName });
    cacheZipPack(fileName, stamp, pack);
  }
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
            mod = await makeServerMod(record.bytes, file, serverStamp(record));
            fromCache = true;
          }
        }
        if (!mod) {
          const got = await readServerFile(url);
          record = {
            name: file,
            bytes: got.bytes,
            etag: got.etag,
            lastModified: got.lastModified,
            size: got.size,
            fetchedAt: Date.now(),
            version: SERVER_CACHE_VERSION,
          };
          mod = await makeServerMod(got.bytes, file, serverStamp(record));
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
            record = {
              name: file,
              bytes: got.bytes,
              etag: got.etag,
              lastModified: got.lastModified,
              size: got.size,
              fetchedAt: Date.now(),
              version: SERVER_CACHE_VERSION,
            };
            const mod = await makeServerMod(got.bytes, file, serverStamp(record));
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
            mods.push(await makeServerMod(record.bytes, file, serverStamp(record)));
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

/**
 * 同一个 mod.id 出现两份时选哪份。
 * 不再比较版本 / 时间：按固定来源优先级取「更靠内」的一份
 * （本地扩展 > 服务端扩展）。想换回服务端文件就走「更新」，
 * 由用户显式决定，而不是加载时猜哪个更新。
 */
const SOURCE_RANK = Object.freeze({ server: 0, local: 1, editor: 2 });

export function preferSource(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  return (SOURCE_RANK[next.source] ?? 0) > (SOURCE_RANK[prev.source] ?? 0) ? next : prev;
}

/**
 * 同一个卡包被导入成多个文件（浏览器下载重名会存成「包 (1).zip」）时只留最新的一份。
 * 否则两份同名卡包会一起进战斗：旧副本按文件名排在后面，反而盖掉新导入的卡。
 */
function dedupeLocalMods(mods, errors) {
  const byPack = new Map();
  for (const mod of mods) {
    const key = mod.packId || mod.id;
    const prev = byPack.get(key);
    if (!prev) {
      byPack.set(key, mod);
      continue;
    }
    const a = Number(prev.importedAt) || 0;
    const b = Number(mod.importedAt) || 0;
    const [keep, drop] = b >= a ? [mod, prev] : [prev, mod];
    byPack.set(key, keep);
    errors.push(`${drop.fileName || drop.id}: 与 ${keep.fileName || keep.id} 是同一个卡包（${key}），已忽略较旧的副本`);
  }
  return [...byPack.values()];
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
          const mod = await makeZipMod(bytes, rec.name, "local", localStamp(rec));
          // 记住导入时间：同一个卡包被导入成多个文件时用它挑最新的一份
          mod.importedAt = Number(rec.importedAt) || 0;
          mods.push(mod);
        } catch (err) {
          errors.push(`${rec.name}: ${errText(err)}`);
        }
      }
    } catch (err) {
      // 没有 IndexedDB 且确实没有本地 zip 时，不必打扰用户
      errors.push(`本地 ZIP 模组读取失败：${errText(err)}`);
    }

    return { mods: dedupeLocalMods(mods, errors), errors };
  })();
  localCache.promise = promise;
  promise.catch(() => {
    localCache.promise = null;
  });
  return promise;
}

/**
 * 全部模组（服务器 + 本地）。
 * 同文件名时按固定来源优先级取一份（本地扩展优先于服务端扩展），
 * 不做版本比较；includeDisabled=false 时只返回启用的。
 */
export async function loadAllMods({ includeDisabled = true, force = false } = {}) {
  const [server, local] = await Promise.all([loadServerMods({ force }), loadLocalMods({ force })]);
  const byId = new Map();
  for (const mod of [...server.mods, ...local.mods]) {
    byId.set(mod.id, preferSource(byId.get(mod.id) || null, mod));
  }
  const disabled = readDisabledMods();
  const all = [...byId.values()].map((mod) => ({
    ...mod,
    // 启用状态按「卡包」算：旧的文件名键 / editor:<包id> 都映射到同一个卡包
    enabled: isPackEnabled(mod.packId || mod.id, [mod.id], disabled),
  }));
  applyModImages(all);
  const mods = all.filter((mod) => includeDisabled || mod.enabled);
  return { mods, errors: [...server.errors, ...local.errors] };
}

/* ------------------------------------------------------------------ */
/* 编辑器工程 / 内容汇总                                                */
/* ------------------------------------------------------------------ */

const EDITOR_OPEN_PACK_KEY = "caeworld:editor-open-pack";

/** 记下「想打开编辑器里的哪个卡包」，编辑器初始化时消费（模组管理 → 编辑） */
export function requestEditorPack(packId) {
  try {
    const id = String(packId || "").trim();
    if (id) localStorage.setItem(EDITOR_OPEN_PACK_KEY, id);
  } catch {
    /* 隐私模式等写不进去就算了 */
  }
}

/** 取走并清空「打开某个卡包」的请求 */
export function takeEditorPackRequest() {
  try {
    const id = localStorage.getItem(EDITOR_OPEN_PACK_KEY) || "";
    if (id) localStorage.removeItem(EDITOR_OPEN_PACK_KEY);
    return id;
  } catch {
    return "";
  }
}

/**
 * 编辑器工程里的卡包（草稿包 / 自建包），按 pack 分组返回成「卡包文件」的形状。
 * 这些不是模组文件：内容存在 localStorage 的工程里，名称 / 版本 / 简介取自工程内的卡包清单。
 * @returns {{packs: object[], errors: string[]}}
 */
export function loadEditorPacks() {
  const errors = [];
  let project = null;
  try {
    const packName = localStorage.getItem(EDITOR_PACK_KEY) || DEFAULT_PACK;
    const raw =
      localStorage.getItem(`${EDITOR_PROJECT_KEY}:${packName}`) ||
      localStorage.getItem(EDITOR_PROJECT_KEY);
    if (!raw) return { packs: [], errors };
    project = normalizeProject(JSON.parse(raw));
  } catch (err) {
    return { packs: [], errors: [`编辑器工程读取失败：${errText(err)}`] };
  }
  const packs = [];
  for (const meta of Array.isArray(project.packs) ? project.packs : []) {
    if (!meta || !meta.id) continue;
    let file;
    try {
      file = packFileOf(project, meta.id);
    } catch (err) {
      errors.push(`编辑器卡包 ${meta.id}: ${errText(err)}`);
      continue;
    }
    packs.push({
      ...file,
      counts: { units: file.units.length, skills: file.skills.length, effects: file.effects.length },
    });
  }
  return { packs, errors };
}

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


/** 默认包的「分裂」标准流程：被击败时召唤 2 个史莱姆。 */
const DEFAULT_SPLIT_FLOW = Object.freeze({
  schema: 1,
  kind: "flow",
  nodes: [
    { id: "trg1", type: "trigger", options: { event: "unitExit", unitScope: "self" }, pos: { x: 359, y: 175 } },
    {
      id: "summon1",
      type: "summon",
      options: { ignoreLimit: true, unitId: "default_unit_slime" },
      pos: { x: 610, y: 173 },
    },
    {
      id: "num1",
      type: "number",
      options: { mode: "const", value: 2, min: 0, max: 10 },
      pos: { x: 359, y: 396 },
    },
  ],
  links: [
    { id: "trg1.next->summon1.in", from: "trg1", port: "next", to: "summon1", portTo: "in" },
    { id: "num1.num->summon1.count", from: "num1", port: "num", to: "summon1", portTo: "count" },
  ],
});

/**
 * 默认包兼容修复：
 *  - 旧缓存 / 旧编辑器工程里的史莱姆可能还挂着不存在的 default_skill_bloodlust；
 *  - 旧的大史莱姆「分裂」可能没有流程，按描述补成「退场时召唤 2 个史莱姆」。
 * 只修默认包的两个固定 id，不碰玩家的自定义卡。
 */
function repairDefaultContent(units, skills) {
  const slime = units.find((u) => u && u.id === "default_unit_slime");
  if (slime && Array.isArray(slime.skills)) {
    slime.skills = slime.skills.filter((sid) => sid !== "default_skill_bloodlust");
  }
  const big = units.find((u) => u && u.id === "default_unit_bigslime");
  if (!big) return;
  if (!Array.isArray(big.skills)) big.skills = [];
  let split = skills.find((s) => s && s.id === "default_skill_new");
  if (!split) {
    split = {
      id: "default_skill_new",
      name: "分裂",
      type: "passive",
      valueSource: "atk",
      format: "flow",
      targets: 1,
      effects: [],
      requiresTarget: false,
      description: "被击败时，变成两个史莱姆",
      flow: structuredClone(DEFAULT_SPLIT_FLOW),
      pack: "default",
      packName: "默认包",
    };
    skills.push(split);
  }
  if (!big.skills.includes("default_skill_new")) big.skills.push("default_skill_new");
  if (!split.flow || !Array.isArray(split.flow.nodes) || split.flow.nodes.length === 0) {
    split.format = "flow";
    split.type = split.type || "passive";
    split.description = split.description || "被击败时，变成两个史莱姆";
    split.flow = structuredClone(DEFAULT_SPLIT_FLOW);
  }
}

/**
 * 汇总内容：模组（默认包也是模组）+ 编辑器工程。
 * 同一 id 后面的来源覆盖前面的来源（编辑器优先、本地模组优先于服务器模组）。
 * 启用 / 停用按「卡包 id」统一判断：同一卡包的所有来源一起生效 / 一起关闭。
 *
 * includeDisabledMods = true 时把停用的卡包也一起返回（只给「编辑器同步」用：
 * 编辑器要能编辑所有卡包，哪怕它当前是停用状态；实际进战斗 / 卡牌库的调用不带这个参数）。
 */
export async function loadContentPacks({ includeEditor = true, force = false, includeDisabledMods = false } = {}) {
  const errors = [];
  const modsRes = await loadAllMods({ includeDisabled: true, force });
  errors.push(...modsRes.errors);

  const entries = readDisabledMods();
  // 旧的按文件名的停用键 → 卡包 id
  const legacyOff = new Set();
  for (const mod of modsRes.mods) {
    if (entries.includes(mod.id)) legacyOff.add(mod.packId || mod.id);
  }
  const packOff = (packId) => {
    const id = String(packId || DEFAULT_PACK);
    return entries.includes(id) || entries.includes(`${EDITOR_PACK_ID}:${id}`) || legacyOff.has(id);
  };

  const packs = modsRes.mods.filter((m) => includeDisabledMods || !packOff(m.packId || m.id));

  if (includeEditor) {
    const editor = loadEditorPackContent();
    errors.push(...(editor.errors || []));
    packs.push(editor);
  }

  // 先过滤再覆盖：被停用的卡包不能先盖掉同名卡、再从结果里被删掉
  const merge = (key) => {
    const map = new Map();
    for (const pack of packs) {
      for (const card of pack[key] || []) {
        if (!card || typeof card !== "object" || !card.id) continue;
        if (!includeDisabledMods && packOff(card.pack)) continue;
        map.set(card.id, card);
      }
    }
    return [...map.values()];
  };

  const units = merge("units");
  const skills = merge("skills");
  repairDefaultContent(units, skills);
  const disabledMods = modsRes.mods.filter((m) => packOff(m.packId || m.id));
  return {
    packs,
    disabledModIds: disabledMods.map((m) => m.id),
    disabledPackIds: [...new Set(disabledMods.map((m) => m.packId || m.id))],
    units,
    skills,
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
    const importedAt = Date.now();
    let mod;
    try {
      mod = await makeZipMod(bytes, name, "local", String(importedAt));
    } catch (err) {
      return { ok: false, error: `ZIP 模组读取失败：${errText(err)}` };
    }
    try {
      await putZipRecord({ name, bytes, importedAt });
    } catch (err) {
      return { ok: false, error: `保存到浏览器失败：${errText(err)}` };
    }
    clearModCache();
    setPackEnabled(mod.packId || mod.id, true, [mod.id]);
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
  setPackEnabled(mod.packId || mod.id, true, [mod.id]);
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
  clearModCache();
  return true;
}

/** 删除同一个卡包的所有本地导入副本；返回被删掉的名字 */
export async function removeLocalPacks(packId) {
  const id = String(packId || "").trim();
  if (!id) return [];
  const res = await loadLocalMods({ force: true });
  const names = [];
  for (const mod of res.mods || []) {
    if (!mod || (mod.packId || mod.id) !== id) continue;
    await removeLocalMod(mod.id);
    names.push(mod.name || mod.fileName || mod.id);
  }
  return names;
}

/**
 * 强制把某个服务端卡包更新为服务器上当前的文件。
 *
 * 不做任何比较：不看包内 updatedAt、不按 id 找「服务端版本」、不比较缓存校验头，
 * 直接重新下载 mods/<文件名> 并覆盖浏览器缓存。
 * 本函数只负责「拿到服务端最新内容」；本地副本（编辑器 / 本地导入）由调用方按
 * 用户确认后的“删除所有本地修改”流程处理。
 *
 * @returns {{ok: boolean, error?: string, mod?: object}}
 */
export async function forceUpdateServerPack(pack) {
  if (!pack) return { ok: false, error: "没有卡包" };
  if (pack.source !== "server") return { ok: false, error: "只有服务端卡包可以更新" };

  let got;
  try {
    got = await readServerFile(`${MODS_DIR}/${encodeURIComponent(pack.fileName)}`);
  } catch (err) {
    return { ok: false, error: `重新下载失败：${errText(err)}` };
  }

  const record = {
    name: pack.fileName,
    bytes: got.bytes,
    etag: got.etag,
    lastModified: got.lastModified,
    size: got.size,
    fetchedAt: Date.now(),
    version: SERVER_CACHE_VERSION,
  };
  let mod;
  try {
    mod = await makeServerMod(got.bytes, pack.fileName, serverStamp(record));
  } catch (err) {
    return { ok: false, error: `卡包内容读取失败：${errText(err)}` };
  }
  try {
    await putServerRecord(record);
  } catch {
    /* 缓存写不进去也不影响本次更新 */
  }
  removedServerMods.delete(pack.fileName);
  clearModCache();
  return { ok: true, mod };
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

/** 卡 id 的包前缀替换：<old>_<type>_<key> → <new>_<type>_<key> */
export function renamePackCardId(id, oldId, newId) {
  if (typeof id !== "string" || !id) return id;
  if (oldId && id.startsWith(`${oldId}_`)) return `${newId}${id.slice(oldId.length)}`;
  const cut = id.indexOf("_");
  return cut > 0 ? `${newId}${id.slice(cut)}` : id;
}

/**
 * 复制一份卡包内容到新 id：
 * 卡 id、卡上对其它卡 id 的引用（挂载 / 流程 / ui 常量）以及 pack 字段一起改。
 * @returns {{clone: object, map: Map<string, string>}} map：旧卡 id → 新卡 id
 */
export function clonePackWithId(file, newId, newName = "") {
  const safe = file && typeof file === "object" ? file : {};
  const oldId = String(safe.id || "").trim();
  const id = String(newId || "").trim();
  const clone = structuredClone(safe);
  const lists = ["units", "skills", "effects"];
  const map = new Map();
  for (const key of lists) {
    const oldList = Array.isArray(safe[key]) ? safe[key] : [];
    const newList = Array.isArray(clone[key]) ? clone[key] : [];
    for (let i = 0; i < newList.length; i += 1) {
      const oldCard = oldList[i];
      if (!oldCard || typeof oldCard.id !== "string") continue;
      map.set(oldCard.id, renamePackCardId(oldCard.id, oldId, id));
    }
  }
  const walk = (value) => {
    if (typeof value === "string") return map.get(value) || value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) value[key] = walk(value[key]);
      return value;
    }
    return value;
  };
  for (const key of lists) {
    for (const card of clone[key] || []) {
      if (!card || typeof card !== "object") continue;
      const oldCardId = card.id;
      walk(card);
      if (oldCardId && map.has(oldCardId)) card.id = map.get(oldCardId);
      card.pack = id;
      card.packName = newName || id;
    }
  }
  clone.id = id;
  clone.name = newName || safe.name || id;
  clone.updatedAt = new Date().toISOString();
  return { clone, map };
}

/** 把一个卡包文件导出成 ZIP（卡面 / 图标按 pack / modId 现取，一并带上） */
export async function exportPackFile(file, { packId = "", readme = "" } = {}) {
  const safe = file && typeof file === "object" ? file : {};
  const id = String(packId || safe.id || "mod").trim() || "mod";
  const { bytes, warnings } = await makePackZip(safe, {
    packId: id,
    readme,
    resolveImage: (card) => resolveCardImage(card),
  });
  return { blob: new Blob([bytes], { type: "application/zip" }), name: `${id}.zip`, warnings };
}

/**
 * 另存为本地卡包：把内容复制到新 id，打包成本地 ZIP（含卡面 / 图标），默认停用。
 * 不会影响原卡包；新卡包在「模组管理」里显示为「本地」。
 */
export async function savePackAsLocal(file, { newId, name = "", readme = "" } = {}) {
  const safe = file && typeof file === "object" ? file : {};
  const id = String(newId || "").trim();
  if (!id) throw new Error("缺少新的卡包 id");
  const { clone, map } = clonePackWithId(safe, id, name);
  const oldByNew = new Map();
  for (const key of ["units", "skills", "effects"]) {
    for (const oldCard of safe[key] || []) {
      if (!oldCard || typeof oldCard.id !== "string") continue;
      const newCardId = map.get(oldCard.id);
      if (newCardId) oldByNew.set(newCardId, oldCard);
    }
  }
  const { bytes } = await makePackZip(clone, {
    packId: id,
    readme,
    resolveImage: (card) => resolveCardImage(oldByNew.get(card && card.id) || card),
  });
  const fileName = zipFileNameOf(id);
  await putZipRecord({ name: fileName, bytes, importedAt: Date.now() });
  setPackEnabled(id, false);
  clearModCache();
  return { packId: id, fileName };
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
