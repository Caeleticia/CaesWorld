/**
 * targeting.js —— 站位 / 占位 / 计数 / 索敌
 *
 * 每侧有 slots 个格子，每个格子最多站一个单位。
 *  - 开占位(occupiesSlot)的单位占用一个格子，不能和其他占位者重叠；
 *  - 不开占位的单位可以站在任意空格或不占位单位所在的格子里，不排队；
 *  - 计数(countsAsUnit)只影响「阵营单位数量上限」；不计数单位照样进入索敌 / 可选目标集；
 *  - 不可选中(unselectable)分四种：none / enemy（不可被敌方选中）/ ally（不可被我方选中）/ all（双方都不可选）。
 *
 * 索敌默认打「最近」的可选中单位：|slot| 最小者，同距离按加入顺序（slot 小的先）。
 * 不再按计数与否区分目标类别；不占位只影响站位，不影响选中。
 */
import { SIDES } from "./constants.js";
import { canSelectUnit } from "./units.js";

export function sideOf(side) {
  if (!SIDES.includes(side)) throw new Error(`无效阵营：${side}`);
  return side;
}

export function otherSide(side) {
  return side === "ally" ? "enemy" : "ally";
}

export const DEFAULT_SLOTS = 5;

/**
 * 归一化站位：负数 → 负数（左侧），0 视为非法，返回 null。
 * 约定：|slot| 从 1 开始，越靠近中线（数值小）越靠前。
 */
export function normalizeSlot(slot) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n === 0) return null;
  return n;
}

/** 距离：越靠前数值越小 */
export function slotDistance(slot) {
  return Math.abs(slot);
}

/** 按距离从近到远排序（不改变原数组） */
export function sortByDistance(units) {
  return units
    .slice()
    .sort((a, b) => slotDistance(a.slot) - slotDistance(b.slot) || a.slot - b.slot);
}

/**
 * 能否把单位放到某格。
 * @param {Array<object>} units 同侧全部单位（含自己）
 * @param {object} candidate 要放置的单位 { id, slot, occupiesSlot }
 * @returns {{ok: boolean, reason?: string}}
 */
export function canPlace(units, candidate) {
  const slot = normalizeSlot(candidate.slot);
  if (slot === null) return { ok: false, reason: "slot 必须是非零整数" };
  for (const u of units) {
    if (u.id === candidate.id) continue;
    if (u.slot !== slot) continue;
    if (u.occupiesSlot && candidate.occupiesSlot) {
      return { ok: false, reason: `格子 ${slot} 已被占位单位 ${u.id} 占用` };
    }
  }
  return { ok: true };
}

/**
 * 找出某阵营里可作为目标的单位。
 * @param {Array<object>} units 全部战斗单位
 * @param {string} side
 * @param {{counted?: boolean, fromSide?: string}} [opts]
 *   counted: true=只要计数单位，false=只要不计数，缺省不过滤
 *   fromSide: 选择者阵营，用于判断「不可被敌方 / 我方选中」
 */
export function candidatesForTargeting(units, side, opts = {}) {
  const { counted, fromSide } = opts;
  return units.filter((u) => {
    if (u.side !== side) return false;
    if (!canSelectUnit(u, fromSide)) return false;
    if (typeof counted === "boolean" && Boolean(u.countsAsUnit) !== counted) return false;
    return true;
  });
}

/**
 * 选目标：最近的、当前选择者能选中的单位。
 * @returns {object|null}
 */
export function selectTarget(units, side, opts = {}) {
  const pool = candidatesForTargeting(units, side, opts).filter((u) => u.slot !== undefined && u.slot !== null);
  if (pool.length === 0) return null;

  const sorted = opts.ignoreDistance ? pool.slice() : sortByDistance(pool);
  // 计数不再影响索敌优先级：不计数单位与计数单位同等参与距离排序
  return sorted[0] || null;
}
