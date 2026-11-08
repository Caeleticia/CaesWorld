/**
 * pack.js —— 卡包 / 卡组文档工具（单文件模组格式）
 *
 * 应用现在使用模组包：mods/<modname>.zip 里的 <modname>/<modname>.json（kind: "caeworld-pack"）；
 * 旧的 mods/<文件名>.json 仍兼容。
 * 旧的拆分卡组格式已移除，这里只保留不依赖目录结构的通用工具。
 */

export const DEFAULT_PACK = "default";

/** 取一个卡组文件里的卡数组（数组 / {units|skills|effects} / {cards} / 单张卡 都认） */
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

/**
 * 把若干份卡牌文档合并成 { units, skills, effects }。
 * 同一 id 后面的覆盖前面的。
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
