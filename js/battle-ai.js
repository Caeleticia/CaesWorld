/**
 * battle-ai.js —— 人机出牌评估
 *
 * 对每个主动技能做一次轻量推演：
 *   · 解析技能流程里的「攻击」积木与目标集；
 *   · 用引擎伤害公式估算每个目标实际吃到的伤害（超过目标当前生命的溢出不计）；
 *   · 总伤 = 对敌方的不溢出伤害 − 对友方造成的伤害；
 *   · 没有伤害时，优先选择能施加效果 / 召唤 / 回复的技能；
 *   · 单体技能会逐个敌人试算，选出实际收益最高的目标。
 *
 * 只做估算，不真的执行技能，不改战斗状态。
 */
import { calculateDamage, normalizeEffects, skillNeedsPlayerTarget } from "../engine/index.js";

const EXEC_PORTS = new Set(["next", "body", "end", "true", "false"]);
const EFFECT_NODES = new Set([
  "attachEffect",
  "removeEffect",
  "summon",
  "summonChild",
  "giveSkill",
  "heal",
  "setHp",
  "skipTurn",
  "forceExit",
  "immuneDamage",
]);

/**
 * @param {object} battle createBattle 返回的战斗对象
 * @param {object} active 当前行动单位（内部单位对象）
 * @returns {{index:number, targetUid:string|null, damage:number, effectScore:number}|null}
 */
export function chooseAISkill(battle, active, registry = null) {
  if (!battle || !active) return null;
  const pb = battle.publicBattle();
  const units = pb.units.filter((u) => u.state === "alive");
  const enemies = units.filter((u) => u.side !== active.side);
  if (!enemies.length) return null;
  const skills = battle
    .allSkillsOf(active)
    .map((skill, index) => ({ skill, index }))
    .filter((x) => x.skill.type === "active");
  if (!skills.length) return null;

  let bestControl = null;
  let bestDamage = null;
  let bestEffect = null;
  let fallback = null;

  for (const { skill, index } of skills) {
    const profile = profileSkill(battle, active, skill, units, enemies, registry);
    const candidate = { index, ...profile };
    if (!fallback) fallback = candidate;
    if (profile.controlValue > 0) {
      if (
        !bestControl ||
        profile.controlValue > bestControl.controlValue + 1e-9 ||
        (Math.abs(profile.controlValue - bestControl.controlValue) <= 1e-9 && profile.damage > bestControl.damage)
      ) {
        bestControl = candidate;
      }
    } else if (profile.damage > 0) {
      if (
        !bestDamage ||
        profile.damage > bestDamage.damage + 1e-9 ||
        (Math.abs(profile.damage - bestDamage.damage) <= 1e-9 && profile.targetHp < bestDamage.targetHp)
      ) {
        bestDamage = candidate;
      }
    } else if (profile.effectScore > 0) {
      if (
        !bestEffect ||
        profile.effectScore > bestEffect.effectScore ||
        (profile.effectScore === bestEffect.effectScore && profile.targetHp < bestEffect.targetHp)
      ) {
        bestEffect = candidate;
      }
    }
  }

  return bestControl || bestDamage || bestEffect || fallback;
}

const QUALITY_SCORE = { white: 0, blue: 50, gold: 140, rainbow: 240 };
const FLOW_ACTION_NODES = new Set([
  "attack",
  "heal",
  "setHp",
  "attachEffect",
  "removeEffect",
  "summon",
  "summonChild",
  "getSkill",
  "giveSkill",
]);

/**
 * 从手牌里挑一张当前上场最有利的牌。
 * 评分综合考虑攻击 / 生命 / 防御 / 品质 / 技能数量与技能类型；
 * 场上为空时更偏向能站住的血量。
 * @returns {number} 手牌下标；没有可上场牌时返回 -1
 */
