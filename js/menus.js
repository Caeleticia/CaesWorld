/**
 * menus.js —— 主菜单结构（纯数据 + 纯函数）
 *
 * 只描述「有哪些标签、每个标签弹出哪些选项」，不含任何玩法逻辑。
 * 标签颜色用于区分弹出项，但整体仍以主题色 #E5FFFF 为底。
 */

export const MENUS = [
  {
    id: "play",
    label: "游玩",
    icon: "play",
    color: "#3aa5f0",
    items: [
      { id: "local", label: "同屏" },
      { id: "rogue", label: "肉鸽" },
      { id: "endless", label: "无尽" },
      { id: "challenge", label: "挑战" },
    ],
  },
  {
    id: "test",
    label: "测试",
    icon: "test",
    color: "#59c98a",
    items: [{ id: "training", label: "训练场" }],
  },
  {
    id: "design",
    label: "设计",
    icon: "design",
    color: "#a58bff",
    items: [{ id: "editor", label: "编辑器" }],
  },
  {
    id: "mod",
    label: "模组",
    icon: "mod",
    color: "#ffb020",
    items: [{ id: "mod-manager", label: "模组管理" }],
  },
  {
    id: "settings",
    label: "设置",
    icon: "setting",
    color: "#ff6b8b",
    items: [{ id: "settings", label: "设置" }],
  },
];

/** 按 id 找标签 */
export function findTab(id, menus = MENUS) {
  return menus.find((tab) => tab.id === id) || null;
}

/**
 * 按 id 找选项：{ tab, item } 或 null
 */
export function findItem(itemId, menus = MENUS) {
  for (const tab of menus) {
    const item = tab.items.find((it) => it.id === itemId);
    if (item) return { tab, item };
  }
  return null;
}

/**
 * 手风琴逻辑：点击某标签时该标签打开、其它标签收起；
 * 再点一次已打开的标签则收起（返回 null）。
 * @param {string|null} openId 当前打开
 * @param {string} clicked 被点击
 * @returns {string|null}
 */
export function toggleTab(openId, clicked) {
  return openId === clicked ? null : clicked;
}
