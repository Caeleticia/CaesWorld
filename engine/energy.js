/**
 * energy.js —— 能量环的纯计算
 *
 * 当前能量 / 上限 / 每环比例 → 每一环的进度。
 * 不碰 DOM，战斗 UI 与测试共用。
 */

/** 每环最多画几圈（防止把比例设得过小导致 DOM 爆炸） */
export const MAX_ENERGY_RINGS = 12;

/**
 * @param {number} energy 当前能量
 * @param {number} max 能量上限
 * @param {number} perRing 每环占上限的比例（0.1 ~ 1）
 * @returns {{energy:number,max:number,ringSize:number,rings:number[]}}
 */
export function energyRingData(energy, max, perRing = 1) {
  const cap = Math.max(0, Math.floor(Number(max) || 0));
  if (!cap) return { energy: 0, max: 0, ringSize: 0, rings: [] };
  const cur = Math.max(0, Math.min(cap, Number(energy) || 0));
  const ratio = Math.max(0.1, Math.min(1, Number(perRing) || 1));
  const ringSize = Math.max(1, cap * ratio);
  const count = Math.max(1, Math.min(MAX_ENERGY_RINGS, Math.ceil(cur / ringSize) || 1));
  const rings = [];
  for (let i = 0; i < count; i += 1) {
    rings.push(Math.max(0, Math.min(1, (cur - i * ringSize) / ringSize)));
  }
  return { energy: cur, max: cap, ringSize, rings };
}
