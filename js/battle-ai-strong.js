/**
 * battle-ai-strong.js —— 新版人机：按角色机制出牌，而不是只比「这一下打多少」。
 *
 * 它模仿的是会玩的人在这套规则下的行为：
 *   · 先看阵容价值：风堇 / 遐蝶 / 历史学者 / 削肾客是核心，史莱姆是饲料；
 *   · 历史学者认准一个目标堆史论，不来回换人；优先高价值、没有月茧的目标；
 *   · 控制交给最危险且还没被控的敌人，而不是随手控坦克；
 *   · 风堇会留 dawn 解史论 / 控制，不把负面当空气；
 *   · 不共戴天只单挂，身边有队友时绝不出手；
 *   · 场上已经有敌方历史学者时，不把高价值单位白白送过去；
 *   · 选人优先让「能立刻改变局面」的单位行动（死龙、历史学者、风堇、遐蝶）。
 *
 * 这个模块不 import battle-ai.js，避免和旧 AI 形成循环依赖；
 * 遇到不认识的卡 / 技能时由调用方传入的 fallback（旧 AI）兜底。
 */
import { canSelectUnit } from "../engine/index.js";

/** 单位价值：用于转化 / 控制 / 集火的目标选择。未列出的卡按 30。 */
export const UNIT_VALUE = {
  starrail_unit_hyacine: 100,
  starrail_unit_castorice: 95,
  study2_unit_ct: 90,
  study_unit_squidward: 80,
  study_unit_littleempire: 70,
  study_unit_empire: 65,
  study_unit_choco: 60,
  study_unit_yifei: 55,
  study_unit_superzihan: 55,
  study2_unit_wjc: 50,
  study_unit_egg: 45,
  study_unit_mad: 40,
  study_unit_zihan: 35,
  default_unit_bigslime: 20,
  default_unit_slime: 10,
};

const valueOf = (cardId) => UNIT_VALUE[cardId] ?? 30;

/** 选人优先级：死龙 > 历史学者（能出手时） > 风堇 > 遐蝶 > 其他核心 */
const UNIT_PRIORITY = {
  starrail_unit_pollux: 1000,
  starrail_unit_castorice: 950,
  starrail_unit_hyacine: 800,
  study2_unit_ct: 700,
  study2_unit_wjc: 650,
};

const idx = (battle, A, skillId) => battle.allSkillsOf(A).findIndex((s) => s.id === skillId);
const can = (battle, A, i) => i >= 0 && battle.skillStateOf(A, battle.allSkillsOf(A)[i]).available;
const stacks = (battle, u, eid) => (u ? battle.effectStacks(u, eid) : 0);
const childOf = (battle, A, unitId) =>
  battle.state.units.some((u) => u.state === "alive" && u.parentKey === A.key && u.cardId === unitId);

const aliveUnits = (battle) => battle.state.units.filter((u) => u.state === "alive" && battle.isAlive(u));
const enemiesOf = (battle, A) =>
  aliveUnits(battle).filter((u) => u.side !== A.side && canSelectUnit(u, A.side));
const alliesOf = (battle, A) => aliveUnits(battle).filter((u) => u.side === A.side);

// 注意：这里必须用「当前生命」u.hp，不是 statsOf(u).hp（后者是生命上限）。
// 用上限排序会让巧克力永远打同一只已经被削过的木桩，伤害直接少一大截。
const byHp = (battle, list, dir = 1) =>
  [...list].sort((a, b) => ((Number(a.hp) || 0) - (Number(b.hp) || 0)) * dir || a.uid.localeCompare(b.uid));
const effectiveHp = (battle, u) => {
  const s = battle.statsOf(u);
  return (Number(u.hp) || 0) * ((950 + (Number(s.def) || 0)) / 950);
};
const lowestEffective = (battle, list) => [...list].sort((a, b) => effectiveHp(battle, a) - effectiveHp(battle, b))[0] || null;
const highestHp = (battle, list) => byHp(battle, list, -1)[0] || null;
const tgt = (u) => (u ? u.uid : null);

/** 威胁：价值 + 关键机制加成 + 攻击力。控制 / 集火都按这个排序。 */
export function threatOf(battle, u) {
  if (!u) return 0;
  let v = valueOf(u.cardId);
  if (u.cardId === "study2_unit_ct") v += 60; // 敌方历史学者是转化发动机，必须先处理
  if (u.cardId === "starrail_unit_hyacine") v += 40; // 净化 + 奶，拖下去很难杀
  if (u.cardId === "starrail_unit_castorice") v += 25; // 月茧 / 新蕊
  if (u.cardId === "study2_unit_wjc") v += 15; // 削肾 + 瓶盖
  const atk = Number(battle.statsOf(u)?.atk) || 0;
  v += Math.min(20, atk / 250);
  return v;
}

