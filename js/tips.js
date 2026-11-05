/**
 * tips.js —— 「你知道吗」字符库
 *
 * 字符库来自 data/tips.txt，每行一条。读取与抽取都写成纯函数（不碰 DOM），
 * 这样 Node 里可以直接跑单测。
 *
 * file:// 打开时 fetch 会被按 CORS 拦掉，此时回落到内置兜底字符库，
 * 并把来源写进 <meta name="cw-tips-source">，方便排查。
 */

/** 内置兜底：与 data/tips.txt 同义，仅在无法读取文件时使用 */
export const FALLBACK_TIPS = [
  "感谢游玩我们的项目~",
  "据说这里的文字会发生变化哦",
  "饿就吃饭",
  "纳努克！我为你带来毁灭啦！",
];

/** 文本 → 条目数组：按行切分、去首尾空白、丢弃空行 */
export function parseTips(text) {
  if (typeof text !== "string") return [];
  return text
    .replace(/^\uFEFF/, "") // 去掉可能存在的 BOM
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 随机取一个 0..n-1 的下标 */
export function randomIndex(n, rng = Math.random) {
  if (!Number.isInteger(n) || n <= 0) return -1;
  const i = Math.floor(rng() * n);
  return Math.min(n - 1, Math.max(0, i));
}

/**
 * 抽取一条：尽量不和上一条重复（条目数 > 1 时保证不重复）。
 * @param {string[]} tips 条目
 * @param {number} last 上一条的下标，-1 表示没有
 * @param {() => number} rng 随机源，便于测试
 * @returns {{index: number, text: string}}
 */
export function pickTip(tips, last = -1, rng = Math.random) {
  if (!Array.isArray(tips) || tips.length === 0) return { index: -1, text: "" };
  if (tips.length === 1) return { index: 0, text: tips[0] };

  const pool = [];
  for (let i = 0; i < tips.length; i += 1) {
    if (i !== last) pool.push(i);
  }
  const index = pool[randomIndex(pool.length, rng)];
  return { index, text: tips[index] };
}

/**
 * 读取字符库。永远 resolve：失败时用兜底并报告 ok=false。
 * @returns {Promise<{tips: string[], source: "file" | "fallback", error?: string}>}
 */
export async function loadTips(url = "data/tips.txt") {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tips = parseTips(await res.text());
    if (tips.length === 0) throw new Error("字符库为空");
    return { tips, source: "file" };
  } catch (err) {
    return { tips: [...FALLBACK_TIPS], source: "fallback", error: String(err && err.message || err) };
  }
}

/**
 * 把「你知道吗」接到一个元素上：
 *  - 初次显示 / refresh() 时换一条（不连续重复）
 *  - 可选定时轮换
 * @param {HTMLElement|null} el
 * @param {string[]} tips
 * @param {{interval?: number, placeholder?: string}} [options]
 */
export function mountTip(el, tips, options = {}) {
  const { interval = 0, placeholder = "正在翻开小纸条…" } = options;
  if (!el) return { refresh() {}, stop() {}, get index() { return -1; } };

  let last = -1;
  let timer = 0;

  function setText(text) {
    el.textContent = text;
  }

  function refresh() {
    const { index, text } = pickTip(tips, last);
    if (index < 0) {
      setText(placeholder);
      return;
    }
    last = index;
    // 翻页动画：先退出再进入
    el.classList.remove("is-in");
    el.classList.add("is-out");
    const commit = () => {
      setText(text);
      el.classList.remove("is-out");
      // 强制重排以重启动画
      void el.offsetWidth;
      el.classList.add("is-in");
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(commit, 170));
    } else {
      commit();
    }
  }

  function start() {
    stop();
    if (interval > 0) timer = setInterval(refresh, interval);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = 0;
  }

  // 先占位，避免闪烁
  setText(placeholder);
  refresh();
  start();

  return {
    refresh,
    stop,
    get index() { return last; },
  };
}
