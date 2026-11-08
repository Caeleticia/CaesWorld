/**
 * mod-zip.js —— 模组 ZIP 包的结构解析 / 打包
 *
 * 约定结构（modname = 模组名，也是卡包 id）：
 *
 *   modname.zip
 *   └── modname/
 *       ├── images/                单位卡面
 *       │   ├── unit1.jpg
 *       │   └── unit2.jpg
 *       ├── icons/
 *       │   ├── skill/             技能图标
 *       │   │   └── choco.png
 *       │   └── effect/            效果图标
 *       │       └── math.png
 *       ├── modname.json
 *       └── README.md
 *
 * · 卡 id 形如 `modname_unit_unit1`，图片按「id 的最后一个字段」命名：
 *   images/unit1.jpg ↔ modname_unit_unit1；
 *   icons/skill/choco.png ↔ modname_skill_choco；
 *   icons/effect/math.png ↔ modname_effect_math。扩展名不限（png / jpg / webp…）。
 * · README.md 是模组说明（给人和模组管理页看的信息），可缺省。
 * · 解析时对目录层级做有限容错：找不到 `<modname>/` 包裹时也接受 JSON 直接在根目录。
 *
 * 本模块只负责「结构 → 内存数据」和「数据 → ZIP 字节」，不碰 localStorage。
 */
import { isZip, makeZip, readZip } from "./zip.js";

/** 支持的卡面扩展名（小写，不含点） */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif", "svg", "bmp"];

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

const UTF8_BOM = /^\uFEFF/;

