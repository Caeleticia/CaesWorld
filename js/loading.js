/**
 * loading.js —— 载入页进度条
 *
 * 进度只反映真实启动阶段（字符库 → 图片资源 → 界面装配），不空转。
 * 加载器与 DOM 解耦：核心是 createLoader()，便于在 Node 里测试。
 */

export const STAGES = [
  { id: "boot", label: "正在启动界面", weight: 1 },
  { id: "tips", label: "正在加载你知道吗字符库", weight: 3 },
  { id: "pictures", label: "正在加载图片资源", weight: 3 },
  { id: "ui", label: "正在装配主菜单", weight: 2 },
];

/**
 * 进度核心：按阶段权重推进，进度只增不减，0..100。
 */
export function createLoader(stages = STAGES) {
  const total = stages.reduce((sum, s) => sum + s.weight, 0) || 1;
  let done = 0;
  let current = 0;

  return {
    get value() {
      return Math.round((done / total) * 100);
    },
    /** 开始第 i 个阶段 */
    begin(i) {
      current = i;
    },
    /** 完成第 i 个阶段 */
    finish(i) {
      const s = stages[i];
      if (s) done = Math.min(total, done + s.weight);
      return this.value;
    },
    /** 直接补满（兜底用） */
    complete() {
      done = total;
      return 100;
    },
    get stages() {
      return stages;
    },
    get current() {
      return current;
    },
  };
}

/**
 * 把进度核心挂到 DOM 上。
 * @param {{bar?: HTMLElement|null, pct?: HTMLElement|null, status?: HTMLElement|null}} els
 */
export function mountProgress(els) {
  const { bar, pct, status } = els;

  function render(value, label) {
    const v = Math.max(0, Math.min(100, Math.round(value)));
    if (bar) {
      bar.style.width = `${v}%`;
      bar.setAttribute("aria-valuenow", String(v));
      bar.classList.toggle("has-progress", v > 0);
    }
    if (pct) pct.textContent = `${v}%`;
    if (status && typeof label === "string") {
      status.textContent = label;
      status.classList.toggle("is-done", v >= 100);
    }
  }

  function fail(message) {
    if (status) {
      status.textContent = message || "加载遇到问题，已使用内置兜底";
      status.classList.remove("is-done");
    }
  }

  return { render, fail };
}

/**
 * 等一帧，保证进度条先画出来再干下一件事。
 * 后台标签页里 rAF 可能被浏览器暂停（document.hidden），此时用定时器兜底，
 * 否则载入流程会永远停在第一步。
 */
export const nextFrame = () =>
  new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const hidden = typeof document !== "undefined" && document.hidden;
    if (typeof requestAnimationFrame === "function" && !hidden) {
      requestAnimationFrame(() => requestAnimationFrame(done));
      setTimeout(done, 120);
    } else {
      setTimeout(done, 16);
    }
  });

/** 图片预加载：永远 resolve，返回是否成功 */
export function preloadImage(src) {
  return new Promise((resolve) => {
    if (typeof Image === "undefined" || !src) {
      resolve(false);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}