const highestThreat = (battle, list) =>
  [...list].sort((a, b) => threatOf(battle, b) - threatOf(battle, a) || b.uid.localeCompare(a.uid))[0] || null;

/** 真正需要被控制 / 集火的输出核心；控制辅助位是浪费。 */
const CARRY_IDS = new Set([
  "study_unit_empire",
  "study_unit_yifei",
  "study_unit_squidward",
  "study_unit_choco",
  "study_unit_superzihan",
  "study_unit_zihan",
  "study_unit_bgdt",
  "starrail_unit_castorice",
  "starrail_unit_hyacine",
  "starrail_unit_pollux",
  "study2_unit_ct",
]);
const isCarry = (u) => Boolean(u && CARRY_IDS.has(u.cardId));

/** 负面层数：给风堇判断「值不值得交 dawn」。 */
function negativeLayers(battle, u, registry) {
  let n = 0;
  for (const layer of u.effects || []) {
    const def = registry?.getEffect?.(layer.id);
    if (def && def.polarity === "negative") n += Number(layer.stacks) || 1;
  }
  return n;
}
function hasControl(battle, u, registry) {
  for (const layer of u.effects || []) {
    const def = registry?.getEffect?.(layer.id);
    if (!def) continue;
    if (Array.isArray(def.flags) && def.flags.includes("control")) return true;
    const nodes = Object.values(def.flows || {}).flatMap((f) => f?.nodes || []);
    if (nodes.some((n) => n.type === "skipTurn")) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 目标选择                                                            */
/* ------------------------------------------------------------------ */

/**
 * 史论目标：先兑现已经投入 4 层以上的目标（承诺），否则选价值最高的。
 * 排除：已 10 层（马上转化）、免疫负面、带月茧（转化会被月茧吃掉的概率高）。
 */
function conversionTarget(battle, A) {
  const es = enemiesOf(battle, A).filter((u) => stacks(battle, u, "study2_effect_sl") < 10);
  if (!es.length) return null;
  const clean = es.filter((u) => !u.immuneNegative && stacks(battle, u, "starrail_effect_cas.md") === 0);
  const pool = clean.length ? clean : es.filter((u) => !u.immuneNegative);
  if (!pool.length) return null;
  const committed = pool
    .filter((u) => stacks(battle, u, "study2_effect_sl") >= 4)
    .sort(
      (a, b) =>
        stacks(battle, b, "study2_effect_sl") - stacks(battle, a, "study2_effect_sl") ||
        valueOf(b.cardId) - valueOf(a.cardId)
    )[0];
  if (committed) return committed;
  return [...pool].sort(
    (a, b) => valueOf(b.cardId) - valueOf(a.cardId) || effectiveHp(battle, b) - effectiveHp(battle, a)
  )[0];
}

/** 单体输出目标：能斩杀优先，其次威胁高、当前血量低。 */
function damageTarget(battle, list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => effectiveHp(battle, a) - effectiveHp(battle, b));
  const low = sorted[0];
  const threat = highestThreat(battle, list);
  // 能补刀就补刀：分散伤害会让对面多活一轮，等于白送一次行动。
  // 只有低血目标并不比最危险目标明显更脆时，才改打威胁最高的。
  if (low && threat && effectiveHp(battle, low) <= effectiveHp(battle, threat) * 0.95) return low;
  return threat || low;
}

/** 敌方历史学者开始堆层（≥2）就优先处理，别等 10 层转化已经发生。 */
function converterInDanger(battle, list) {
  return (
    list.find(
      (u) => u.cardId === "study2_unit_ct" && stacks(battle, u, "study2_effect_sl") >= 2
    ) || null
  );
}

/** 单体输出目标：有快转化的历史学者先处理，其次补刀 / 打威胁。 */
function strikeTarget(battle, list) {
  return converterInDanger(battle, list) || damageTarget(battle, list);
}

/** 控制目标：最危险且还没被同类控制命中的；不把控制丢给已经动不了的敌人。 */
function controlTarget(battle, list, markId, registry = null) {
  if (!list.length) return null;
  // 已经被任意控制（瓶盖 / cf / 其它 skipTurn 效果）的目标不再重复控；
  // 否则鸡蛋会把 cf 丢给刚被瓶盖盖住的敌人，等于白交一次行动。
  const free = list.filter(
    (u) =>
      !u.immuneControl &&
      !hasControl(battle, u, registry) &&
      (!markId || stacks(battle, u, markId) === 0)
  );
  return free.length ? highestThreat(battle, free) : null;
}

/* ------------------------------------------------------------------ */
/* 角色规则                                                            */
/* ------------------------------------------------------------------ */

const RULES = {
  starrail_unit_castorice(battle, A) {
    // new 就绪先召死龙；然后 e 群攻 + 新蕊。全队血线危险时改用 a（a 自带 10% 生命上限回复）。
    const iNew = idx(battle, A, "starrail_skill_new");
    if (can(battle, A, iNew)) return { index: iNew, targetUid: null };
    const allies = alliesOf(battle, A);
    const danger = allies.some((u) => {
      const max = battle.statsOf(u).hp;
      return max > 0 && u.hp / max < 0.35;
    });
    const iE = idx(battle, A, "starrail_skill_cas.e");
    const healer = allies.some((u) => u.cardId === "starrail_unit_hyacine");
    if (!danger && healer && can(battle, A, iE)) return { index: iE, targetUid: null };
    const iA = idx(battle, A, "starrail_skill_cas.a");
    if (can(battle, A, iA)) {
      const t = strikeTarget(battle, enemiesOf(battle, A));
      return { index: iA, targetUid: tgt(t) };
    }
    if (can(battle, A, iE)) return { index: iE, targetUid: null };
    return null;
  },

  starrail_unit_hyacine(battle, A) {
    // 先看有没有必须净化的史论 / 控制；再保证小伊卡和雨过天晴不断。
    const iR = idx(battle, A, "starrail_skill_hyacine.rainbow");
    const iD = idx(battle, A, "starrail_skill_hyacine.dawn");
    const iB = idx(battle, A, "starrail_skill_hyacine.breeze");
    const allies = alliesOf(battle, A);
    const needCleanse = allies.some(
      (u) => stacks(battle, u, "study2_effect_sl") >= 4 || negativeLayers(battle, u, this.registry) >= 2 || hasControl(battle, u, this.registry)
    );
    if (needCleanse && can(battle, A, iD)) return { index: iD, targetUid: null };
    const child = childOf(battle, A, "starrail_unit_fatfuck");
    const aura = stacks(battle, A, "starrail_effect_hyacine.ygtq");
    if (!child && can(battle, A, iR)) return { index: iR, targetUid: null };
    if (aura === 0 && can(battle, A, iD)) return { index: iD, targetUid: null };
    const low = allies.some((u) => {
      const max = battle.statsOf(u).hp;
      return max > 0 && u.hp / max < 0.68;
    });
    if (low && can(battle, A, iR)) return { index: iR, targetUid: null };
    if (can(battle, A, iB)) {
      const t = strikeTarget(battle, enemiesOf(battle, A));
      return { index: iB, targetUid: tgt(t) };
    }
    if (can(battle, A, iD)) return { index: iD, targetUid: null };
    return null;
  },

  starrail_unit_pollux(battle, A) {
    // 死龙就是用来烧的：xy 每回合都放；血量不够会自爆，但退场被动是群体伤害 + 奶。
    const iX = idx(battle, A, "starrail_skill_pollux.xy");
    return can(battle, A, iX) ? { index: iX, targetUid: null } : null;
  },

  study_unit_empire(battle, A) {
    // 龙威是本源伤害，优先补掉能杀的，其次打威胁最高的。
    const iL = idx(battle, A, "study_skill_lw");
    if (!can(battle, A, iL)) return null;
    const es = enemiesOf(battle, A);
    const kill = lowestEffective(battle, es);
    const threat = highestThreat(battle, es);
    const focus = converterInDanger(battle, es);
    const pick = focus || (kill && threat && effectiveHp(battle, kill) < effectiveHp(battle, threat) * 0.9 ? kill : threat);
    return { index: iL, targetUid: tgt(pick) };
  },

  study_unit_littleempire(battle, A) {
    // 数论会跟着目标行动跳伤：先铺给威胁最高、还没数论的敌人，其次补最危险的目标。
    const iP = idx(battle, A, "study_skill_pos2");
    if (!can(battle, A, iP)) return null;
    const es = enemiesOf(battle, A);
    const fresh = es.filter((u) => stacks(battle, u, "study_effect_sl") === 0);
    const t = highestThreat(battle, fresh.length ? fresh : es);
    return { index: iP, targetUid: tgt(t) };
  },

  study_unit_squidward(battle, A) {
    const iB = idx(battle, A, "study_skill_bad");
    const iM = idx(battle, A, "study_skill_mentaldamage");
    const es = enemiesOf(battle, A);
    if (es.length >= 2 && can(battle, A, iB)) return { index: iB, targetUid: null };
    if (can(battle, A, iM)) return { index: iM, targetUid: tgt(strikeTarget(battle, es)) };
    return null;
  },

  study_unit_yifei(battle, A) {
    const iT = idx(battle, A, "study_skill_traincrash");
    const iM = idx(battle, A, "study_skill_mentaldamage");
    const es = enemiesOf(battle, A);
    if (es.length >= 2 && can(battle, A, iT)) return { index: iT, targetUid: null };
    if (can(battle, A, iM)) return { index: iM, targetUid: tgt(strikeTarget(battle, es)) };
    return null;
  },

  study_unit_mad(battle, A) {
    const iM = idx(battle, A, "study_skill_mentaldamage");
    return can(battle, A, iM)
      ? { index: iM, targetUid: tgt(strikeTarget(battle, enemiesOf(battle, A))) }
      : null;
  },

  study_unit_egg(battle, A) {
    // cf 让敌人跳过下一次行动：交给威胁最高、还没被 cf 的；不要重复控同一个。
    const iC = idx(battle, A, "study_skill_cf");
    const iM = idx(battle, A, "study_skill_mentaldamage");
    const es = enemiesOf(battle, A);
    const carries = es.filter(isCarry);
    const t = controlTarget(battle, carries, "study_effect_cf", this.registry);
    // 只控对面的输出核心；控辅助位等于把鸡蛋的伤害让掉。
    // 没有可控核心时（或核心已经全被按住）转火打伤害。
    const controlled = es.filter((u) => hasControl(battle, u, this.registry)).length;
    const worth = t && controlled < 2;
    if (can(battle, A, iC) && worth) return { index: iC, targetUid: t.uid };
    if (can(battle, A, iM)) return { index: iM, targetUid: tgt(damageTarget(battle, es)) };
    return null;
  },

  study_unit_zihan(battle, A) {
    const iB = idx(battle, A, "study_skill_bite");
    return can(battle, A, iB)
      ? { index: iB, targetUid: tgt(damageTarget(battle, enemiesOf(battle, A))) }
      : null;
  },

  study_unit_superzihan(battle, A) {
    const iK = idx(battle, A, "study_skill_kamisamabite");
    return can(battle, A, iK)
      ? { index: iK, targetUid: tgt(highestHp(battle, enemiesOf(battle, A))) }
      : null;
  },

  study_unit_choco(battle, A) {
    // 30% 当前生命：打血最多的；打残血是浪费。
    const iC = idx(battle, A, "study_skill_choco");
    return can(battle, A, iC)
      ? { index: iC, targetUid: tgt(highestHp(battle, enemiesOf(battle, A))) }
      : null;
  },

  study_unit_bgdt(battle, A) {
    // 200% 精神 AoE 打「除自己外」所有人。有队友 = 自杀，必须单挂。
    const allies = alliesOf(battle, A).filter((u) => u.uid !== A.uid);
    if (allies.length) return null;
    const iB = idx(battle, A, "study_skill_bgdt");
    return can(battle, A, iB) ? { index: iB, targetUid: null } : null;
  },

  study2_unit_wjc(battle, A) {
    // 瓶盖交给最危险且没被瓶盖的；削肾铺弱点突破，让被动追击覆盖更多目标。
    const iP = idx(battle, A, "study2_skill_pgxf");
    const iX = idx(battle, A, "study2_skill_xs");
    const es = enemiesOf(battle, A);
    const controlled = es.filter((u) => hasControl(battle, u, this.registry)).length;
    const noPg = es.filter(
      (u) => isCarry(u) && stacks(battle, u, "study2_effect_pg") === 0 && !hasControl(battle, u, this.registry)
    );
    if (can(battle, A, iP) && noPg.length && controlled < 2) {
      const t = highestThreat(battle, noPg);
      if (t) return { index: iP, targetUid: t.uid };
    }
    if (!can(battle, A, iX)) return null;
    const unmarked = es.filter((u) => stacks(battle, u, "study2_effect_rdtp") === 0);
    const t = damageTarget(battle, unmarked.length ? unmarked : es);
    return { index: iX, targetUid: tgt(t) };
  },

  study2_unit_ct(battle, A) {
    // 史论：承诺一个目标堆到 10 层。目标按价值选，不按血量。
    const iS = idx(battle, A, "study2_skill_sl");
    if (!can(battle, A, iS)) return null;
    const t = conversionTarget(battle, A);
    return t ? { index: iS, targetUid: t.uid } : null;
  },

  default_unit_bigslime(battle, A) {
    const i = idx(battle, A, "default_skill_slimebeat");
    return can(battle, A, i)
      ? { index: i, targetUid: tgt(damageTarget(battle, enemiesOf(battle, A))) }
      : null;
  },

  default_unit_slime(battle, A) {
    const i = idx(battle, A, "default_skill_slimebeat");
    return can(battle, A, i)
      ? { index: i, targetUid: tgt(damageTarget(battle, enemiesOf(battle, A))) }
      : null;
  },
};

/* ------------------------------------------------------------------ */
/* 对外：出招 / 选人 / 上牌                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {object} battle
 * @param {object} active 内部单位
 * @param {object|null} registry 内容注册表（需要它判断效果倾向）
 * @param {Function|null} fallback 旧 AI 的 chooseAISkill，用于不认识的卡
 */
export function chooseStrongAISkill(battle, active, registry = null, fallback = null) {
  if (!battle || !active) return null;
  const rule = RULES[active.cardId];
  if (rule) {
    // registry 通过 this 传给规则，避免每条规则都多一个参数
    return rule.call({ registry }, battle, active);
  }
  return fallback ? fallback(battle, active, registry) : null;
}

/** 行动单位：优先让能立刻改变局面的单位动，而不是单纯攻击力最高。 */
export function chooseStrongAIUnit(battle, side, registry = null) {
  const pb = battle.publicBattle();
  const candidates = pb.units.filter(
    (u) => u.side === side && u.state === "alive" && (Number(u.actionsLeft) || 0) > 0
  );
  if (!candidates.length) return null;
  const scored = candidates.map((pub) => {
    const u = battle.getUnit(pub.uid);
    if (!u) return { u: pub, score: -Infinity, uid: pub.uid };
    let score = (UNIT_PRIORITY[u.cardId] ?? valueOf(u.cardId) * 8);
    if (u.cardId === "study2_unit_ct") {
      const t = conversionTarget(battle, u);
      if (t) score += 260;
    } else if (u.cardId === "starrail_unit_hyacine") {
      const allies = alliesOf(battle, u);
      if (allies.some((x) => negativeLayers(battle, x, registry) >= 2 || hasControl(battle, x, registry))) score += 220;
      if (!childOf(battle, u, "starrail_unit_fatfuck")) score += 60;
    } else if (u.cardId === "study_unit_egg") {
      if (controlTarget(battle, enemiesOf(battle, u), "study_effect_cf", registry)) score += 180;
    } else if (u.cardId === "study2_unit_wjc") {
      score += 120;
    } else if (u.cardId === "starrail_unit_castorice") {
      if (can(battle, u, idx(battle, u, "starrail_skill_new"))) score += 150;
      // 没有风堇时 e 会抽干全队；让群攻 / 真伤单位先动，遐蝶改用 a 补刀。
      if (!alliesOf(battle, u).some((x) => x.cardId === "starrail_unit_hyacine")) score -= 250;
    } else if (u.cardId === "study_unit_squidward") {
      if (enemiesOf(battle, u).length >= 2) score += 150;
    } else if (u.cardId === "study_unit_bgdt") {
      const allies = alliesOf(battle, u).filter((x) => x.uid !== u.uid);
      if (allies.length) score -= 500; // 有队友时它没有合法技能，别浪费行动顺位
    }
    return { u: pub, score, uid: pub.uid };
  });
  scored.sort((a, b) => b.score - a.score || a.uid.localeCompare(b.uid));
  return scored[0]?.u || null;
}

/** 上牌评分：按阵容价值 + 协同，而不是攻击力。 */
function deployScore(battle, card, field, enemyField) {
  const id = card.id;
  if (id === "starrail_unit_fatfuck") return -Infinity; // 小伊卡只通过召唤入场
  const value = valueOf(id);
  let score = value * 10;
  const fieldIds = new Set(field.map((u) => u.cardId));
  if (id === "study_unit_bgdt") {
    // 单挂输出：只在空场时上；有队友时由调用方跳过。
    if (field.length) return -Infinity;
    return 500 + Math.min(3, enemyField.length) * 90;
  }
  if (id === "starrail_unit_hyacine") score += 120;
  if (id === "starrail_unit_castorice") score += 100;
  if (id === "study2_unit_ct") score += 90;
  if (id === "study2_unit_wjc") score += 40;
  if (id === "study_unit_empire" || id === "study_unit_littleempire") score += 25;
  if (id === "study_unit_egg") score += 20;
  // 核心协同：蝶 + 堇、历史学者 + 能站住的队友
  if (fieldIds.has("starrail_unit_hyacine") && id === "starrail_unit_castorice") score += 30;
  if (fieldIds.has("starrail_unit_castorice") && id === "starrail_unit_hyacine") score += 30;
  if (fieldIds.has("study2_unit_ct") && (id === "study_unit_empire" || id === "study_unit_littleempire" || id === "default_unit_bigslime")) score += 20;
  // 空场时略微偏站得住的，避免一上来就被点掉
  if (!field.length) score += Math.min(25, (Number(card.baseHp) || 0) / 300);
  // 敌方历史学者已经在堆史论：别把高价值单位送过去
  const converter = enemyField.find((u) => u.cardId === "study2_unit_ct");
  if (converter && value >= 80) {
    const threat = stacks(battle, battle.getUnit(converter.uid), "study2_effect_sl");
    if (threat >= 5) score -= 70;
  }
  return score;
}

/**
 * 从手牌挑一张：保留旧 AI 的同名 / 单挂约束，但按阵容价值排序。
 * @returns {number} 手牌下标；-1 表示这一轮不适合再上牌
 */
export function chooseStrongDeployCard(battle, registry, side, fallback = null) {
  if (!battle || !registry) return -1;
  const pb = battle.publicBattle();
  if (pb.phase === "finished" || pb.status !== "running") return -1;
  if (pb.localDeploy && pb.localDeploy.side !== side) return -1;
  if (!battle.canDeploy(side)) return -1;
  const field = pb.units.filter((u) => u.side === side && u.state === "alive");
  const occupied = field.filter((u) => u.occupiesSlot).length;
  // 不共戴天在场时不再补队友；有队友时也不上它。
  if (field.some((u) => u.cardId === "study_unit_bgdt")) return -1;
  const hand = pb.hand?.[side] || [];
  if (!hand.length) return -1;
  const allowSameName = pb.allowSameName !== false;
  const fieldNames = new Set(field.map((u) => u.name));
  const enemyField = pb.units.filter((u) => u.side !== side && u.state === "alive");
  let best = { index: -1, score: -Infinity };
  for (let i = 0; i < hand.length; i += 1) {
    const card = registry.getUnit(hand[i]);
    if (!card) continue;
    // 占位已满时只有不占位的牌还能继续上
    if (card.occupiesSlot !== false && occupied >= pb.maxUnits) continue;
    const name = card.name || card.id;
    if (!allowSameName && fieldNames.has(name)) continue;
    if (card.id === "study_unit_bgdt" && field.length > 0) continue;
    let score = deployScore(battle, card, field, enemyField);
    if (!Number.isFinite(score)) continue;
    // 敌方历史学者 5 层以上、我方没有风堇可解时，高价值牌先扣在手里
    const converter = enemyField.find((u) => u.cardId === "study2_unit_ct");
    const noCleanse = !field.some((u) => u.cardId === "starrail_unit_hyacine");
    if (converter && noCleanse && valueOf(card.id) >= 80) {
      const converterUnit = battle.getUnit(converter.uid);
      if (stacks(battle, converterUnit, "study2_effect_sl") >= 5) score -= 60;
    }
    if (score > best.score) best = { index: i, score };
  }
  if (best.index < 0) {
    // 手里的牌全被同名 / 单挂约束挡掉：交给旧 AI 再试一次（保持兼容）。
    // 但小伊卡只能召唤入场，不能作为普通手牌打出去。
    const idx2 = fallback ? fallback(battle, registry, side) : -1;
    if (idx2 >= 0 && registry.getUnit(hand[idx2])?.id === "starrail_unit_fatfuck") return -1;
    return idx2;
  }
  return best.index;
}