const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
function decodeUtf8(bytes) {
  if (decoder) return decoder.decode(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

export function isZipBytes(input) {
  try {
    return isZip(input);
  } catch {
    return false;
  }
}

/** 去掉扩展名 */
export function stemOf(name) {
  const base = String(name || "").replace(/^.*[\\/]/, "");
  return base.replace(/\.[^.]+$/, "");
}

/** 路径的父目录（无目录时返回 ""） */
export function dirOf(path) {
  const norm = String(path || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i < 0 ? "" : norm.slice(0, i);
}

function baseOf(path) {
  const norm = String(path || "").replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

function extOf(path) {
  const base = baseOf(path);
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
}

function isImagePath(path) {
  return IMAGE_EXTENSIONS.includes(extOf(path));
}

/** 图片扩展名 → MIME */
export function imageMime(path) {
  return MIME[extOf(path)] || "application/octet-stream";
}

function jsonRank(path, zipBase) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 2) {
    const [dir, file] = parts;
    const fileStem = stemOf(file);
    if (fileStem.toLowerCase() === dir.toLowerCase() && (!zipBase || fileStem.toLowerCase() === zipBase.toLowerCase())) {
      return 0;
    }
    if (fileStem.toLowerCase() === dir.toLowerCase()) return 1;
    return 2;
  }
  if (parts.length === 1) return 3;
  if (parts.length >= 2 && zipBase && base.toLowerCase() === zipBase.toLowerCase()) return 1;
  return 4;
}

/** 读取一个图片目录（images/ 或 icons/<kind>/），返回图片清单 + 小写短名 → blob URL */
function collectImageDir(paths, entries, prefix, label, { createUrls = true, warnings = [] } = {}) {
  const list = [];
  const urls = {};
  const seen = new Set();
  for (const path of paths) {
    if (!path.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (!isImagePath(path)) {
      warnings.push(`忽略非图片文件：${path}`);
      continue;
    }
    const name = baseOf(path);
    const key = stemOf(name).toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      warnings.push(`${label}名重复，后一个忽略：${path}`);
      continue;
    }
    seen.add(key);
    const data = entries.get(path);
    let url = "";
    if (createUrls && typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
      try {
        url = URL.createObjectURL(new Blob([data], { type: imageMime(path) }));
      } catch {
        url = "";
      }
    }
    list.push({ name, path, key, ext: extOf(path), size: data.length, url });
    if (url) urls[key] = url;
  }
  list.sort((a, b) => a.key.localeCompare(b.key));
  return { list, urls, seen };
}

/**
 * 解包模组 ZIP。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{fileName?: string, createUrls?: boolean}} [options]
 * @returns {{
 *   raw: object,
 *   rootDir: string,
 *   modName: string,
 *   jsonPath: string,
 *   readme: string,
 *   readmePath: string,
 *   images: Array<{name: string, path: string, key: string, ext: string, size: number, url: string}>,
 *   imageUrls: Record<string, string>,
 *   icons: { skill: Array, effect: Array },
 *   iconUrls: { skill: Record<string, string>, effect: Record<string, string> },
 *   warnings: string[],
 *   fileCount: number
 * }}
 */
export function unpackModZip(bytes, { fileName = "", createUrls = true, includeEntries = false } = {}) {
  const entries = readZip(bytes);
  const paths = [...entries.keys()].filter((path) => !path.endsWith("/"));
  if (!paths.length) throw new Error("ZIP 是空的");

  // ---- 找模组 JSON ----
  const zipBase = stemOf(fileName);
  const jsonCandidates = paths.filter((path) => path.toLowerCase().endsWith(".json"));
  if (!jsonCandidates.length) throw new Error("ZIP 里没有 .json 文件（应为 modname/modname.json）");
  jsonCandidates.sort((a, b) => jsonRank(a, zipBase) - jsonRank(b, zipBase) || a.localeCompare(b));

  const jsonPath = jsonCandidates[0];
  const rootDir = dirOf(jsonPath);
  const jsonName = baseOf(jsonPath);
  let modName = stemOf(jsonName) || stemOf(rootDir) || zipBase;

  const warnings = [];
  if (jsonCandidates.length > 1) {
    warnings.push(`ZIP 内有多个 JSON，使用 ${jsonPath}，其余忽略`);
  }

  // ---- 根目录 / 命名检查 ----
  if (rootDir && basenameOfDir(rootDir) !== modName) {
    // 允许 <folder>/<other>.json，但按规范应当同名，给出提示
    if (!zipBase || basenameOfDir(rootDir).toLowerCase() !== modName.toLowerCase()) {
      warnings.push(`目录名「${basenameOfDir(rootDir)}」与 JSON 名「${modName}」不一致`);
    }
  }
  if (zipBase && modName && zipBase.toLowerCase() !== modName.toLowerCase()) {
    warnings.push(`ZIP 文件名「${zipBase}」与模组名「${modName}」不一致`);
  }
  // JSON 必须在根目录或一层子目录里，避免误吞嵌套的无关文件
  if (jsonPath.split("/").length > 2) {
    warnings.push(`JSON 位于较深层级：${jsonPath}`);
  }

  // ---- JSON 本体 ----
  const jsonText = decodeUtf8(entries.get(jsonPath)).replace(UTF8_BOM, "");
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`${jsonName} 不是有效的 JSON：${String((err && err.message) || err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${jsonName} 的顶层必须是对象`);
  }

  // ---- README.md ----
  const lowerPaths = new Map(paths.map((path) => [path.toLowerCase(), path]));
  const readmePath =
    lowerPaths.get(`${rootDir ? `${rootDir}/` : ""}readme.md`.toLowerCase()) ||
    lowerPaths.get(`${rootDir ? `${rootDir}/` : ""}readme.txt`.toLowerCase()) ||
    "";
  const readme = readmePath ? decodeUtf8(entries.get(readmePath)).replace(UTF8_BOM, "") : "";

  // ---- images/（单位卡面） + icons/skill、icons/effect（技能 / 效果图标） ----
  const basePrefix = `${rootDir ? `${rootDir}/` : ""}`;
  const unitArt = collectImageDir(paths, entries, `${basePrefix}images/`, "卡面", { createUrls, warnings });
  const skillArt = collectImageDir(paths, entries, `${basePrefix}icons/skill/`, "技能图标", {
    createUrls,
    warnings,
  });
  const effectArt = collectImageDir(paths, entries, `${basePrefix}icons/effect/`, "效果图标", {
    createUrls,
    warnings,
  });
  const images = unitArt.list;
  const imageUrls = unitArt.urls;
  const icons = { skill: skillArt.list, effect: effectArt.list };
  const iconUrls = { skill: skillArt.urls, effect: effectArt.urls };

  // 单位 / 技能 / 效果 id 与图片名做一次轻量对应检查（只提示，不阻断）
  const units = Array.isArray(raw.units) ? raw.units : [];
  if (units.length && images.length) {
    for (const unit of units) {
      if (!unit || typeof unit.id !== "string") continue;
      const parsed = parseUnitKey(unit.id);
      if (parsed && !unitArt.seen.has(parsed.toLowerCase())) {
        warnings.push(`单位 ${unit.id} 没有对应卡面（images/${parsed}.*）`);
      }
    }
  }
  const skillCards = Array.isArray(raw.skills) ? raw.skills : [];
  if (skillCards.length && icons.skill.length) {
    for (const skill of skillCards) {
      if (!skill || typeof skill.id !== "string") continue;
      const key = parseUnitKey(skill.id);
      if (key && !skillArt.seen.has(key.toLowerCase())) {
        warnings.push(`技能 ${skill.id} 没有对应图标（icons/skill/${key}.*）`);
      }
    }
  }
  const effectCards = Array.isArray(raw.effects) ? raw.effects : [];
  if (effectCards.length && icons.effect.length) {
    for (const effect of effectCards) {
      if (!effect || typeof effect.id !== "string") continue;
      const key = parseUnitKey(effect.id);
      if (key && !effectArt.seen.has(key.toLowerCase())) {
        warnings.push(`效果 ${effect.id} 没有对应图标（icons/effect/${key}.*）`);
      }
    }
  }

  return {
    raw,
    rootDir,
    modName,
    jsonPath,
    readme,
    readmePath,
    images,
    imageUrls,
    icons,
    iconUrls,
    warnings,
    fileCount: paths.length,
    ...(includeEntries ? { entries } : {}),
  };
}

function basenameOfDir(path) {
  const norm = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

/** 卡 id 的最后一个字段（`modname_unit_unit1` → `unit1`；技能 / 效果同理） */
export function parseUnitKey(id) {
  if (typeof id !== "string") return "";
  const parts = id.split("_").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * 生成模组 ZIP 字节。
 * @param {{
 *   rootDir: string,
 *   json: object,
 *   readme?: string,
 *   images?: Array<{name: string, data: Uint8Array|ArrayBuffer}>
 * }} pack
 * @returns {Uint8Array}
 */
export function buildModZip({ rootDir, json, readme = "", images = [], icons = [] }) {
  const root = String(rootDir || "mod").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "mod";
  const entries = [
    { name: `${root}/${root}.json`, data: `${JSON.stringify(json, null, 2)}\n` },
  ];
  if (readme) entries.push({ name: `${root}/README.md`, data: readme });
  for (const image of images) {
    if (!image || !image.name || !image.data) continue;
    entries.push({ name: `${root}/images/${sanitizeFileName(image.name)}`, data: image.data });
  }
  for (const icon of icons) {
    if (!icon || !icon.name || !icon.data) continue;
    const kind = String(icon.kind || "").toLowerCase();
    if (kind !== "skill" && kind !== "effect") continue;
    entries.push({ name: `${root}/icons/${kind}/${sanitizeFileName(icon.name)}`, data: icon.data });
  }
  return makeZip(entries);
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/]/g, "_");
}
