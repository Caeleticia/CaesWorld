/**
 * icons.js —— 手绘风线性图标（24×24，currentColor 描边）
 * 纯字符串，便于菜单数据直接引用；颜色由外层 CSS 决定。
 */
const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  /* 游玩：手柄 */
  play: svg(
    '<path d="M8.6 8.2h6.8c2.6 0 3.9 1.9 4.4 4.4l.7 4.1c.2 1.3-.9 2.4-2.2 2.2-1.1-.2-2-.9-2.8-1.8l-.7-.8H9.2l-.7.8c-.8.9-1.7 1.6-2.8 1.8-1.3.2-2.4-.9-2.2-2.2l.7-4.1C4.7 10.1 6 8.2 8.6 8.2Z"/>' +
    '<path d="M8 11.4v3.2M6.4 13h3.2"/><circle cx="15.6" cy="12.2" r=".5" fill="currentColor"/>' +
    '<circle cx="17.6" cy="14" r=".5" fill="currentColor"/>'
  ),
  /* 测试：靶心 */
  test: svg(
    '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.6"/>' +
    '<circle cx="12" cy="12" r="1" fill="currentColor"/>' +
    '<path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6"/>'
  ),
  /* 设计：铅笔 */
  design: svg(
    '<path d="M4 20l1-4.4 10.6-10.6a2.2 2.2 0 0 1 3.1 0l.3.3a2.2 2.2 0 0 1 0 3.1L8.4 19 4 20Z"/>' +
    '<path d="M13.8 6.8l3.4 3.4M5 15.6l3.4 3.4"/>'
  ),
  /* 模组：拼图块 */
  mod: svg(
    '<path d="M10 4.2a2 2 0 0 1 3.4 0c.4.6.1 1.3.1 1.9h2.6c.7 0 1.2.5 1.2 1.2v2.5c.6 0 1.3-.3 1.9.1a2 2 0 0 1 0 3.4c-.6.4-1.3.1-1.9.1v2.9c0 .7-.5 1.2-1.2 1.2h-2.9c0-.6.3-1.3-.1-1.9a2 2 0 0 0-3.4 0c-.4.6-.1 1.3-.1 1.9H6.7c-.7 0-1.2-.5-1.2-1.2v-2.9c-.6 0-1.3.3-1.9-.1a2 2 0 0 1 0-3.4c.6-.4 1.3-.1 1.9-.1V7.3c0-.7.5-1.2 1.2-1.2h2.6c0-.6-.3-1.3.1-1.9Z"/>'
  ),
  /* 设置：齿轮 */
  setting: svg(
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M12 2.8v2.4M12 18.8v2.4M4.5 4.5l1.7 1.7M17.8 17.8l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.5 19.5l1.7-1.7M17.8 6.2l1.7-1.7"/>'
  ),
  /* 兜底 */
  dot: svg('<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>'),
};

export function icon(name) {
  return ICONS[name] || ICONS.dot;
}
