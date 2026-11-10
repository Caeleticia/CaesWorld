/**
 * battle-ai.js —— 人机出牌评估
 *
 * 对每个主动技能做一次轻量推演：
 *   · 解析技能流程里的「攻击」积木与目标集；
 *   · 用引擎伤害公式估算每个目标实际吃到的伤害（超过目标当前生命的溢出不计）；
 *   · 总伤 = 对敌方的不溢出伤害 − 对友方造成的伤害；
 *   · 击杀额外加权，但按溢出比例衰减（高额溢出不会比有效伤害更划算）；
 *   · 持续伤害效果（如数论）按攻击力 / 层数估算真实伤害，不再当成控制；
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

  // 控制、伤害、效果放到同一把尺子上比较：
  // 1 点控制 ≈ CONTROL_WEIGHT 点伤害，避免「有控制就永远无视击杀」。
  const CONTROL_WEIGHT = 120;
  const EFFECT_WEIGHT = 24;
  let best = null;
  let fallback = null;

  for (const { skill, index } of skills) {
    const profile = profileSkill(battle, active, skill, units, enemies, registry);
    const score =
      profile.controlValue * CONTROL_WEIGHT + profile.damage + profile.effectScore * EFFECT_WEIGHT;
    const candidate = { index, ...profile, score };
    if (!fallback) fallback = candidate;
    if (
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && candidate.damage > best.damage + 1e-9) ||
      (Math.abs(score - best.score) <= 1e-9 &&
        Math.abs(candidate.damage - best.damage) <= 1e-9 &&
        candidate.controlValue > best.controlValue + 1e-9) ||
      (Math.abs(score - best.score) <= 1e-9 &&
        Math.abs(candidate.damage - best.damage) <= 1e-9 &&
        Math.abs(candidate.controlValue - best.controlValue) <= 1e-9 &&
        candidate.targetHp < best.targetHp)
    ) {
      best = candidate;
    }
  }

  return best || fallback;
}

const QUALITY_SCORE = { white: 0, blue: 50, gold: 140, rainbow: 240 };

/**
 * 击败加权：单纯按「不溢出伤害」算，100 点伤害打死 100 血敌人只值 100，
 * 而 900 点伤害打 1000 血敌人值 900，人机会因此回避击杀。
 * 这里给击杀额外加权，同时用「有效伤害 / 总伤害」的比例衰减：
 * 同为击杀时，溢出越高加权越低，避免为了 1 个残血单位砸出十倍溢出。
 */
const KILL_BONUS = 2400;
const KILL_MIN_WEIGHT = 0.25;

