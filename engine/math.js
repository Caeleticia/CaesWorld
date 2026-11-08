/**
 * math.js —— 四系（按属性分别存储）数值表与基于种子的随机数
 *
 * 四系表一律是普通对象 { physical, magic, spirit, origin }，方便 JSON 落盘。
 */
import { ATTRIBUTES } from "./constants.js";

/** 生成一个四系全为 v 的表（v 可以是数字） */
export function attrZero(v = 0) {
  const out = {};
  for (const a of ATTRIBUTES) out[a] = v;
  return out;
}

/** { physical: 0.1 } → { physical: 0.1, magic: 0, spirit: 0, origin: 0 } */
export function attrFill(source) {
  const out = attrZero(0);
  if (source && typeof source === "object") {
    for (const a of ATTRIBUTES) {
      const v = Number(source[a]);
      out[a] = Number.isFinite(v) ? v : 0;
    }
  }
  return out;
}

export function attrAdd(a, b) {
  const out = attrZero(0);
  for (const k of ATTRIBUTES) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

export function attrSub(a, b) {
  const out = attrZero(0);
  for (const k of ATTRIBUTES) out[k] = (a[k] || 0) - (b[k] || 0);
  return out;
}

export function attrScale(a, s) {
  const out = attrZero(0);
  for (const k of ATTRIBUTES) out[k] = (a[k] || 0) * s;
  return out;
}

export function attrEq(a, b) {
  return ATTRIBUTES.every((k) => approx(a[k] || 0, b[k] || 0));
}

/** 浮点近似比较（四系数值经过多级乘加后会有误差） */
export function approx(a, b, eps = 1e-12) {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * 可复现的伪随机（mulberry32）。
 * 战斗里所有概率判定都从它取数，同一个种子 + 同一串行动 → 同一场战斗。
 */
export function createRng(seed = 1) {
  let a = (Number(seed) >>> 0) || 1;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = (Number(seed) >>> 0) || 1;
  return rng;
}

/** 按概率判定：rate <= 0 永不触发，rate >= 1 必定触发 */
export function rollChance(rng, rate) {
  const r = Number(rate) || 0;
  if (r <= 0) return false;
  if (r >= 1) return true;
  return rng() < r;
}
