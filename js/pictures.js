/**
 * pictures.js —— 开屏头图（banner）
 *
 * 规则：banner 文件夹（assets/banner/）下的图片由 assets/banner/index.txt 列出，
 * **每行一个文件名**。开屏时从 index.txt 里随机抽一张，同一会话不连抽同一张。
 * 读取失败（如用 file:// 直接打开）时回落到内置的同一批文件名。
 *
 * 新增图片：把文件放进 assets/banner/，再在 index.txt 里加一行文件名即可。
 */

export const BANNER_DIR = "assets/banner";
export const BANNER_SOURCE = `${BANNER_DIR}/index.txt`;

/** 内置兜底：与 assets/banner/ 下的文件同名 */
export const FALLBACK_FILES = [
  "castorice.png",
  "cyrene1.png",
  "cyrene2.png",
  "cyrene3.png",
  "cyrene4.png",
  "evernight.png",
  "hyacine.png",
  "peach.png",
];

/** index.txt → 头图列表：[{ id, name, src }] */
export function parseBannerIndex(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"))
    .map((line) => {
      // 允许写成 "文件名" 或 "路径/文件名"，有路径时按路径取
      const file = line.split(/[\\/]/).pop();
      if (!file || file === "index.txt") return null;
      const src = /^[a-z]+:|^\//i.test(line) ? line : `${BANNER_DIR}/${encodeURIComponent(file)}`;
      return { id: file, name: file.replace(/\.[^.]+$/, ""), src, file };
    })
    .filter(Boolean);
}

/** 内置兜底列表 */
export function fallbackBanners() {
  return FALLBACK_FILES.map((file) => ({
    id: file,
    name: file.replace(/\.[^.]+$/, ""),
    src: `${BANNER_DIR}/${encodeURIComponent(file)}`,
    file,
  }));
}

/** 读取头图列表；永远 resolve（失败时用内置列表） */
export async function loadBanners(url = BANNER_SOURCE) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const banners = parseBannerIndex(await res.text());
    if (!banners.length) throw new Error("index.txt 为空或格式不对");
    return { banners, source: "file" };
  } catch (err) {
    return {
      banners: fallbackBanners(),
      source: "fallback",
      error: String((err && err.message) || err),
    };
  }
}

/**
 * 随机挑一张。按「不连抽同一张」实现：
 * 池子里去掉上一次的那张后等概率抽。
 * @param {Array<{id: string}>} pool
 * @param {string} [lastId] 上一次的 id
 * @param {() => number} [rng]
 */
export function pickBanner(pool = fallbackBanners(), lastId = "", rng = Math.random) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const candidates = pool.filter((p) => p.id !== lastId);
  const i = Math.floor(rng() * candidates.length);
  return candidates[Math.min(candidates.length - 1, Math.max(0, i))];
}

/** 兼容旧名字 */
export const pickPicture = pickBanner;

/** 按 id / 文件名找一张（调试参数 ?banner= 用） */
export function findBanner(pool, wanted) {
  if (!wanted) return null;
  const key = String(wanted).toLowerCase();
  return (
    pool.find((b) => b.id.toLowerCase() === key) ||
    pool.find((b) => b.name.toLowerCase() === key) ||
    pool.find((b) => b.file && b.file.toLowerCase() === key) ||
    null
  );
}