function scoreEnemyHit(raw, hp) {
  const damage = Math.max(0, Number(raw) || 0);
  const life = Math.max(0, Number(hp) || 0);
  if (!damage || !life) return 0;
  if (damage <= life) return damage;
  const efficiency = life / damage; // 1 = 刚好击杀，趋近 0 = 高额溢出
  return life + KILL_BONUS * (KILL_MIN_WEIGHT + (1 - KILL_MIN_WEIGHT) * efficiency);
}
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
    const direct = totalDamage(battle, graph, active, scan.attacks, candidate, units);
    const metrics = effectMetrics(
      battle,
      graph,
      active,
      scan.effects,
      candidate,
      units,
      registry,
      direct.perTarget
    );
    const damage = direct.total + metrics.damage;
    const targetHp = candidate ? candidate.hp : 0;
    const priority = candidate ? unitThreat(battle, candidate) : 0;

    if (
      !bestControl ||
      metrics.control > bestControl.control + 1e-9 ||
      (Math.abs(metrics.control - bestControl.control) <= 1e-9 && damage > bestControl.damage + 1e-9) ||
      (Math.abs(metrics.control - bestControl.control) <= 1e-9 &&
        Math.abs(damage - bestControl.damage) <= 1e-9 &&
        priority > bestControl.priority)
    ) {
      bestControl = { control: metrics.control, effect: metrics.effect, priority, damage, candidate };
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
    result.damage = bestControl.damage;
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

/**
 * 特殊效果评分。
 * 只有真正让目标「少行动 / 不能行动」的流程才算控制；
 * 行动开始时造成伤害的持续伤害（例如数论）不再固定算 5 点控制，
 * 它的实际伤害由 estimateAttachedEffectDamage() 按攻击力 / 层数估算。
 */
function effectCardValue(def) {
  if (!def) return { control: 0, effect: 0.5 };
  let control = 0;
  let effect = 1;
  if (def.polarity === "negative") {
    // 负面效果本身就是「特殊效果」，但不等于控制
    effect += 1;
  }
  if (def.autoConsume) effect += 0.2;
  for (const trigger of def.triggers || []) {
    if (!trigger || !trigger.event) continue;
    if (trigger.event === "unitTurnStart") {
      const flow = def.flows?.[trigger.id];
      const nodes = flow?.nodes || [];
      if (nodes.some((n) => n.type === "skipTurn")) control += 10;
      else if (nodes.some((n) => n.type === "forceExit")) control += 8;
      else if (nodes.some((n) => n.type === "attack")) effect += 1;
      else control += 1;
      effect += 1;
    } else {
      effect += 1;
    }
  }
  return { control, effect };
}

function effectMetrics(
  battle,
  graph,
  active,
  effects,
  candidate,
  units,
  registry,
  directByTarget = new Map()
) {
  let control = 0;
  let effect = 0;
  let priority = 0;
  let damage = 0;
  /** 同一效果对同一目标的多次附加先合并层数，再估算一次持续伤害 */
  const attached = new Map();
  const remainingHp = (target) =>
    Math.max(0, (Number(target?.hp) || 0) - (Number(directByTarget.get(target?.uid)) || 0));

  for (const { node, mult } of effects) {
    const targetSource = graph.inSource.get(`${node.id}.targets`);
    const targets = targetSource ? resolveTargets(graph, active, targetSource, candidate, units) : [];
    if (targetSource && !targets.length) continue;
    if (node.type === "attachEffect") {
      const effectSource = graph.inSource.get(`${node.id}.effectId`);
      const effectId = effectSource ? evalString(graph, active, effectSource, candidate) : node.options?.effectId || "";
      const valueSource = graph.inSource.get(`${node.id}.value`);
      const layers = Math.max(
        1,
        Math.floor(valueSource ? evalNumber(battle, graph, active, valueSource, candidate, units) : 1)
      );
      const def = registry?.getEffect(effectId);
      const info = effectCardValue(def);
      // 不可叠层的效果如果目标身上已经有了，再挂一次没有收益；
      // 负面效果只考虑敌方，避免 AI 把控制 / 减益丢给自己人。
      let validTargets = def && !def.stackable
        ? targets.filter((t) => !(t.effects || []).some((e) => e.id === effectId))
        : targets;
      if (def?.polarity === "negative") validTargets = validTargets.filter((t) => t.side !== active.side);
      // 同一次技能里已经会被直接伤害打死的目标，挂效果没有收益
      validTargets = validTargets.filter((t) => remainingHp(t) > 0);
      if (!validTargets.length) continue;
      const stacks = layers * mult;
      for (const target of validTargets) {
        control += info.control * stacks;
        effect += info.effect * stacks;
        if (info.control > 0) priority += unitThreat(battle, target);
        if (def && stacks > 0) {
          const key = `${effectId}\u0000${target.uid}`;
          const prev = attached.get(key);
          if (prev) prev.layers += stacks;
          else {
            const existing = (target.effects || []).find((e) => e.id === effectId);
            attached.set(key, {
              def,
              target,
              layers: stacks,
              existingStacks: Math.max(0, Number(existing?.stacks) || 0),
            });
          }
        }
      }
    } else if (node.type === "summon" || node.type === "summonChild") {
      effect += 2 * mult;
    } else if (node.type === "giveSkill") {
      effect += 3 * mult;
    } else if (node.type === "heal") {
      effect += 1 * mult;
    } else if (
      node.type === "removeEffect" ||
      node.type === "forceExit" ||
      node.type === "skipTurn" ||
      node.type === "immuneDamage"
    ) {
      control += 2 * mult;
      effect += 1 * mult;
    } else {
      effect += 0.5 * mult;
    }
  }

  for (const { def, target, layers, existingStacks } of attached.values()) {
    const hp = remainingHp(target);
    if (hp <= 0) continue;
    const before = existingStacks > 0
      ? estimateAttachedEffectDamage(battle, def, active, target, existingStacks, units, hp)
      : 0;
    const after = estimateAttachedEffectDamage(
      battle,
      def,
      active,
      target,
      existingStacks + layers,
      units,
      hp
    );
    // 只计算「这次新加的层」带来的增量伤害；已有层数本来就会继续掉血
    damage += Math.max(0, after - before);
  }
  return { control, effect, priority, damage };
}

/* ------------------------------------------------------------------ */
/* 持续效果（数论等）的伤害估算                                          */
/* ------------------------------------------------------------------ */

/**
 * 估算「挂上某个效果后，它自己会在目标行动开始时造成多少伤害」。
 * 只处理 unitTurnStart 触发里的攻击积木；层数会按效果流程里的
 * removeEffect（每次消耗 1 层）逐回合递减，因此总伤害是三角和。
 *
 * 例：数论 = 施加者阵营全体攻击力之和 × 层数 × 0.08，行动开始扣 1 层。
 * 3 层、友方攻击力和 2800 时，实际是 672 + 448 + 224 = 1344，
 * 旧代码却只把它当成固定的 5 点「控制」，完全没算这笔伤害。
 */
function estimateAttachedEffectDamage(battle, def, caster, holder, layers, units, hpOverride = null) {
  if (!def || !caster || !holder) return 0;
  const hp = hpOverride == null ? Number(holder.hp) || 0 : Number(hpOverride) || 0;
  if (hp <= 0) return 0;
  const rawByTarget = new Map();
  for (const trigger of def.triggers || []) {
    if (!trigger || trigger.event !== "unitTurnStart") continue;
    const flow = def.flows?.[trigger.id];
    if (!flow) continue;
    const removesStack = (flow.nodes || []).some((n) => n && n.type === "removeEffect");
    const maxTicks = removesStack ? Math.max(1, Math.min(20, Math.floor(layers) || 1)) : 1;
    for (let i = 0; i < maxTicks; i += 1) {
      const stacks = removesStack ? Math.max(1, (Math.floor(layers) || 1) - i) : Math.max(1, Math.floor(layers) || 1);
      const tick = runEffectFlowRaw(battle, flow, caster, holder, stacks, units, def.id);
      for (const [uid, raw] of tick) rawByTarget.set(uid, (rawByTarget.get(uid) || 0) + raw);
    }
  }
  let score = 0;
  for (const [uid, raw] of rawByTarget) {
    const target = units.find((u) => u.uid === uid) || (uid === holder.uid ? holder : null);
    if (!target || target.side === caster.side) continue;
    const targetHp = uid === holder.uid ? hp : Number(target.hp) || 0;
    score += scoreEnemyHit(raw, targetHp);
  }
  return score;
}

/** 执行一遍效果的单回合流程，返回每个目标吃到的原始伤害 */
function runEffectFlowRaw(battle, flow, caster, holder, stacks, units, effectId = "") {
  const rawByTarget = new Map();
  const graph = buildGraph(flow);
  const vars = new Map();
  const ctx = { caster, holder, stacks, vars, contextUnit: null, units, effectId };
  const triggers = [...graph.nodes.values()].filter(
    (n) => n && n.type === "trigger" && n.options?.event === "unitTurnStart"
  );
  const start = triggers[0] || [...graph.nodes.values()].find((n) => n && n.type === "trigger");
  if (!start) return rawByTarget;

  const follow = (nodeId, depth) => {
    if (!nodeId || depth > 30) return;
    const node = graph.nodes.get(nodeId);
    if (!node) return;
    const next = (port = "next") =>
      (graph.out.get(node.id) || []).find((link) => link.port === port);
    const walkNext = (port = "next") => {
      const link = next(port);
      if (link) follow(link.to, depth + 1);
    };

    switch (node.type) {
      case "declareVariable": {
        const name = String(node.options?.name || "");
        if (name) {
          const type = node.options?.type;
          vars.set(name, type === "string" ? "" : type === "boolean" ? false : 0);
        }
        walkNext();
        return;
      }
      case "setVariable":
      case "addVariable": {
        const name = String(node.options?.name || "");
        const value = evalEffectNumber(battle, graph, ctx, graph.inSource.get(`${node.id}.value`), 0);
        if (name) {
          if (node.type === "addVariable") vars.set(name, (Number(vars.get(name)) || 0) + value);
          else vars.set(name, value);
        }
        walkNext();
        return;
      }
      case "forEach": {
        const list = resolveEffectTargets(
          graph,
          ctx,
          graph.inSource.get(`${node.id}.targets`),
          0
        ).slice(0, 20);
        for (const unit of list) {
          ctx.contextUnit = unit;
          const body = next("body");
          if (body) follow(body.to, depth + 1);
        }
        ctx.contextUnit = null;
        walkNext("end");
        return;
      }
      case "repeatLoop": {
        const source = graph.inSource.get(`${node.id}.count`);
        const count = source
          ? evalEffectNumber(battle, graph, ctx, source, 0)
          : Number(node.options?.count) || 0;
        const loops = Math.max(1, Math.min(20, Math.round(count) || 1));
        for (let i = 0; i < loops; i += 1) {
          const body = next("body");
          if (body) follow(body.to, depth + 1);
        }
        walkNext("end");
        return;
      }
      case "attack": {
        const value = evalEffectNumber(
          battle,
          graph,
          ctx,
          graph.inSource.get(`${node.id}.value`),
          0
        );
        const attrSource = graph.inSource.get(`${node.id}.attribute`);
        const attribute =
          (attrSource ? evalEffectString(graph, ctx, attrSource) : "") ||
          node.options?.attribute ||
          "physical";
        const targets = resolveEffectTargets(
          graph,
          ctx,
          graph.inSource.get(`${node.id}.targets`),
          0
        );
        const sourceUnit = resolveEffectTargets(
          graph,
          ctx,
          graph.inSource.get(`${node.id}.source`),
          0
        )[0];
        const attacker = battle.getUnit(sourceUnit?.uid) || battle.getUnit(holder.uid) || caster;
        for (const target of targets) {
          const raw = estimateHit(
            battle,
            attacker,
            target,
            value,
            attribute,
            Boolean(node.options?.ignoreReduction),
            Boolean(node.options?.additional)
          );
          rawByTarget.set(target.uid, (rawByTarget.get(target.uid) || 0) + raw);
        }
        walkNext();
        return;
      }
      default:
        // removeEffect / skipTurn / 数据积木等：不影响本次伤害，继续执行链
        walkNext();
    }
  };

  const first = (graph.out.get(start.id) || []).find((link) => link.port === "next");
  if (first) follow(first.to, 0);
  return rawByTarget;
}

/** 效果流程里的数值积木（支持变量、遍历上下文、效果层数） */
function evalEffectNumber(battle, graph, ctx, nodeId, depth) {
  if (!nodeId || depth > 20) return 0;
  const node = graph.nodes.get(nodeId);
  if (!node) return 0;
  const source = (port) => graph.inSource.get(`${node.id}.${port}`);
  const sub = (id) => evalEffectNumber(battle, graph, ctx, id, depth + 1);
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
      const a = sub(source("a"));
      const b = sub(source("b"));
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
            if (sid) vals.push(sub(sid));
          }
          return node.options?.operator === "max" ? Math.max(...vals) : Math.min(...vals);
        }
        default:
          return 0;
      }
    }
    case "selfData": {
      const field = node.options?.field;
      if (field === "effectStacks") return Math.max(1, Math.floor(ctx.stacks) || 1);
      return unitStatValue(battle, ctx.holder, field);
    }
    case "unitData": {
      let unit = ctx.contextUnit || ctx.holder;
      const targetSource = source("unit");
      if (targetSource) {
        const list = resolveEffectTargets(graph, ctx, targetSource, depth + 1);
        if (list[0]) unit = list[0];
      }
      return unitStatValue(battle, unit, node.options?.field);
    }
    case "readVariable":
      return Number(ctx.vars.get(String(node.options?.name || ""))) || 0;
    default:
      return 0;
  }
}

