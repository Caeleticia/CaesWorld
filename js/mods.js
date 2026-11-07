/**
 * mods.js —— 模组包与内容源
 *
 * 约定（与本项目静态部署一致）：
 *   mods/index.txt   每行一个模组包文件名，作为「已安装」清单
 *   mods/<文件名>    模组包本体（JSON 文本；扩展名不限，但按文本读取）
 *
 * 浏览器无法写入服务器目录，所以：
 *   · 服务器上的模组从 mods/index.txt + mods/ 读取；
 *   · 「导入」的模组存进 localStorage；
 *   · 「启用 / 停用」存进 localStorage，不修改服务器文件。
 *
 * 读出来的每张卡都会带上 pack / packName 字段，供编辑器、卡牌库、训练场筛选。
 */
import {
  DEFAULT_PACK,
  cardsOf,
  loadPack,
  normalizeProject,
  projectToRegistryInput,
} from "../engine/index.js";

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

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const fileNameOf = (name) => {
  const n = clean(name);
  if (!n) return "mod.json";
  return n.includes(".") ? n : `${n}.json`;
};

/** 解析 mods/index.txt：每行一个文件名，# 开头为注释 */
export function parseModIndex(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** 读 localStorage 里的本地模组原始 JSON 表：{ 文件名: 原始 JSON } */
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
 */
export function normalizeModPackage(raw, { file = "", source = "server" } = {}) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fileName = file || "mod.json";
  const id = fileName;
  const name =
    clean(data.modname) ||
    clean(data.name) ||
    clean(data.title) ||
    fileName.replace(/\.[^.]+$/, "");
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
  const cardPackId = declaredPackId || id;
  const cardPackName = declaredPackId ? clean(data.name) || declaredPackId : name;

  return {
    id,
    fileName,
    name,
    version,
    description,
    source,
    enabled: isModEnabled(id),
    raw: data,
    units: tagCards(units, cardPackId, cardPackName, id),
    skills: tagCards(skills, cardPackId, cardPackName, id),
    effects: tagCards(effects, cardPackId, cardPackName, id),
  };
}

async function readText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 读服务器 mods/ 目录：以 index.txt 为清单 */
export async function loadServerMods() {
  const errors = [];
  let names = [];
  try {
    names = parseModIndex(await readText(MODS_INDEX));
  } catch (err) {
    return { mods: [], errors: [`${MODS_INDEX}: ${String((err && err.message) || err)}`] };
  }

  const mods = [];
  for (const file of names) {
    try {
      const text = await readText(`${MODS_DIR}/${encodeURIComponent(file)}`);
      const raw = JSON.parse(text.replace(/^\uFEFF/, ""));
      mods.push(normalizeModPackage(raw, { file, source: "server" }));
    } catch (err) {
      errors.push(`${file}: ${String((err && err.message) || err)}`);
    }
  }
  return { mods, errors };
}

/** 读 localStorage 里导入的模组 */
export function loadLocalMods() {
  const errors = [];
  const mods = [];
  for (const [file, raw] of Object.entries(readLocalModsRaw())) {
    try {
      mods.push(normalizeModPackage(raw, { file: fileNameOf(file), source: "local" }));
    } catch (err) {
      errors.push(`${file}: ${String((err && err.message) || err)}`);
    }
  }
  return { mods, errors };
}

/**
 * 全部模组（服务器 + 本地）。
 * 同文件名时本地覆盖服务器；includeDisabled=false 时只返回启用的。
 */
export async function loadAllMods({ includeDisabled = true } = {}) {
  const server = await loadServerMods();
  const local = loadLocalMods();
  const byId = new Map();
  for (const mod of server.mods) byId.set(mod.id, mod);
  for (const mod of local.mods) byId.set(mod.id, mod);
  const disabled = readDisabledMods();
  const mods = [...byId.values()]
    .map((mod) => ({ ...mod, enabled: isModEnabled(mod.id, disabled) }))
    .filter((mod) => includeDisabled || mod.enabled);
  return { mods, errors: [...server.errors, ...local.errors] };
}

/** 默认包内容（data/pack/default/） */
export async function loadDefaultPackContent() {
  const pack = await loadPack(DEFAULT_PACK);
  return {
    id: DEFAULT_PACK_ID,
    name: DEFAULT_PACK_NAME,
    source: "default",
    enabled: true,
    units: tagCards(pack.units, DEFAULT_PACK_ID, DEFAULT_PACK_NAME),
    skills: tagCards(pack.skills, DEFAULT_PACK_ID, DEFAULT_PACK_NAME),
    effects: tagCards(pack.effects, DEFAULT_PACK_ID, DEFAULT_PACK_NAME),
    errors: pack.errors || [],
  };
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
    errors.push(`编辑器工程读取失败：${String((err && err.message) || err)}`);
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
 * 汇总内容：默认包 + 启用的模组 + 编辑器工程。
 * 同一 id 后面的来源覆盖前面的来源（编辑器优先、本地模组优先于服务器模组）。
 */
export async function loadContentPacks({ includeEditor = true } = {}) {
  const errors = [];
  const packs = [];
  const defaultPack = await loadDefaultPackContent();
  errors.push(...(defaultPack.errors || []));
  packs.push(defaultPack);

  const modsRes = await loadAllMods({ includeDisabled: true });
  errors.push(...modsRes.errors);
  const disabledModIds = modsRes.mods.filter((m) => !m.enabled).map((m) => m.id);
  packs.push(...modsRes.mods.filter((m) => m.enabled));

  if (includeEditor) {
    const editor = loadEditorPackContent();
    errors.push(...(editor.errors || []));
    packs.push(editor);
  }

  const disabled = new Set(disabledModIds);
  const merge = (key) => {
    const map = new Map();
    for (const pack of packs) {
      for (const card of pack[key] || []) {
        if (card && typeof card === "object" && card.id) map.set(card.id, card);
      }
    }
    // 编辑器工程里可能残留已停用模组的卡，这里一并过滤
    return [...map.values()].filter((card) => !disabled.has(card.modId || card.pack));
  };

  return {
    packs,
    disabledModIds,
    units: merge("units"),
    skills: merge("skills"),
    effects: merge("effects"),
    errors,
  };
}

/** 导入一份本地模组文件（File 对象）。返回 { ok, mod, error } */
export async function importModFile(file) {
  if (!file) return { ok: false, error: "没有选择文件" };
  let raw;
  try {
    const text = await file.text();
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    return { ok: false, error: `不是有效的 JSON：${String((err && err.message) || err)}` };
  }
  const fileName = fileNameOf(file.name || "mod.json");
  const mod = normalizeModPackage(raw, { file: fileName, source: "local" });
  const map = readLocalModsRaw();
  map[fileName] = raw;
  writeLocalModsRaw(map);
  setModEnabled(mod.id, true);
  return { ok: true, mod };
}

export function removeLocalMod(id) {
  const map = readLocalModsRaw();
  if (map[id]) {
    delete map[id];
    writeLocalModsRaw(map);
  }
  setModEnabled(id, true);
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
