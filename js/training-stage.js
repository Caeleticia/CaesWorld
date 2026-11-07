/**
 * training-stage.js —— 训练场舞台适配（缩放 + 位移）
 *
 * 训练场/战斗页都放在一个固定设计尺寸的 .tw-stage 里：
 *   横屏 / 桌面   960 × 470
 *   竖屏 / 手机   430 × 860
 *
 * 浏览器窗口多大都只改 transform 的 scale 与居中位移，不改内部布局，
 * 所以「卡牌在舞台里的坐标」在任何屏幕上都一致 —— 特效 canvas 直接用这套坐标，
 * 不会出现屏幕越大、特效越歪的问题。页面本身 overflow:hidden，不产生页面滚动。
 */

export const STAGE_DESIGN = Object.freeze({
  landscape: Object.freeze({ w: 960, h: 470 }),
  portrait: Object.freeze({ w: 430, h: 900 }),
});

/** 当前该用横屏还是竖屏布局：宽 >= 高 就是横屏 */
export function currentOrientation() {
  return window.innerWidth >= window.innerHeight ? "landscape" : "portrait";
}

/**
 * @param {HTMLElement} page   整页（.tw-page，用来记 data-orient）
 * @param {HTMLElement} stage  舞台（.tw-stage）
 * @param {(info: {orient: string, scale: number, changed: boolean}) => void} [onChange]
 */
export function createStageScaler(page, stage, onChange) {
  let scale = 1;
  let orient = null;
  let raf = 0;

  const apply = () => {
    raf = 0;
    if (!page || !stage) return;
    const next = currentOrientation();
    const changed = next !== orient;
    orient = next;
    page.dataset.orient = orient;
    const d = STAGE_DESIGN[orient];
    stage.style.width = `${d.w}px`;
    stage.style.height = `${d.h}px`;
    const vw = window.innerWidth || d.w;
    const vh = window.innerHeight || d.h;
    // 留一点点边，避免圆角/阴影被裁掉；上限 1.5 倍，桌面上不至于大得离谱
    scale = Math.min(vw / d.w, vh / d.h, 1.5) * 0.988;
    scale = Math.max(scale, 0.2);
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    if (typeof onChange === "function") onChange({ orient, scale, changed });
  };

  const schedule = () => {
    if (raf) return;
    // 后台标签页里 rAF 会被暂停，用定时器兜底（可见时仍然走 rAF）
    if (typeof document !== "undefined" && document.hidden) {
      raf = setTimeout(apply, 40);
    } else {
      raf = requestAnimationFrame(apply);
    }
  };

  apply();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  const vv = window.visualViewport;
  if (vv) vv.addEventListener("resize", schedule);

  return {
    apply,
    get scale() {
      return scale;
    },
    get orient() {
      return orient || currentOrientation();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      if (raf) clearTimeout(raf);
      raf = 0;
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (vv) vv.removeEventListener("resize", schedule);
    },
  };
}