function evalEffectString(graph, ctx, nodeId) {
  const node = graph.nodes.get(nodeId);
  if (!node) return "";
  if (node.type === "string") return String(node.options?.value ?? "");
  if (node.type === "number") return String(Number(node.options?.value) || 0);
  if (node.type === "currentEffect") return String(ctx?.effectId || "");
  return "";
}

/** 效果流程里的目标集（支持施加者阵营 / 遍历上下文 / 自身） */
function resolveEffectTargets(graph, ctx, nodeId, depth) {
  if (!nodeId || depth > 20) return [];
  const node = graph.nodes.get(nodeId);
  if (!node) return [];
  const source = (port) => graph.inSource.get(`${node.id}.${port}`);
  const units = ctx.units || [];
  const sideUnits = (side) => units.filter((u) => u.side === side);
  switch (node.type) {
    case "targetSide":
      return sideUnits(node.options?.side === "ally" ? ctx.caster.side : other(ctx.caster.side));
    case "effectSourceSide": {
      const includeUncounted = Boolean(node.options?.includeUncounted);
      return units.filter(
        (u) => u.side === ctx.caster.side && (includeUncounted || u.countsAsUnit)
      );
    }
    case "effectSource":
      return ctx.caster ? [ctx.caster] : [];
    case "selfUnit":
    case "triggerUnit":
      return [ctx.holder];
    case "contextUnit":
      return ctx.contextUnit ? [ctx.contextUnit] : [];
    case "currentTarget":
      return [ctx.holder];
    case "chooseUnit": {
      const range = resolveEffectTargets(graph, ctx, source("targets"), depth + 1);
      if (!range.length) return [];
      if (node.options?.multiple === false) return [range[0]];
      return range;
    }
    case "setOp": {
      const a = resolveEffectTargets(graph, ctx, source("a"), depth + 1);
      const b = resolveEffectTargets(graph, ctx, source("b"), depth + 1);
      if (node.options?.operator === "union") {
        const out = a.slice();
        for (const u of b) if (!out.some((x) => x.uid === u.uid)) out.push(u);
        return out;
      }
      if (node.options?.operator === "diff") return a.filter((u) => !b.some((x) => x.uid === u.uid));
      return a.filter((u) => b.some((x) => x.uid === u.uid));
    }
    case "filterSet":
      return resolveEffectTargets(graph, ctx, source("targets"), depth + 1);
    case "getUnit": {
      const list = resolveEffectTargets(graph, ctx, source("targets"), depth + 1);
      return list[0] ? [list[0]] : [];
    }
    default:
      return [];
  }
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
    const perTarget = new Map();
    let effectScore = 0;
    for (const eff of effects) {
      if (eff.kind === "damage") {
        const target = eff.target === "enemy" ? candidate : active;
        if (!target) continue;
        const raw = estimateHit(battle, active, target, value, eff.attribute || "physical", false, false);
        perTarget.set(target.uid, (perTarget.get(target.uid) || 0) + raw);
      } else {
        effectScore += 1;
      }
    }
    let damage = 0;
    for (const [uid, raw] of perTarget) {
      const target = units.find((u) => u.uid === uid);
      if (!target) continue;
      if (target.side === active.side) damage -= Math.min(raw, target.hp);
      else damage += scoreEnemyHit(raw, target.hp);
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
    if (target.side === active.side) total -= Math.min(raw, target.hp);
    else total += scoreEnemyHit(raw, target.hp);
  }
  return { total, perTarget };
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
  const internal = battle.getUnit(unit.uid) || unit;
  if (field === "hp") return Number(internal.hp) || 0;
  const stats = battle.statsOf(internal);
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
