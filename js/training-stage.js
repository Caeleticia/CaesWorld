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

/**
 * 计算战斗区卡牌的网格布局。
 *
 * 规则：
 *  - 先按正常间距 20 尝试所有列数，取「卡牌最大」的排法；
 *  - 尽量不要小于「6 个单位时」的卡牌尺寸；装不下时依次缩小间距（20 → 8）；
 *  - 间距缩到最小仍装不下，就保持 6 单位尺寸并让战斗区内部纵向滚动。
 *
 * @param {{count:number,width:number,height:number,maxCardW?:number}} opts
 * @returns {{cols:number,rows:number,cardW:number,gap:number,overflow:boolean}}
 */
export function computeBattleGrid({ count, width, height, maxCardW = 168 }) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const W = Math.max(1, Number(width) || 1);
  const H = Math.max(1, Number(height) || 1);
  const extra = 18; // 卡面外侧状态图标预留
  const GAPS = [20, 16, 12, 8];

  const fitAt = (gap, count = n) => {
    let best = null;
    for (let cols = 1; cols <= count; cols += 1) {
      const rows = Math.ceil(count / cols);
      const cellW = (W - gap * (cols - 1)) / cols;
      const cardH = (H - gap * (rows - 1)) / rows;
      if (cellW <= 0 || cardH <= 0) continue;
      const w = Math.min(cellW - extra, cardH * 0.75, maxCardW);
      if (w < 1) continue;
      if (!best || w > best.w) best = { cols, rows, w, gap };
    }
    return best || { cols: 1, rows: count, w: 46, gap };
  };

  // 「6 个单位时」的卡牌尺寸作为下限（同一块战斗区、正常间距）
  const minW = Math.min(maxCardW, fitAt(GAPS[0], 6).w);

  // 优先保留正常间距；只有卡牌会小于 6 单位尺寸时才缩间距
  let chosen = null;
  for (const gap of GAPS) {
    const fit = fitAt(gap);
    if (fit.w >= minW - 0.01) {
      chosen = fit;
      break;
    }
  }

  if (chosen) {
    const cardW = Math.max(46, Math.floor(chosen.w));
    const contentH = chosen.rows * (cardW * 4 / 3) + chosen.gap * (chosen.rows - 1);
    return {
      cols: chosen.cols,
      rows: chosen.rows,
      cardW,
      gap: chosen.gap,
      overflow: contentH > H + 1,
    };
  }

  // 最小间距也放不下：保持 6 单位尺寸，按宽度尽量多塞列，剩余交给滚动
  const gap = GAPS[GAPS.length - 1];
  const minCardW = Math.max(46, Math.floor(minW));
  const cols = Math.max(1, Math.min(n, Math.floor((W + gap) / (minCardW + gap))));
  const rows = Math.ceil(n / cols);
  const cardW = Math.max(1, Math.min(minCardW, Math.floor(W - extra)));
  const contentH = rows * (cardW * 4 / 3) + gap * (rows - 1);
  return { cols, rows, cardW, gap, overflow: contentH > H + 1 };
}
