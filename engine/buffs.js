/**
 * buffs.js —— 运行时的效果（buff / debuff）
 *
 * 描述（JSON 可存）：
 *   {
 *     id: "default_buff_guard",        // 可选；缺省自动生成 runtime:buff:N
 *     label: "守势",
 *     tags: ["guard"],                 // dispel 按标签移除
 *     duration: 2,                     // 持续「该单位结束回合」的次数；缺省 / null = 永续
 *     attr: "magic",                   // 可选：加成只作用于该属性
 *     def: {                           // 键见 modifiers.BONUS_KEYS（百分比用小数）
 *       atkPct: 0.2,
 *       attrDmgBoostPct: { magic: 0.3 },
 *       attrPenPct: { magic: 0.1 }
 *     }
 *   }
 *
 * 规则：
 *  - 没有 attr 的 buff：def 里缺失的属性键按 0 处理（不叠加四系）。
 *  - 有 attr 的 buff：单属性键只作用在该属性上；属性相关键可写成数字。
 */
import { ATTRIBUTES } from "./constants.js";
import { BONUS_KEYS } from "./modifiers.js";

let runtimeSeq = 0;

/** 每次新建战斗时重置运行时 id 计数，保证存档可复现 */
export function resetBuffSequence(start = 0) {
  runtimeSeq = start;
}

export function createBuff(input = {}) {
  const def = {};
  const src = input.def || {};
  for (const key of BONUS_KEYS) {
    if (src[key] === undefined) continue;
    if (src[key] && typeof src[key] === "object") {
      const table = {};
      let any = false;
      for (const a of ATTRIBUTES) {
        const v = Number(src[key][a]);
        if (Number.isFinite(v) && v !== 0) {
          table[a] = v;
          any = true;
        }
      }
      if (any) def[key] = table;
    } else {
      const v = Number(src[key]);
      if (Number.isFinite(v) && v !== 0) def[key] = v;
    }
  }

  const rawDuration = input.duration;
  const duration =
    rawDuration === undefined || rawDuration === null ? null : Math.max(0, Number(rawDuration)) || 0;

  runtimeSeq += 1;
  return {
    uid: typeof input.id === "string" && input.id ? input.id : `runtime:buff:${runtimeSeq}`,
    label: typeof input.label === "string" && input.label ? input.label : "效果",
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    duration,
    attr: ATTRIBUTES.includes(input.attr) ? input.attr : null,
    def,
    sourceId: typeof input.sourceId === "string" ? input.sourceId : null,
  };
}

export function hasTag(buff, tag) {
  return Array.isArray(buff.tags) && buff.tags.includes(tag);
}

export function buffExpired(buff) {
  return buff.duration !== null && buff.duration <= 0;
}

/** 属性相关键（可被 buff.attr 限定） */
const ATTR_KEYS = new Set(["attrDmgBoostPct", "attrPenPct"]);

/**
 * 把 buff 换算成一条加成项，交给 modifiers.addBonus 累加。
 * @returns {object}
 */
export function buffToBonus(buff) {
  const out = {};
  for (const key of BONUS_KEYS) {
    const v = buff.def[key];
    if (v === undefined) continue;
    const attrKey = ATTR_KEYS.has(key);

    if (v && typeof v === "object") {
      const table = {};
      for (const a of ATTRIBUTES) {
        if (buff.attr && a !== buff.attr) continue;
        const n = Number(v[a]) || 0;
        if (n) table[a] = n;
      }
      if (Object.keys(table).length) out[key] = table;
      continue;
    }

    const n = Number(v) || 0;
    if (!n) continue;
    if (attrKey) {
      // 属性相关键写成数字：有 attr 就只作用该属性；没有 attr 时视为全局（四系各 +n）
      const table = {};
      for (const a of buff.attr ? [buff.attr] : ATTRIBUTES) table[a] = n;
      out[key] = table;
    } else {
      out[key] = n;
    }
  }
  return out;
}
