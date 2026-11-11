/**
 * stats.js —— 实时面板：基础数值 + 效果加成 → 攻击力 / 防御力 / 生命值
 *
 *   攻击力 = 基础攻击力 * (1 + 攻击力加成%) + 攻击力加成数值
 *   防御力 = 基础防御力 * (1 + 防御力加成%) + 防御力加成数值
 *   生命值 = 基础生命值 * (1 + 生命值加成%) + 生命值加成数值
 *   暴击率 / 暴击伤害同理（基础值为卡面值）
 *
 * 攻击力降低百分比就是负的攻击力加成百分比，在这里统一生效；
 * 层叠乘子(atkMul/defMul/hpMul)乘在括号外，供 buff / 场景效果使用。
 * 本源伤害不使用这些面板数值（见 damage.js）。
 */
import { ATTRIBUTES, RESISTANCE_ATTRIBUTES } from "./constants.js";
import { emptyAccum } from "./modifiers.js";
import { attrZero } from "./math.js";

/**
 * @param {object} card 单位卡
 * @param {object} [acc] 累加器（modifiers.emptyAccum 的形状）
 */
export function computeStats(card, acc = emptyAccum()) {
  const base = emptyAccum();
  const a = Object.assign(base, acc || {});
  a.attrDmgBoostPct = { ...base.attrDmgBoostPct, ...((acc && acc.attrDmgBoostPct) || {}) };
  a.attrPenPct = attrZero(0);
  for (const k of ATTRIBUTES) a.attrPenPct[k] = (acc && acc.attrPenPct && Number(acc.attrPenPct[k])) || 0;

  const hpMul = a.hpMul || 1;
  const atkMul = a.atkMul || 1;
  const defMul = a.defMul || 1;

  const atk = (card.baseAtk * (1 + a.atkPct) + a.atkFlat) * atkMul;
  const def = (card.baseDef * (1 + a.defPct) + a.defFlat) * defMul;
  const hp = (card.baseHp * (1 + a.hpPct) + a.hpFlat) * hpMul;

  const resistances = {};
  for (const attr of RESISTANCE_ATTRIBUTES) {
    resistances[attr] = card.resistances?.[attr] ?? 0;
  }

  return {
    level: card.level,
    atk: Math.max(0, atk),
    def: Math.max(0, def),
    hp: Math.max(0, hp),
    critRate: card.critRate + a.critRate,
    critDamage: card.critDamage + a.critDamage,
    /** 速度：卡面速度 ×（1 + speedPct）+ speed 数值加成；只决定行动顺序 */
    speed: (card.speed || 0) * (1 + (a.speedPct || 0)) + a.speed,
    /** 伤害提升百分比（全局） */
    dmgBoostPct: a.dmgBoostPct,
    /** 四系伤害提升百分比 */
    attrDmgBoostPct: a.attrDmgBoostPct,
    /** 四系抗性穿透 */
    attrPenPct: a.attrPenPct,
    /** 抗性降低效果 */
    resistDownPct: a.resistDownPct,
    /** 受到伤害提升效果 */
    damageTakenPct: a.damageTakenPct,
    /** 易伤效果 */
    vulnPct: a.vulnPct,
    resistances,
  };
}