export function chooseBestDeployCard(battle, registry, side) {
  if (!battle || !registry) return -1;
  const pb = battle.publicBattle();
  if (pb.phase === "finished" || pb.status !== "running") return -1;
  if (pb.localDeploy && pb.localDeploy.side !== side) return -1;
  if (!battle.canDeploy(side)) return -1;
  const field = pb.units.filter((u) => u.side === side && u.state === "alive");
  if (field.filter((u) => u.countsAsUnit).length >= pb.maxUnits) return -1;
  const hand = pb.hand?.[side] || [];
  if (!hand.length) return -1;
  const allowSameName = pb.local?.allowSameName !== false;
  const fieldNames = new Set(field.map((u) => u.name));
  let best = { index: -1, score: -Infinity };
  for (let i = 0; i < hand.length; i += 1) {
    const card = registry.getUnit(hand[i]);
    if (!card) continue;
    const name = card.name || card.id;
    if (!allowSameName && fieldNames.has(name)) continue;
    const score = deployScore(card, registry, field);
    if (score > best.score) best = { index: i, score };
  }
  return best.index;
}

function deployScore(card, registry, field) {
  const atk = Number(card.baseAtk) || 0;
  const hp = Number(card.baseHp) || 0;
  const def = Number(card.baseDef) || 0;
  const speed = Number(card.speed) || 0;
  let score = atk * 1.6 + hp * 0.22 + def * 0.3 + speed * 0.1 + (QUALITY_SCORE[card.quality] || 0);
  const skills = (card.skills || []).map((sid) => registry.getSkill(sid)).filter(Boolean);
  for (const skill of skills) {
    if (skill.type === "active") score += 120;
    const nodes = skill.flow?.nodes || [];
    if (nodes.some((n) => n.type === "attack")) score += 100;
    if (nodes.some((n) => FLOW_ACTION_NODES.has(n.type) && n.type !== "attack")) score += 60;
    if (Array.isArray(skill.effects)) {
      for (const eff of skill.effects) {
        if (eff.kind === "damage") score += 80;
        else score += 60;
      }
    }
  }
  if (!field.length) score += hp * 0.18 + def * 0.2;
  return score;
}

/* ------------------------------------------------------------------ */
/* 技能档案                                                            */
/* ------------------------------------------------------------------ */
function emptyProfile(needsTarget, multi) {
  return {
    needsTarget,
    multi,
    targetUid: null,
    targetHp: Infinity,
    damage: 0,
    controlValue: 0,
    effectScore: 0,
  };
}

function profileSkill(battle, active, skill, units, enemies, registry) {
  if (skill.format === "flow" && skill.flow && Array.isArray(skill.flow.nodes)) {
    return profileFlowSkill(battle, active, skill, units, registry);
  }
  return profileDataSkill(battle, active, skill, units, enemies);
}

function profileFlowSkill(battle, active, skill, units, registry) {
  const graph = buildGraph(skill.flow);
  const chooseNodes = [...graph.nodes.values()].filter((n) => n.type === "chooseUnit");
  const needsTarget = skillNeedsPlayerTarget(skill) || chooseNodes.length > 0;
  const multi = chooseNodes.some((n) => n.options && n.options.multiple !== false);
  const result = emptyProfile(needsTarget, multi);
  let bestControl = null;
  let bestDamage = null;
  let bestEffect = null;
  const candidates = needsTarget && !multi ? units : [null];

  for (const candidate of candidates) {
    const scan = scanFlow(battle, active, graph, candidate, units);
    const damage = totalDamage(battle, graph, active, scan.attacks, candidate, units);
    const metrics = effectMetrics(battle, graph, active, scan.effects, candidate, units, registry);
    const targetHp = candidate ? candidate.hp : 0;
    const priority = candidate ? unitThreat(battle, candidate) : 0;

    if (
      !bestControl ||
      metrics.control > bestControl.control + 1e-9 ||
      (Math.abs(metrics.control - bestControl.control) <= 1e-9 && priority > bestControl.priority)
    ) {
      bestControl = { control: metrics.control, effect: metrics.effect, priority, candidate };
    }
    if (
      !bestDamage ||
      damage > bestDamage.damage + 1e-9 ||
      (Math.abs(damage - bestDamage.damage) <= 1e-9 && targetHp < bestDamage.targetHp)
    ) {
      bestDamage = { damage, targetHp, candidate };
    }
    if (
      !bestEffect ||
      metrics.effect > bestEffect.effect + 1e-9 ||
      (Math.abs(metrics.effect - bestEffect.effect) <= 1e-9 && targetHp < bestEffect.targetHp)
    ) {
      bestEffect = { effect: metrics.effect, targetHp, candidate };
    }
  }

  if (bestControl && bestControl.control > 0) {
    result.controlValue = bestControl.control;
    result.effectScore = bestControl.effect;
    result.damage = bestDamage ? bestDamage.damage : 0;
    result.targetHp = bestControl.candidate ? bestControl.candidate.hp : 0;
    result.targetUid = result.multi ? null : bestControl.candidate ? bestControl.candidate.uid : null;
  } else if (bestDamage && bestDamage.damage > 0) {
    result.damage = bestDamage.damage;
    result.targetHp = bestDamage.targetHp;
    result.targetUid = result.multi ? null : bestDamage.candidate ? bestDamage.candidate.uid : null;
  } else if (bestEffect && bestEffect.effect > 0) {
    result.effectScore = bestEffect.effect;
    result.targetHp = bestEffect.targetHp;
    result.targetUid = result.multi ? null : bestEffect.candidate ? bestEffect.candidate.uid : null;
  }
  return result;
}

