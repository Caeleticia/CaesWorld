/**
 * pack.js —— 卡组（pack）载入与导出
 *
 * 数据按卡组分目录存放：data/pack/<卡组名>/<文件>。默认卡组是 default。
 *
 *   data/pack/default/
 *       单位.json   角色 / 单位卡
 *       技能.json   技能卡（含积木流程）
 *       效果.json   效果卡（触发 + 按积木 id 对应的流程）
 *       卡组.json   卡组说明（名字、版本、作者、包含哪些卡）
 *
 * 文件内容两种写法都认：
 *   数组           [ {…}, {…} ]
 *   对象           { "units": [...] } / { "skills": [...] } / { "effects": [...] }
 * 编辑器「导出内容包」产出的就是这种格式，直接把文件丢进卡组目录即可。
 */
import { ContentRegistry } from "./registry.js";

export const DEFAULT_PACK = "default";
export const PACK_ROOT = "data/pack";

/** 一个卡组里的三类卡文件名 */
export const PACK_FILES = Object.freeze({
  units: "单位.json",
  skills: "技能.json",
  effects: "效果.json",
  manifest: "卡组.json",
});

/** 卡组目录：data/pack/<名字>/ */
export function packDir(pack = DEFAULT_PACK) {
  return `${PACK_ROOT}/${encodeURIComponent(pack)}`;
}

/** 取一个卡组文件里的卡数组（数组 / {units|skills|effects} / {cards} 都认） */
export function cardsOf(doc, kind) {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc.filter(Boolean);
  const keys = [kind, `${kind}s`, kind === "unit" ? "units" : null, "cards"].filter(Boolean);
  for (const key of keys) {
    if (Array.isArray(doc[key])) return doc[key].filter(Boolean);
  }
  // 单张卡
  if (typeof doc.id === "string") return [doc];
  return [];
}

/** 按卡 id 的类型段推断它属于哪一类（unit / skill / effect） */
export function kindOfCard(card) {
  if (!card || typeof card.id !== "string") return null;
  const parts = card.id.split("_");
  const kind = parts[1];
  if (kind === "unit" || kind === "skill" || kind === "effect") return kind;
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`读取 ${url} 失败：HTTP ${res.status}`);
  return res.json();
}

/**
 * 读一个卡组。永远 resolve：缺文件 / 读取失败都只记在 errors 里。
 *
 * @param {string} pack 卡组名（默认 default）
 * @param {{fetchJson?: (url) => Promise<any>}} [opts] 便于离线/测试替换取数
 * @returns {Promise<{pack, manifest, units, skills, effects, errors, registry}>}
 */
export async function loadPack(pack = DEFAULT_PACK, opts = {}) {
  const get = (opts && typeof opts.fetchJson === "function" ? opts.fetchJson : fetchJson);
  const dir = packDir(pack);
  const errors = [];
  const read = async (name) => {
    try {
      return await get(`${dir}/${name}`);
    } catch (err) {
      errors.push(`${name}: ${String((err && err.message) || err)}`);
      return null;
    }
  };

  const [unitsDoc, skillsDoc, effectsDoc, manifestDoc] = await Promise.all([
    read(PACK_FILES.units),
    read(PACK_FILES.skills),
    read(PACK_FILES.effects),
    read(PACK_FILES.manifest),
  ]);

  const units = cardsOf(unitsDoc, "unit");
  const skills = cardsOf(skillsDoc, "skill");
  const effects = cardsOf(effectsDoc, "effect");

  const registry = new ContentRegistry();
  const loaded = registry.load({ units, skills, effects });

  const manifest =
    manifestDoc && typeof manifestDoc === "object" && !Array.isArray(manifestDoc)
      ? { pack, ...manifestDoc }
      : { pack, name: pack };

  return { pack, manifest, units, skills, effects, errors, registry, failed: loaded.failed };
}

/** 注册表 → 卡组文件（编辑器导出用）：{ "单位.json": …, "技能.json": … } */
export function registryToPackFiles(registry) {
  const snap = registry.snapshot();
  return {
    [PACK_FILES.units]: { schema: 1, kind: "units", units: snap.units },
    [PACK_FILES.skills]: { schema: 1, kind: "skills", skills: snap.skills },
    [PACK_FILES.effects]: { schema: 1, kind: "effects", effects: snap.effects },
  };
}

/**
 * 把若干份文档合进一个卡组文件集合（例如编辑器导出的 units/skills/effects 三份）。
 * @returns {{units: object[], skills: object[], effects: object[]}}
 */
export function mergeCards(docs) {
  const out = { units: [], skills: [], effects: [] };
  const push = (list, card) => {
    if (!card || typeof card !== "object") return;
    const kind = kindOfCard(card);
    if (!kind) return;
    const key = `${kind}s`;
    const idx = list.findIndex((c) => c.id === card.id);
    if (idx >= 0) list[idx] = card;
    else list.push(card);
  };
  for (const doc of Array.isArray(docs) ? docs : [docs]) {
    for (const kind of ["unit", "skill", "effect"]) {
      for (const card of cardsOf(doc, kind)) push(out[`${kind}s`], card);
    }
  }
  return out;
}
