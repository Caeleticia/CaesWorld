/**
 * data-events.js —— 本地数据被清除后的跨页面通知
 *
 * 设置页只能删掉 localStorage / IndexedDB 里的持久化数据；
 * 已经载入过的编辑器 / 训练场 / 同屏仍然持有内存副本。
 * 如果不同时丢弃这些内存副本，页面会在自动保存、切页或
 * beforeunload 时把旧数据原样写回去 —— 表现就是
 * 「缓存已经清了，却还是加载旧版卡组」。
 *
 * 这里用一条 window 事件把「哪一类数据被清掉了」广播给已经载入的页面。
 * 没有载入的页面不会监听，下次打开自然会读到清除后的存储。
 */

export const DATA_CLEARED_EVENT = "caeworld:data-cleared";

/** @param {"images"|"decks"|"packs"|"localmods"|"editor"|"all"|string} kind */
export function notifyDataCleared(kind) {
  try {
    window.dispatchEvent(
      new CustomEvent(DATA_CLEARED_EVENT, { detail: { kind: String(kind || "") } })
    );
  } catch {
    /* 极旧浏览器没有 CustomEvent 时忽略：下次重新打开页面仍会读到清除后的数据 */
  }
}

/**
 * 监听清除事件。
 * @param {(kind: string) => void} handler
 * @returns {() => void} 取消监听
 */
export function onDataCleared(handler) {
  if (typeof window === "undefined" || typeof handler !== "function") return () => {};
  const listener = (event) =>
    handler(String((event && event.detail && event.detail.kind) || ""));
  window.addEventListener(DATA_CLEARED_EVENT, listener);
  return () => window.removeEventListener(DATA_CLEARED_EVENT, listener);
}