/** 特殊效果评分：行动开始时跳过行动 / 造成伤害的负面效果优先级最高。 */
function effectCardValue(def) {
  if (!def) return { control: 0, effect: 0.5 };
  let control = 0;
  let effect = 1;
  if (def.polarity === "negative") {
    // 负面效果本身就是「特殊效果」：即使不是行动触发，也优先于纯伤害
    control += 2;
    effect += 1;
  }
  if (def.autoConsume) effect += 0.2;
  for (const trigger of def.triggers || []) {
    if (!trigger || !trigger.event) continue;
    if (trigger.event === "unitTurnStart") {
      const flow = def.flows?.[trigger.id];
      const nodes = flow?.nodes || [];
      if (nodes.some((n) => n.type === "skipTurn")) control += 10;
      else if (nodes.some((n) => n.type === "attack")) control += 5;
      else control += 3;
      effect += 2;
    } else {
      effect += 1;
    }
  }
  return { control, effect };
}

function effectMetrics(battle, graph, active, effects, candidate, units, registry) {
  let control = 0;
  let effect = 0;
  let priority = 0;
  for (const { node, mult } of effects) {
    const targetSource = graph.inSource.get(`${node.id}.targets`);
    const targets = targetSource ? resolveTargets(graph, active, targetSource, candidate, units) : [];
    if (targetSource && !targets.length) continue;
    if (node.type === "attachEffect") {
      const effectSource = graph.inSource.get(`${node.id}.effectId`);
      const effectId = effectSource ? evalString(graph, active, effectSource, candidate) : node.options?.effectId || "";
      const valueSource = graph.inSource.get(`${node.id}.value`);
      const layers = Math.max(1, Math.floor(valueSource ? evalNumber(battle, graph, active, valueSource, candidate, units) : 1));
      const def = registry?.getEffect(effectId);
      const info = effectCardValue(def);
      // 不可叠层的效果如果目标身上已经有了，再挂一次没有收益；
      // 负面效果只考虑敌方，避免 AI 把控制 / 减益丢给自己人。
      let validTargets = def && !def.stackable
        ? targets.filter((t) => !(t.effects || []).some((e) => e.id === effectId))
        : targets;
      if (def?.polarity === "negative") validTargets = validTargets.filter((t) => t.side !== active.side);
      if (!validTargets.length) continue;
      const count = Math.max(1, validTargets.length);
      control += info.control * layers * mult * count;
      effect += info.effect * layers * mult * count;
      if (info.control > 0) {
        for (const t of validTargets) priority += unitThreat(battle, t);
      }
    } else if (node.type === "summon" || node.type === "summonChild") {
      effect += 2 * mult;
    } else if (node.type === "giveSkill") {
      effect += 3 * mult;
    } else if (node.type === "heal") {
      effect += 1 * mult;
    } else if (node.type === "removeEffect" || node.type === "forceExit" || node.type === "skipTurn" || node.type === "immuneDamage") {
      control += 2 * mult;
      effect += 1 * mult;
    } else {
      effect += 0.5 * mult;
    }
  }
  return { control, effect, priority };
}

/** 敌方威胁：未行动优先，其次攻击 / 生命 / 速度 / 主动技能数。 */
function unitThreat(battle, unit) {
  if (!unit) return 0;
  const internal = battle.getUnit(unit.uid);
  const stats = internal ? battle.statsOf(internal) : null;
  let score = unit.acted ? 0 : 1000;
  if (stats) score += (Number(stats.atk) || 0) * 1.2 + (Number(unit.hp) || 0) * 0.08 + (Number(stats.speed) || 0) * 0.5;
  score += (unit.skills?.length || 0) * 40;
  return score;
}

