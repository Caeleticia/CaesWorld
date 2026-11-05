/**
 * pictures.js —— 右侧空白区域的随机图片池
 *
 * 目前只有 castorice / hyacine 两张，随机取一张；刷新不连抽同一张（>1 张时）。
 */
export const PICTURES = [
  { id: "castorice", name: "Castorice", src: "assets/pictures/castorice.png" },
  { id: "hyacine", name: "Hyacine", src: "assets/pictures/hyacine.png" },
];

/**
 * 随机挑一张。
 * @param {Array<{id: string, name: string, src: string}>} pool
 * @param {string} [lastId] 上一次的 id，尽量不重复
 * @param {() => number} [rng]
 */
export function pickPicture(pool = PICTURES, lastId = "", rng = Math.random) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const candidates = pool.filter((p) => p.id !== lastId);
  const i = Math.floor(rng() * candidates.length);
  return candidates[Math.min(candidates.length - 1, Math.max(0, i))];
}

/**
 * 把随机图片挂到 <img> 上。换图时先播退出动画再换 src。
 * @param {HTMLImageElement|null} img
 * @param {HTMLElement|null} tag 图片下方的名字标签
 * @param {{pool?: typeof PICTURES}} [options]
 */
export function mountPicture(img, tag, options = {}) {
  const pool = options.pool || PICTURES;
  let lastId = "";

  function show(entry) {
    if (!entry) return null;
    if (img) {
      img.src = entry.src;
      img.alt = entry.name;
      img.dataset.picId = entry.id;
    }
    if (tag) {
      tag.textContent = entry.name;
      tag.hidden = false;
    }
    return entry;
  }

  function roll(animate = false) {
    const entry = pickPicture(pool, lastId);
    if (!entry) return null;
    lastId = entry.id;

    const frame = img && img.parentElement;
    if (animate && frame) {
      frame.classList.add("is-swapping");
      setTimeout(() => frame.classList.remove("is-swapping"), 260);
      setTimeout(() => show(entry), 180);
    } else {
      show(entry);
    }
    return entry;
  }

  const first = pickPicture(pool, "");
  lastId = first ? first.id : "";
  show(first);

  return { roll, get current() { return lastId; } };
}