function profileDataSkill(battle, active, skill, units, enemies) {
  const effects = normalizeEffects(skill);
  const enemyDamage = effects.some((e) => e.kind === "damage" && e.target === "enemy");
  const hasEffect = effects.some((e) => e.kind !== "damage");
  const needsTarget = Boolean(skill.requiresTarget) || enemyDamage;
  const result = emptyProfile(needsTarget, false);
  const candidates = enemyDamage ? enemies : [null];
  const aStats = battle.statsOf(active);
  const value =
    skill.valueSource === "atk" || skill.valueSource === undefined
      ? aStats.atk
      : Number(skill.valueSource) || 0;
  let bestDamage = null;
  let bestEffect = null;

  for (const candidate of candidates) {
    let damage = 0;
    let effectScore = 0;
    for (const eff of effects) {
      if (eff.kind === "damage") {
        const target = eff.target === "enemy" ? candidate : active;
        if (!target) continue;
        const raw = estimateHit(battle, active, target, value, eff.attribute || "physical", false, false);
        const capped = Math.min(raw, target.hp);
        damage += target.side === active.side ? -capped : capped;
      } else {
        effectScore += 1;
      }
    }
    const targetHp = candidate ? candidate.hp : 0;
    if (
      !bestDamage ||
      damage > bestDamage.damage + 1e-9 ||
      (Math.abs(damage - bestDamage.damage) <= 1e-9 && targetHp < bestDamage.targetHp)
    ) {
      bestDamage = { damage, targetHp, candidate };
    }
    if (
      !bestEffect ||
      effectScore > bestEffect.effectScore ||
      (effectScore === bestEffect.effectScore && targetHp < bestEffect.targetHp)
    ) {
      bestEffect = { effectScore, targetHp, candidate };
    }
  }

  if (bestDamage && bestDamage.damage > 0) {
    result.damage = bestDamage.damage;
    result.targetHp = bestDamage.targetHp;
    result.targetUid = bestDamage.candidate ? bestDamage.candidate.uid : null;
  }
  if (bestEffect) {
    result.effectScore = hasEffect ? bestEffect.effectScore : 0;
    if (!bestDamage || bestDamage.damage <= 0) {
      result.targetHp = bestEffect.targetHp;
      result.targetUid = bestEffect.candidate ? bestEffect.candidate.uid : null;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 流程扫描                                                            */
/* ------------------------------------------------------------------ */
function buildGraph(flow) {
  const nodes = new Map();
  for (const n of flow.nodes || []) if (n && n.id) nodes.set(n.id, n);
  const inSource = new Map();
  const out = new Map();
  for (const link of flow.links || []) {
    if (!link || !link.from || !link.to) continue;
    inSource.set(`${link.to}.${link.portTo}`, link.from);
    if (!out.has(link.from)) out.set(link.from, []);
    out.get(link.from).push(link);
  }
  return { nodes, inSource, out };
}

function scanFlow(battle, active, graph, candidate, units) {
  const attacks = [];
  const effects = [];
  const seen = new Map();
  const triggers = [...graph.nodes.values()].filter(
    (n) => n.type === "trigger" && ["skillCastSelf", "skillCast"].includes(n.options?.event)
  );
  const starts = triggers.length ? triggers : [...graph.nodes.values()].filter((n) => n.type === "trigger").slice(0, 1);

  const walk = (nodeId, mult, depth) => {
    if (!nodeId || depth > 30 || mult <= 0) return;
    const node = graph.nodes.get(nodeId);
    if (!node) return;
    if ((seen.get(nodeId) || 0) >= mult) return;
    seen.set(nodeId, Math.max(seen.get(nodeId) || 0, mult));
    if (node.type === "attack") attacks.push({ node, mult });
    if (EFFECT_NODES.has(node.type)) {
      const targetSource = graph.inSource.get(`${node.id}.targets`);
      const targets = targetSource ? resolveTargets(graph, active, targetSource, candidate, units) : null;
      if (!targetSource || targets.length) effects.push({ node, mult });
    }
    for (const link of graph.out.get(nodeId) || []) {
      if (!EXEC_PORTS.has(link.port)) continue;
      let nextMult = mult;
      if (node.type === "repeatLoop" && link.port === "body") {
        nextMult *= loopCount(battle, graph, active, node, candidate, units);
      } else if (node.type === "forEach" && link.port === "body") {
        nextMult *= forEachCount(battle, graph, active, node, candidate, units);
      }
      walk(link.to, nextMult, depth + 1);
    }
  };

  for (const trigger of starts) {
    const link = (graph.out.get(trigger.id) || []).find((l) => l.port === "next");
    if (link) walk(link.to, 1, 0);
  }
  return { attacks, effects };
}

function loopCount(battle, graph, active, node, candidate, units) {
  const source = graph.inSource.get(`${node.id}.count`);
  const n = source ? evalNumber(battle, graph, active, source, candidate, units) : Number(node.options?.count) || 0;
  return Math.max(1, Math.min(10, Math.round(n) || 1));
}

function forEachCount(battle, graph, active, node, candidate, units) {
  const source = graph.inSource.get(`${node.id}.targets`);
  if (!source) return 1;
  const list = resolveTargets(graph, active, source, candidate, units);
  return Math.max(1, Math.min(10, list.length || 1));
}

/* ------------------------------------------------------------------ */
/* 伤害                                                                */
/* ------------------------------------------------------------------ */
function totalDamage(battle, graph, active, attacks, candidate, units) {
  const perTarget = new Map();
  for (const { node, mult } of attacks) {
    const targetSource = graph.inSource.get(`${node.id}.targets`);
    const targets = resolveTargets(graph, active, targetSource, candidate, units);
    if (!targets.length) continue;
    const valueSource = graph.inSource.get(`${node.id}.value`);
    const attrSource = graph.inSource.get(`${node.id}.attribute`);
    const attribute = attrSource
      ? evalString(graph, active, attrSource, candidate) || node.options?.attribute || "physical"
      : node.options?.attribute || "physical";
    const ignoreReduction = Boolean(node.options?.ignoreReduction);
    const additional = Boolean(node.options?.additional);
    for (const target of targets) {
      const value = valueSource ? evalNumber(battle, graph, active, valueSource, target, units) : 0;
      const raw = estimateHit(battle, active, target, value, attribute, ignoreReduction, additional);
      perTarget.set(target.uid, (perTarget.get(target.uid) || 0) + raw * mult);
    }
  }
  let total = 0;
  for (const [uid, raw] of perTarget) {
    const target = units.find((u) => u.uid === uid);
    if (!target) continue;
    const capped = Math.min(raw, target.hp);
    total += target.side === active.side ? -capped : capped;
  }
  return total;
}

function estimateHit(battle, active, targetPub, value, attribute, ignoreReduction, additional) {
  const target = battle.getUnit(targetPub.uid);
  if (!target) return 0;
  const result = calculateDamage({
    attacker: battle.statsOf(active),
    target: battle.statsOf(target),
    skillValue: Number(value) || 0,
    attribute,
    noCrit: true,
    rng: () => 0.5,
    targetInvincible: battle.isInvincible(target),
    ignoreReduction,
    additional,
  });
  return Math.max(0, Number(result.finalDamage) || 0);
}

/* ------------------------------------------------------------------ */
/* 目标集                                                              */
/* ------------------------------------------------------------------ */
function resolveTargets(graph, active, nodeId, candidate, units) {
  return resolveTargetsInner(graph, active, nodeId, candidate, units, 0);
}

function resolveTargetsInner(graph, active, nodeId, candidate, units, depth) {
  if (!nodeId || depth > 20) return [];
  const node = graph.nodes.get(nodeId);
  if (!node) return [];
  const source = (port) => graph.inSource.get(`${node.id}.${port}`);
  const sideUnits = (side) => units.filter((u) => u.side === side);
  switch (node.type) {
    case "targetSide":
      return sideUnits(node.options?.side === "ally" ? active.side : other(active.side));
    case "chooseUnit": {
      const range = resolveTargetsInner(graph, active, source("targets"), candidate, units, depth + 1);
      if (!range.length) return [];
      if (node.options?.multiple === false) {
        if (!candidate) return [range[0]];
        return range.some((u) => u.uid === candidate.uid) ? [candidate] : [];
      }
      return range;
    }
    case "selfUnit":
      return [active];
    case "currentTarget":
      return candidate ? [candidate] : sideUnits(other(active.side)).slice(0, 1);
    case "contextUnit":
      return candidate ? [candidate] : [];
    case "triggerUnit":
      return [active];
    case "setOp": {
      const a = resolveTargetsInner(graph, active, source("a"), candidate, units, depth + 1);
      const b = resolveTargetsInner(graph, active, source("b"), candidate, units, depth + 1);
      if (node.options?.operator === "union") {
        const out = a.slice();
        for (const u of b) if (!out.some((x) => x.uid === u.uid)) out.push(u);
        return out;
      }
      if (node.options?.operator === "diff") return a.filter((u) => !b.some((x) => x.uid === u.uid));
      return a.filter((u) => b.some((x) => x.uid === u.uid));
    }
    case "filterSet":
      return resolveTargetsInner(graph, active, source("targets"), candidate, units, depth + 1);
    case "getUnit": {
      const list = resolveTargetsInner(graph, active, source("targets"), candidate, units, depth + 1);
      // 估算时默认取第一个；「获取单位」的索引对总伤影响很小。
      return list[0] ? [list[0]] : [];
    }
    default:
      return [];
  }
}

function other(side) {
  return side === "ally" ? "enemy" : "ally";
}

/* ------------------------------------------------------------------ */
/* 数值 / 字符串                                                        */
/* ------------------------------------------------------------------ */
function evalNumber(battle, graph, active, nodeId, scopeUnit, units, depth = 0, _unused = null) {
  if (!nodeId || depth > 20) return 0;
  const node = graph.nodes.get(nodeId);
  if (!node) return 0;
  const source = (port) => graph.inSource.get(`${node.id}.${port}`);
  switch (node.type) {
    case "number": {
      if (node.options?.mode === "pi") return Math.PI;
      if (node.options?.mode === "e") return Math.E;
      if (node.options?.mode === "range") {
        const lo = Math.ceil(Number(node.options.min) || 0);
        const hi = Math.floor(Number(node.options.max) || 0);
        return hi < lo ? lo : (lo + hi) / 2;
      }
      return Number(node.options?.value) || 0;
    }
    case "math": {
      const a = evalNumber(battle, graph, active, source("a"), scopeUnit, units, depth + 1);
      const b = evalNumber(battle, graph, active, source("b"), scopeUnit, units, depth + 1);
      switch (node.options?.operator) {
        case "add": return a + b;
        case "sub": return a - b;
        case "mul": return a * b;
        case "div": return b === 0 ? 0 : a / b;
        case "mod": return b === 0 ? 0 : a % b;
        case "pos": return Number.isFinite(a ** b) ? a ** b : 0;
        case "log": return a <= 0 || b <= 0 || a === 1 ? 0 : Math.log(b) / Math.log(a);
        case "round": return Math.round(a);
        case "abs": return Math.abs(a);
        case "ceil": return Math.ceil(a);
        case "floor": return Math.floor(a);
        case "max":
        case "min": {
          const vals = [a, b];
          for (let i = 1; i <= 12; i += 1) {
            const sid = source(`in${i}`);
            if (sid) vals.push(evalNumber(battle, graph, active, sid, scopeUnit, units, depth + 1));
          }
          return node.options?.operator === "max" ? Math.max(...vals) : Math.min(...vals);
        }
        default:
          return 0;
      }
    }
    case "selfData":
      return unitStatValue(battle, active, node.options?.field);
    case "unitData": {
      let u = scopeUnit || active;
      const targetSource = source("unit");
      if (targetSource) {
        const list = resolveTargets(graph, active, targetSource, scopeUnit, units);
        if (list[0]) u = list[0];
      }
      return unitStatValue(battle, u, node.options?.field);
    }
    default:
      return 0;
  }
}

function unitStatValue(battle, unit, field) {
  if (!unit) return 0;
  if (field === "hp") return Number(unit.hp) || 0;
  const stats = battle.statsOf(unit);
  switch (field) {
    case "atk": return Number(stats.atk) || 0;
    case "def": return Number(stats.def) || 0;
    case "hpMax": return Number(stats.hp) || 0;
    default: return Number(stats[field]) || 0;
  }
}

function evalString(graph, active, nodeId, scopeUnit) {
  const node = graph.nodes.get(nodeId);
  if (!node) return "";
  if (node.type === "string") return String(node.options?.value ?? "");
  if (node.type === "number") return String(Number(node.options?.value) || 0);
  return "";
}
