/**
 * battle.js —— 回合制战斗引擎（含积木流程运行时）
 *
 * 只管逻辑，不碰界面、不生成关卡。一局战斗 = 两队单位按速度轮转行动：
 *   行动方「使用技能」或「结束回合」→ 行动方效果计时 -1 → 轮到下一个活着的单位
 *
 * 三个核心概念：
 *  - 技能：挂在角色身上，由角色为主体执行（技能流程里的「自己」= 施放者）。
 *  - 效果：同样挂在角色身上，**存在时才可能触发**，触发后执行积木流程。
 *  - 流程：engine/flow.js 解释执行。
 *
 * 伤害过程：计算 → 广播「单位受击时」（效果可叠加成组免疫）→ 生效 → 广播损失生命/死亡。
 * 同一次伤害里先结算的所有「免疫伤害」共同抵消这一次伤害。
 *
 * 代码里把「攻击方」写作 A、「目标方」写作 B，与伤害公式一致。
 */
import {
  ATTRIBUTES,
  RESISTANCE_ATTRIBUTES,
  TRUE_DAMAGE_ATTRIBUTE,
  UNIT_STATES,
} from "./constants.js";
import { createRng } from "./math.js";
import { addBonus, emptyAccum } from "./modifiers.js";
import { computeStats } from "./stats.js";
import { calculateDamage } from "./damage.js";
import { normalizeEffects } from "./skills.js";
import { buffToBonus, buffExpired, createBuff, hasTag, resetBuffSequence } from "./buffs.js";
import { canPlace, normalizeSlot, otherSide, selectTarget, sideOf, DEFAULT_SLOTS } from "./targeting.js";
import { prepareFlow, runFlow } from "./flow.js";

export const BATTLE_EVENT = Object.freeze({
  BATTLE_START: "battle:start",
  TURN_START: "turn:start",
  TURN_END: "turn:end",
  /** 回合（round）：side 模式下「全场单位各行动一次」算一回合 */
  ROUND_START: "round:start",
  ROUND_END: "round:end",
  /** 轮到某一方选择行动单位（side 模式） */
  SIDE_TURN: "side:turn",
  ACTION_START: "action:start",
  ACTION_SKIP: "action:skip",
  SKILL: "skill",
  ATTACK: "attack",
  DAMAGE: "damage",
  IMMUNE: "immune",
  HEAL: "heal",
  HP_LOST: "hp:lost",
  BUFF_ADDED: "buff:added",
  BUFF_EXPIRED: "buff:expired",
  BUFF_REMOVED: "buff:removed",
  EFFECT_ADDED: "effect:added",
  EFFECT_REMOVED: "effect:removed",
  SKILL_GRANTED: "skill:granted",
  SUMMON: "summon",
  EXIT: "exit",
  DEATH: "death",
  FLOW_ERROR: "flow:error",
  BATTLE_END: "battle:end",
});

/**
 * 战斗模式：
 *   speed —— 按速度排序，每个单位轮流行动（旧流程，默认）
 *   side  —— 训练场流程：每回合双方各自入场新单位 → 触发回合开始效果 →
 *            红方先手、双方交替各选 1 个未行动单位行动 1 次 → 回合结束效果 → 下一回合
 */
export const BATTLE_MODE = Object.freeze({
  SPEED: "speed",
  SIDE: "side",
});

/** side 模式的阶段 */
export const BATTLE_PHASE = Object.freeze({
  /** 等待当前方选择行动单位 */
  SELECT: "select",
  /** 已选中单位，等待使用技能 / 结束行动 */
  ACT: "act",
  FINISHED: "finished",
});

/** 战斗结束（终止）原因 */
export const BATTLE_END_REASON = Object.freeze({
  ALLY_DEFEATED: "ally-defeated",
  ENEMY_DEFEATED: "enemy-defeated",
  DRAW: "draw",
  MAX_CYCLES: "max-cycles",
});

/** 效果卡上的标记 */
export const EFFECT_FLAGS = Object.freeze({
  NEGATIVE: "negative",
  UNREMOVABLE: "unremovable",
});

/** 「退场」原因 */
export const EXIT_CAUSE = Object.freeze({
  DEATH: "death",
  FORCE: "force",
  PARENT: "parent-exit",
});

const MAX_TRIGGER_DEPTH = 20;

let seq = 0;
const nextUid = () => `battle:${++seq}`;

/**
 * @param {object} setup
 * @param {object} setup.registry      ContentRegistry（单位卡 / 技能卡 / 效果卡）
 * @param {Array} setup.units          [{ cardId, side: "ally"|"enemy", slot, hp?, label? }]
 * @param {number} [setup.seed]
 * @param {number} [setup.maxCycles]
 * @param {number} [setup.slotsPerSide]
 * @param {number} [setup.summonLimit] 每侧计数单位上限（不勾「无视单位上限」时生效）
 * @param {function} [setup.chooseTargets] 玩家选人回调（返回单位或单位数组），传了才允许「选择单位」积木
 * @param {function} [setup.onEvent]
 *
 * —— side 模式（训练场）专用 ——
 * @param {"speed"|"side"} [setup.mode]
 * @param {{ally?: string[], enemy?: string[]}} [setup.decks] 双方牌组（单位卡 id，按入场顺序）
 * @param {number} [setup.maxUnits] 每侧场上最多单位数（默认取 summonLimit / slotsPerSide）
 * @param {"ally"|"enemy"} [setup.firstSide] 先手方（默认 ally = 红方）
 * @param {string[]} [setup.invincibleSides] 整方无敌（训练场「红方无敌 / 蓝方无敌」）
 */
export function createBattle(setup) {
  const {
    registry,
    units = [],
    seed = 1,
    maxCycles = 8,
    onEvent = null,
    slotsPerSide = DEFAULT_SLOTS,
    summonLimit = slotsPerSide,
    mode = BATTLE_MODE.SPEED,
    decks = null,
    maxUnits = null,
    firstSide = "ally",
    invincibleSides = [],
  } = setup || {};

  if (!registry) throw new Error("createBattle 需要 registry");
  if (!Object.values(BATTLE_MODE).includes(mode)) throw new Error(`无效战斗模式：${mode}`);

  const sideMode = mode === BATTLE_MODE.SIDE;
  const fieldSize = Math.max(
    1,
    Math.min(24, Math.round(Number(maxUnits) || Number(summonLimit) || Number(slotsPerSide) || DEFAULT_SLOTS))
  );
  /** side 模式下格子数与场上单位上限都等于「场上最多单位数」 */
  const slots = sideMode ? fieldSize : slotsPerSide;
  const limit = sideMode ? fieldSize : summonLimit;
  const first = sideOf(firstSide || "ally");

  const id = nextUid();
  const rng = createRng(seed);
  resetBuffSequence(0);

  const events = [];
  let muted = false;
  let triggerDepth = 0;
  let summonSeq = 0;
  let lastEndedAction = null;
  let pendingPick = null;
  let immuneGroup = [];
  /** 当前施法者「技能打出的目标」（供「当前目标」积木使用） */
  let prevSkillTargets = [];

  const state = {
    id,
    seed: rng.seed,
    status: "running",
    endReason: null,
    winner: null,
    turn: 0,
    activeId: null,
    actionSeq: 0,
    cycle: 0,
    maxCycles,
    slotsPerSide: slots,
    summonLimit: limit,
    units: [],
    events,
    /** 战斗模式：speed / side */
    mode,
    /** side 模式：select / act / finished；speed 模式恒为 act */
    phase: sideMode ? BATTLE_PHASE.SELECT : BATTLE_PHASE.ACT,
    /** side 模式：当前轮到哪一方选单位 */
    sideTurn: first,
    firstSide: first,
    /** side 模式：本回合已经行动过的单位 uid */
    acted: [],
    /** side 模式：每侧场上最多单位数 */
    maxUnits: fieldSize,
    /** 整方无敌 */
    invincibleSides: Array.isArray(invincibleSides)
      ? invincibleSides.filter((s) => s === "ally" || s === "enemy")
      : [],
    /** side 模式：双方牌组（剩余待入场单位卡 id） */
    decks: sideMode
      ? {
          ally: decks && Array.isArray(decks.ally) ? decks.ally.slice() : [],
          enemy: decks && Array.isArray(decks.enemy) ? decks.enemy.slice() : [],
        }
      : { ally: [], enemy: [] },
    /** 正在做回合开始入场（此时入场单位本回合可以行动） */
    deploying: false,
    /** 本回合被「跳过行动」标记的单位 */
    skippedThisTurn: [],
    /** 正在执行技能/效果的上下文（供「当前目标」类积木读取） */
    current: { skillUnit: null, curTargets: [], flowOwner: null },
  };

  const log = (type, payload = {}) => {
    const ev = { seq: events.length + 1, type, turn: state.turn, ...payload };
    if (!muted) {
      events.push(ev);
      if (typeof onEvent === "function") onEvent(ev);
    }
    return ev;
  };

  /** 正在广播的事件（效果的触发流程里用来取「触发的单位」） */
  let emitting = null;
  /** 事件嵌套栈：嵌套触发时用栈顶事件判断「触发单位」 */
  const emitStack = [];

  /* ================= 建单位 ================= */
  units.forEach((spec, index) => {
    const card = registry.getUnit(spec.cardId);
    if (!card) throw new Error(`未知单位卡：${spec.cardId}`);
    const side = sideOf(spec.side);
    const slot = normalizeSlot(spec.slot ?? (index + 1)) ?? index + 1;
    if (card.occupiesSlot) {
      const peers = state.units.filter((u) => u.side === side);
      const check = canPlace(peers, { id: null, slot, occupiesSlot: true });
      if (!check.ok) throw new Error(`${side} 侧：${check.reason}`);
    }
    const uid = `u${state.units.length + 1}`;
    state.units.push(makeUnit(uid, card, side, slot, spec.hp, spec.label));
  });

  function makeUnit(uid, card, side, slot, hp, label) {
    const skills = card.skills.map((sid) => {
      const s = registry.getSkill(sid);
      if (!s) throw new Error(`单位 ${card.id} 引用了不存在的技能 ${sid}`);
      return structuredClone(s);
    });
    const startHp = hp === undefined || hp === null ? card.baseHp : hp;
    return {
      uid,
      key: uid,
      card: structuredClone(card),
      cardId: card.id,
      name: card.name || card.id,
      side,
      slot,
      occupiesSlot: card.occupiesSlot,
      countsAsUnit: card.countsAsUnit,
      invincible: card.invincible,
      rarity: card.quality,
      /** 标签：一个单位一个（召唤时可覆盖） */
      label: label !== undefined && label !== null ? String(label) : card.label,
      skills,
      buffs: [],
      /** 效果层栈：[{ id, stacks }]，按首次附加顺序 */
      effects: [],
      /** 临时属性层 { physical: { flat, pct }, atk: {…}, hp: {…} } */
      attrBonus: {},
      /** 被「给予技能」临时获得的技能 [{ skillId, count }] */
      granted: [],
      parentKey: null,
      inheritedFrom: null,
      hp: Math.max(1, Math.min(card.baseHp, startHp)),
      state: UNIT_STATES[0],
      permanentBonuses: (card.bonuses || []).map((b) => ({ ...b })),
      extraBonuses: [],
      stats: {
        lastAttackDamage: 0,
        lastAttackHits: 0,
        lastHeal: 0,
        lastLose: 0,
        lastHpChange: 0,
        lastAttackTargets: [],
        lastHitSource: null,
      },
      damageDealt: 0,
      damageTaken: 0,
      killedBy: null,
      exited: false,
      exitedCause: null,
    };
  }

  /* ================= 基础查询 ================= */
  const getUnit = (ref) => {
    if (!ref) return null;
    if (typeof ref === "string") return state.units.find((u) => u.uid === ref || u.key === ref) || null;
    if (typeof ref === "object") return state.units.find((u) => u.key === ref.key) || null;
    return null;
  };
  const isAlive = (u) => Boolean(u) && u.state === UNIT_STATES[0];
  const isInvincible = (u) => Boolean(u) && (u.invincible || state.invincibleSides.includes(u.side));
  const livingUnits = () => state.units.filter(isAlive);
  const livingOf = (side) => livingUnits().filter((u) => u.side === side);
  const listSide = (side) => livingOf(side).filter((u) => u.countsAsUnit);
  const displayLabel = (u) => (u && u.label !== undefined && u.label !== null ? String(u.label) : "");

  function statsOf(unit, scope = "normal") {
    if (!unit) return null;
    const card = unit.card;
    if (scope === "origin") return computeStats(card, emptyAccum());
    const acc = emptyAccum();
    for (const b of unit.permanentBonuses) addBonus(acc, b);
    for (const b of unit.extraBonuses) addBonus(acc, b);
    for (const buff of unit.buffs) addBonus(acc, buffToBonus(buff));
    const s = computeStats(card, acc);
    // 效果带来的临时属性层
    const layer = unit.attrBonus || {};
    if (layer.atk) s.atk = Math.max(0, s.atk * (1 + layer.atk.pct) + layer.atk.flat);
    if (layer.def) s.def = Math.max(0, s.def * (1 + layer.def.pct) + layer.def.flat);
    if (layer.hp) s.hp = Math.max(0, s.hp * (1 + layer.hp.pct) + layer.hp.flat);
    return s;
  }

  function resistancesOf(u) {
    const s = statsOf(u);
    const out = { ...s.resistances };
    for (const attr of RESISTANCE_ATTRIBUTES) {
      if (u.attrBonus[attr]) out[attr] = (out[attr] || 0) + u.attrBonus[attr].flat;
    }
    return out;
  }

  /* ================= 效果层栈 ================= */
  const cardEffectsOf = (u) => (Array.isArray(u.card.effects) ? u.card.effects : []);
  const effectStacks = (u, eid) => {
    const e = u.effects.find((x) => x.id === eid);
    return e ? e.stacks : 0;
  };
  const effectFlag = (eid, flag) => {
    const def = registry.getEffect(eid);
    return Boolean(def && Array.isArray(def.flags) && def.flags.includes(flag));
  };

  function recomputeAttrBonuses(u) {
    u.attrBonus = {};
    for (const layer of u.effects) {
      const def = registry.getEffect(layer.id);
      if (!def || !Array.isArray(def.attrBonus)) continue;
      for (const op of def.attrBonus) {
        if (!op || !op.attr) continue;
        const value = (Number(op.value) || 0) * layer.stacks;
        u.attrBonus[op.attr] = u.attrBonus[op.attr] || { flat: 0, pct: 0 };
        const t = u.attrBonus[op.attr];
        if (op.pct) t.pct += value;
        else t.flat += value;
      }
    }
  }

  function attachEffect(target, eid, extra = {}) {
    const u = getUnit(target);
    if (!isAlive(u)) return null;
    if (!registry.getEffect(eid)) throw new Error(`未知效果：${eid}`);
    let layer = u.effects.find((e) => e.id === eid);
    if (!layer) {
      layer = { id: eid, stacks: 0, sourceId: extra.source ? extra.source.key : null };
      u.effects.push(layer);
    }
    layer.stacks += 1;
    recomputeAttrBonuses(u);
    log(BATTLE_EVENT.EFFECT_ADDED, { unit: u.uid, effect: eid, stacks: layer.stacks });
    if (layer.stacks === 1) emit("unitEnter", [u]);
    emit("dataUpdate", [u]);
    return layer;
  }

  function removeLayers(u, layer, count) {
    const idx = u.effects.indexOf(layer);
    if (idx < 0) return 0;
    const removed = Math.min(layer.stacks, count);
    layer.stacks -= removed;
    if (layer.stacks <= 0) u.effects.splice(idx, 1);
    recomputeAttrBonuses(u);
    return removed;
  }

  function removeEffectByMode(target, opts = {}) {
    const u = getUnit(target);
    if (!isAlive(u)) return 0;
    const { mode = "specified", effectId = "", layers = Infinity, force = false } = opts;
    const canRemove = (layer) => force || !effectFlag(layer.id, "unremovable");
    let total = 0;
    if (mode === "specified") {
      const layer = u.effects.find((e) => e.id === effectId);
      if (layer && canRemove(layer)) total += removeLayers(u, layer, layers);
    } else if (mode === "onePositive" || mode === "oneNegative") {
      const negative = mode === "oneNegative";
      const layer = u.effects.find((e) => canRemove(e) && effectFlag(e.id, "negative") === negative);
      if (layer) total += removeLayers(u, layer, layers);
    } else {
      const list = u.effects.filter((e) => canRemove(e) && (mode === "all" || effectFlag(e.id, "negative") === (mode === "allNegative")));
      for (const layer of list) total += removeLayers(u, layer, layers);
    }
    // 挂在子单位上的「继承效果」随来源一起移除
    if (total > 0) {
      for (const other of livingUnits()) {
        if (other === u) continue;
        const stale = other.effects.filter(
          (e) => e.inheritedFrom && e.inheritedFrom.source === u.key && !u.effects.some((x) => x.id === e.id)
        );
        for (const e of stale) removeLayers(other, e, Infinity);
      }
      log(BATTLE_EVENT.EFFECT_REMOVED, { unit: u.uid, mode, effectId, layers: total });
      emit("dataUpdate", [u]);
    }
    return total;
  }

  /* ================= 事件总线 ================= */
  /** 单位身上的全部效果（单位卡自带 + 卡面常驻效果 + 动态附加的效果） */
  function activeEffectsOf(u) {
    const out = [];
    for (const m of u.card.members || []) {
      if (m && m.effect) out.push({ ...m.effect, __member: { block: m.block, flow: m.flow } });
    }
    for (const eid of cardEffectsOf(u)) {
      const def = registry.getEffect(eid);
      if (def) out.push(def);
    }
    for (const layer of u.effects) {
      const def = registry.getEffect(layer.id);
      if (def) out.push(def);
    }
    return out;
  }

  /**
   * 判断某个效果/技能卡面上的触发是否响应当前事件。
   *
   * @param {object} effect 效果（单位卡 member 会带 __member）
   * @param {string} eventType 事件类型
   * @param {object} [info] 事件附加信息
   *   info.skillId：本次施放的技能 id，用于区分「单位释放该技能」。
   *   skillCastSelf 只在「施放的正是本技能自己」时成立——
   *   比对的是触发所在卡面（技能/效果）的 id 与本次施放的 skill.id 是否相同。
   */
  function triggerMatches(effect, eventType, info) {
    const skillId = info && info.skillId;
    const matchesEvent = (ev) => {
      if (ev === eventType) return true;
      // 「始终」：任何数据更新都触发一次
      if (ev === "always" && eventType === "dataUpdate") return true;
      // 「单位释放该技能」：本质是 skillCast 的收窄版，只认本技能自己
      if (ev === "skillCastSelf" && eventType === "skillCast") {
        return Boolean(skillId) && effect.id === skillId;
      }
      return false;
    };
    if (effect.__member) {
      if (!effect.__member.block || !effect.__member.block.event) return false;
      return matchesEvent(effect.__member.block.event);
    }
    return (effect.triggers || []).some((t) => t && t.event && matchesEvent(t.event));
  }

  /**
   * 广播事件：找出所有「身上有该事件触发」的效果并执行其流程。
   * @param {string} eventType
   * @param {object[]} targets 事件涉及的单位
   * @param {object} [info] 事件附加信息（如 skillId，用于「单位释放该技能」）
   */
  function emit(eventType, targets = [], info = {}) {
    if (state.status === "finished" && eventType !== "unitExit") return;
    if (triggerDepth > MAX_TRIGGER_DEPTH) {
      log(BATTLE_EVENT.FLOW_ERROR, { event: eventType, reason: "触发嵌套过深" });
      return;
    }
    const globalEvent = eventType === "turnStart" || eventType === "turnEnd";
    const candidates = [];
    const seen = new Set();
    for (const u of livingUnits()) {
      for (const effect of activeEffectsOf(u)) {
        if (!triggerMatches(effect, eventType, info)) continue;
        // 全局事件人人有份；其余事件只有「事件涉及的单位」身上的效果才会触发
        // （受击事件的目标就是正在挨打的单位，所以反伤不会再反向触发攻击方）
        // 事件对象必须带上单位 key（单位由 makeUnit 建立，key = uid）
        const relevant = globalEvent || targets.some((t) => t && t.key === u.key);
        if (!relevant) continue;
        const key = `${u.key}|${effect.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ unit: u, effect });
      }
    }
    if (!candidates.length) return;

    const frame = { type: eventType, targets, info };
    const prevEmitting = emitting;
    emitting = frame;
    emitStack.push(frame);
    triggerDepth += 1;
    try {
      for (const { unit, effect } of candidates) {
        if (!isAlive(unit)) continue;
        const flows = effect.flows || {};
        const sameEvent = (ev) =>
          ev === eventType ||
          (ev === "always" && eventType === "dataUpdate") ||
          (ev === "skillCastSelf" && eventType === "skillCast" && Boolean(info.skillId) && effect.id === info.skillId);
        const blocks = effect.__member
          ? [effect.__member.block].filter((b) => b && sameEvent(b.event))
          : (effect.triggers || []).filter((t) => t && t.event && sameEvent(t.event));
        for (const block of blocks) {
          if (state.status === "finished") break;
          // 单位卡 member 的流程挂在 __member.flow 上（不在 effect.flows 里）
          const flow = effect.__member ? effect.__member.flow : flows[block.id];
          if (!flow) continue;
          const prepared = prepareFlow(flow);
          if (!prepared.ok) {
            log(BATTLE_EVENT.FLOW_ERROR, { owner: unit.uid, effect: effect.id, errors: prepared.errors });
            continue;
          }
          // 触发流程在「该效果所在单位」的策略下执行；流程里的「自己」= 该单位
          const env = flowEnv(unit, effect, frame);
          try {
            runFlow(prepared, env, { triggerNode: prepared.nodes.has(block.id) ? block.id : undefined });
          } catch (err) {
            log(BATTLE_EVENT.FLOW_ERROR, { owner: unit.uid, effect: effect.id, reason: String((err && err.message) || err) });
          }
        }
      }
    } finally {
      emitStack.pop();
      triggerDepth -= 1;
      emitting = prevEmitting;
    }
  }

  /* ================= 流程运行环境 ================= */
  function flowEnv(owner, effect, frame) {
    // 正在广播的事件：优先用调用方给的那一帧（runFlow 可能嵌套多层事件）
    const current = frame || (emitStack.length ? emitStack[emitStack.length - 1] : null);
    let triggerUnit = owner;
    if (current && current.targets && current.targets.length) {
      triggerUnit = current.targets.find((t) => t && t.key === owner.key) || current.targets[0];
    }
    const self = triggeringUnitForEffect(effect, owner, triggerUnit);
    return {
      self,
      owner,
      /** 「8-1 触发的单位」积木：本次触发的单位（技能流程里就是自己） */
      triggerUnit: effect ? triggerUnit || owner : owner,
      context: { unit: null },
      interrupted: false,
      rng,
      sideOf: (u) => (u ? u.side : "ally"),
      otherSide,
      listSide,
      currentTarget: () => prevSkillTargets.slice(),
      pickForPlayer: (cands, opts) => playerChoose(cands, opts),
      unitData: (u, field, opts) => unitDataOf(u, field, opts),
      damage: (target, value, attribute, extra) => {
        const t = getUnit(target);
        if (!isAlive(t)) return;
        dealDamage({
          attackerRef: extra && extra.source ? extra.source : owner,
          targetRef: t,
          value,
          attribute,
          cause: "flow",
        });
      },
      healUnit: (target, amount) => heal(getUnit(target), amount, "flow"),
      setHp: (target, value) => setHp(getUnit(target), value, "flow"),
      attachEffect: (target, eid) => attachEffect(getUnit(target), eid, { source: owner }),
      removeEffectByMode: (target, opts) => removeEffectByMode(getUnit(target), opts),
      summon: (opts) => summonUnits(opts),
      skipTurn: (target) => {
        const t = getUnit(target);
        if (isAlive(t) && t.uid === state.activeId && !state.skippedThisTurn.includes(t.uid)) {
          state.skippedThisTurn.push(t.uid);
        }
      },
      grantImmune: (target) => {
        const t = getUnit(target);
        if (t && isAlive(t) && !immuneGroup.includes(t.key)) immuneGroup.push(t.key);
      },
      forceExit: (target) => forceExit(getUnit(target), { source: owner }),
      giveSkill: (skillId) => {
        if (!registry.getSkill(skillId)) return;
        const entry = owner.granted.find((g) => g.skillId === skillId);
        if (entry) entry.count += 1;
        else owner.granted.push({ skillId, count: 1 });
        log(BATTLE_EVENT.SKILL_GRANTED, { unit: owner.uid, skillId, stacks: entry ? entry.count : 1 });
      },
    };
  }

  /**
   * 触发积木的「自己」指谁：
   *  - 效果：看该效果卡上对应触发规则的 unitScope
   *  - 技能：看技能流程里触发积木的 unitScope 选项
   */
  function triggeringUnitForEffect(effect, owner, triggerUnit) {
    const cur = emitStack.length ? emitStack[emitStack.length - 1] : null;
    if (effect && effect.__member) {
      return effect.__member.block.unitScope === "target" && triggerUnit ? triggerUnit : owner;
    }
    if (effect) {
      const ev = cur ? cur.type : emitting ? emitting.type : null;
      const block = (effect.triggers || []).find((t) => t && (t.event === ev || (t.event === "always" && ev === "dataUpdate")));
      // 优先看该触发积木流程里的「自己指谁」选项，再看效果卡上的触发规则
      let scope = block && block.unitScope;
      if (block && effect.flows && effect.flows[block.id]) {
        const flow = effect.flows[block.id];
        const triggerNode = (flow.nodes || []).find((n) => n.type === "trigger");
        if (triggerNode && triggerNode.options && triggerNode.options.unitScope) scope = triggerNode.options.unitScope;
      }
      return scope === "target" && triggerUnit ? triggerUnit : owner;
    }
    return owner;
  }

  function playerChoose(cands, opts) {
    const list = cands && cands.length ? cands : null;
    if (!list) return [];
    if (typeof setup.chooseTargets !== "function") return [list[0]];
    const picked = setup.chooseTargets({
      candidates: list.map((u) => publicUnit(u)),
      multiple: opts.multiple !== false,
      battle: publicBattle(),
    });
    if (!picked) return [];
    return (Array.isArray(picked) ? picked : [picked]).map((p) => getUnit(p)).filter(Boolean);
  }

  function unitDataOf(u, field, opts = {}) {
    if (!u) return field === "name" || field === "label" || field === "id" ? "" : 0;
    switch (field) {
      case "atk": return statsOf(u).atk;
      case "hp": return u.hp;
      case "hpMax": return statsOf(u).hp;
      case "lastAttackDamage": return u.stats.lastAttackDamage || 0;
      case "lastAttackHits": return u.stats.lastAttackHits || 0;
      case "lastHeal": return u.stats.lastHeal || 0;
      case "lastLose": return u.stats.lastLose || 0;
      case "lastHpChange": return u.stats.lastHpChange || 0;
      case "lastAttackTarget": {
        const t = (u.stats.lastAttackTargets || [])[0];
        return t ? getUnit(t) : null;
      }
      case "lastHitSource": return u.stats.lastHitSource ? getUnit(u.stats.lastHitSource) : null;
      case "effectStacks": return typeof opts.effectId === "string" && opts.effectId ? effectStacks(u, opts.effectId) : 0;
      case "label": return displayLabel(u);
      case "name": return u.name;
      case "id": return u.cardId;
      default: return 0;
    }
  }

  /* ================= 伤害 ================= */
  function dealDamage(p) {
    const A = getUnit(p.attackerRef);
    const B = getUnit(p.targetRef);
    if (!A || !B) throw new Error("dealDamage 需要攻击方与目标");
    if (!isAlive(B)) return null;
    const attribute = p.attribute || "physical";
    if (!ATTRIBUTES.includes(attribute)) throw new Error(`无效伤害属性：${attribute}`);
    const isTrue = attribute === TRUE_DAMAGE_ATTRIBUTE;

    const aStats = statsOf(A, isTrue ? "origin" : "normal");
    const bStats = statsOf(B, isTrue ? "origin" : "normal");
    if (!isTrue) bStats.resistances = resistancesOf(B);

    const auto = p.value === undefined || p.value === null || p.value === "atk";
    const skillValue = isTrue ? (auto ? A.card.baseAtk : Number(p.value)) : auto ? aStats.atk : Number(p.value);

    const result = calculateDamage({
      attacker: aStats,
      target: bStats,
      skillValue,
      attribute,
      crit: p.crit,
      noCrit: p.noCrit || isTrue,
      rng,
      targetInvincible: isInvincible(B),
    });
    const rawFinal = Math.round(result.finalDamage * 1e9) / 1e9;

    // 结算前的「单位受击时」：效果可以给自己叠加免疫（本组伤害共同生效）
    immuneGroup = [];
    if (!isTrue) emit("attacked", [B]);
    // 受击效果可能把人打死或结束战斗：先回滚这次伤害的结算，避免对已离场的单位继续动手
    const aborted = state.status === "finished" || !isAlive(B);
    const group = immuneGroup;
    immuneGroup = [];
    if (aborted) {
      log(BATTLE_EVENT.DAMAGE, {
        attacker: A.uid,
        target: B.uid,
        skillId: p.skillId || null,
        cause: p.cause || "direct",
        ...result,
        finalDamage: 0,
        aborted: true,
        hpBefore: B.hp,
        hpAfter: B.hp,
        logged: !muted,
      });
      return null;
    }
    const immune = group.includes(B.key);
    const final = immune ? 0 : rawFinal;

    const hpBefore = B.hp;
    B.hp = Math.max(0, B.hp - final);
    const applied = hpBefore - B.hp;
    A.damageDealt += applied;
    B.damageTaken += applied;
    if (applied > 0) {
      B.stats.lastHitSource = A.key;
      B.stats.lastLose = applied;
      B.stats.lastHpChange = -applied;
    }

    const record = {
      attacker: A.uid,
      target: B.uid,
      skillId: p.skillId || null,
      cause: p.cause || "direct",
      ...result,
      finalDamage: final,
      immune,
      hpBefore,
      hpAfter: B.hp,
      logged: !muted,
    };
    log(BATTLE_EVENT.DAMAGE, record);
    if (immune) log(BATTLE_EVENT.IMMUNE, { unit: B.uid, by: A.uid, group: group.slice() });

    if (applied > 0) {
      log(BATTLE_EVENT.HP_LOST, { unit: B.uid, amount: applied, by: A.uid, hpBefore, hpAfter: B.hp });
      emit("loseHp", [B]);
      emit("dataUpdate", [B]);
    }

    if (B.hp <= 0) {
      // 致命伤害：效果有机会把自己救回来
      if (final > 0) emit("lethalDamage", [B]);
      if (B.hp <= 0) kill(B, A);
      else {
        record.saved = true;
        record.hpAfter = B.hp;
      }
    }
    return record;
  }

  function kill(u, by) {
    if (!isAlive(u)) return;
    u.state = UNIT_STATES[1];
    u.hp = 0;
    u.killedBy = by ? by.key : null;
    log(BATTLE_EVENT.DEATH, { unit: u.uid, by: by ? by.uid : null });
    exitUnit(u, EXIT_CAUSE.DEATH);
  }

  /** 退场（死亡 / 强制 / 父单位退场）：子单位一起退场 */
  function exitUnit(u, cause) {
    if (u.exited) return;
    u.exited = true;
    u.exitedCause = cause;
    if (cause !== EXIT_CAUSE.DEATH && cause !== EXIT_CAUSE.PARENT) {
      log(BATTLE_EVENT.EXIT, { unit: u.uid, cause });
    }
    const children = livingUnits().filter((c) => c.parentKey === u.key);
    for (const c of children) {
      c.state = UNIT_STATES[2];
      c.hp = 0;
      exitUnit(c, EXIT_CAUSE.PARENT);
    }
    emit("unitExit", [u]);
    checkEnd();
  }

  function forceExit(u, extra = {}) {
    if (!isAlive(u)) return false;
    u.state = UNIT_STATES[2];
    u.hp = 0;
    log(BATTLE_EVENT.EXIT, { unit: u.uid, cause: EXIT_CAUSE.FORCE, by: extra.source ? extra.source.uid : null });
    exitUnit(u, EXIT_CAUSE.FORCE);
    return true;
  }

  function heal(target, amount, cause = "direct") {
    const u = getUnit(target);
    if (!isAlive(u)) return 0;
    const before = u.hp;
    u.hp = Math.min(statsOf(u).hp, u.hp + Math.max(0, Number(amount) || 0));
    const delta = u.hp - before;
    if (delta > 0) {
      u.stats.lastHeal = delta;
      u.stats.lastHpChange = delta;
      log(BATTLE_EVENT.HEAL, { unit: u.uid, amount: delta, hpBefore: before, hpAfter: u.hp, cause });
      emit("heal", [u]);
      emit("dataUpdate", [u]);
    }
    return delta;
  }

  function setHp(target, value, cause = "direct") {
    const u = getUnit(target);
    if (!isAlive(u)) return 0;
    const before = u.hp;
    u.hp = Math.max(0, Math.min(statsOf(u).hp, Number(value) || 0));
    const delta = u.hp - before;
    if (delta > 0) {
      u.stats.lastHeal = delta;
      log(BATTLE_EVENT.HEAL, { unit: u.uid, amount: delta, hpBefore: before, hpAfter: u.hp, cause });
      emit("heal", [u]);
    } else if (delta < 0) {
      u.stats.lastLose = -delta;
      u.stats.lastHpChange = delta;
      log(BATTLE_EVENT.HP_LOST, { unit: u.uid, amount: -delta, hpBefore: before, hpAfter: u.hp, cause });
      emit("loseHp", [u]);
    }
    emit("dataUpdate", [u]);
    if (u.hp <= 0) kill(u, null);
    return delta;
  }

  /* ================= 召唤 ================= */
  function freeSlotFor(side) {
    for (let s = 1; s <= state.slotsPerSide; s += 1) {
      const used = state.units.some((u) => isAlive(u) && u.side === side && u.occupiesSlot && Math.abs(u.slot) === s);
      if (!used) return side === "ally" ? s : -s;
    }
    return null;
  }

  /**
   * 在某一侧生成 1 个单位（入场流程走 summon 事件）。
   * @returns {object|null} 生成失败（未知卡 / 超出上限 / 没有空格）返回 null
   */
  function spawnCard({ unitId, side, label, parent, ignoreLimit = false, markActed = false, cause = "summon" }) {
    const card = registry.getUnit(unitId);
    if (!card) {
      log(BATTLE_EVENT.FLOW_ERROR, { reason: `未知单位卡：${unitId}` });
      return null;
    }
    if (!ignoreLimit && livingOf(side).filter((u) => u.countsAsUnit).length >= state.summonLimit) return null;
    const slot = freeSlotFor(side);
    if (slot === null) return null;
    const uid = `s${++summonSeq}`;
    const unit = makeUnit(uid, card, side, slot, undefined, label || card.label);
    unit.parentKey = parent ? parent.key : null;
    if (parent) {
      for (const attr of Object.keys(parent.attrBonus)) unit.attrBonus[attr] = { ...parent.attrBonus[attr] };
      for (const layer of parent.effects) {
        unit.effects.push({ id: layer.id, stacks: layer.stacks, inheritedFrom: { source: parent.key, effectId: layer.id } });
      }
      recomputeAttrBonuses(unit);
    }
    state.units.push(unit);
    // side 模式：回合中途召唤出来的单位本回合不再行动
    if (sideMode && markActed && !state.acted.includes(unit.uid)) state.acted.push(unit.uid);
    log(BATTLE_EVENT.SUMMON, {
      unit: uid,
      cardId: unitId,
      side,
      slot,
      parent: unit.parentKey,
      label: unit.label,
      cause,
    });
    return unit;
  }

  function summonUnits({ unitId, count, label, ignoreLimit, parent, owner, side: explicitSide, markActed }) {
    if (!registry.getUnit(unitId)) throw new Error(`未知单位卡：${unitId}`);
    const side = explicitSide || (parent ? parent.side : owner ? owner.side : "enemy");
    const spawned = [];
    const acted = markActed === undefined ? sideMode && !state.deploying : Boolean(markActed);
    for (let i = 0; i < count; i += 1) {
      const unit = spawnCard({
        unitId,
        side,
        label,
        parent,
        ignoreLimit,
        markActed: acted,
        cause: parent ? "summon-child" : "summon",
      });
      if (!unit) break;
      spawned.push(unit);
    }
    for (const unit of spawned) emit("unitEnter", [unit]);
    return spawned.length;
  }

  /** 回合开始：按牌组顺序把单位补到「场上最多单位数」 */
  function deployFromDeck(side) {
    const deck = state.decks[side] || [];
    if (!deck.length) return 0;
    const spawned = [];
    while (deck.length) {
      const cardId = deck.shift();
      if (!registry.getUnit(cardId)) {
        log(BATTLE_EVENT.FLOW_ERROR, { reason: `牌组里有未知单位卡：${cardId}`, side });
        continue;
      }
      const unit = spawnCard({ unitId: cardId, side, markActed: false, cause: "deploy" });
      if (!unit) {
        deck.unshift(cardId);
        break;
      }
      spawned.push(unit);
    }
    for (const unit of spawned) emit("unitEnter", [unit]);
    return spawned.length;
  }

  /* ================= 行动顺序 ================= */
  function actionOrder() {
    return livingUnits()
      .slice()
      .sort((a, b) => statsOf(b).speed - statsOf(a).speed || Math.abs(a.slot) - Math.abs(b.slot) || (a.uid < b.uid ? -1 : 1));
  }

  function checkEnd() {
    if (state.status !== "running") return true;
    const allies = livingOf("ally").filter((u) => u.countsAsUnit);
    const enemies = livingOf("enemy").filter((u) => u.countsAsUnit);
    // side 模式：牌组里还有单位 = 还没输，下回合会补上场
    const deckLeft = (side) => (state.decks[side] || []).length;
    const allyOut = allies.length === 0 && (!sideMode || deckLeft("ally") === 0);
    const enemyOut = enemies.length === 0 && (!sideMode || deckLeft("enemy") === 0);
    const finish = (reason, winner) => {
      state.status = "finished";
      state.endReason = reason;
      state.winner = winner;
      state.phase = BATTLE_PHASE.FINISHED;
      log(BATTLE_EVENT.BATTLE_END, { reason, winner });
      return true;
    };
    if (allyOut && enemyOut) return finish(BATTLE_END_REASON.DRAW, null);
    if (enemyOut) return finish(BATTLE_END_REASON.ENEMY_DEFEATED, "ally");
    if (allyOut) return finish(BATTLE_END_REASON.ALLY_DEFEATED, "enemy");
    return false;
  }

  function active() {
    const u = getUnit(state.activeId);
    return isAlive(u) ? u : null;
  }

  function finishAction(A) {
    if (A && isAlive(A)) {
      emit("unitTurnEnd", [A]);
      for (const buff of A.buffs) if (buff.duration !== null) buff.duration -= 1;
      const expired = A.buffs.filter(buffExpired);
      if (expired.length) {
        A.buffs = A.buffs.filter((b) => !expired.includes(b));
        log(BATTLE_EVENT.BUFF_EXPIRED, { unit: A.uid, buffs: expired.map((b) => b.uid) });
      }
    }
    log(BATTLE_EVENT.TURN_END, { activeId: A ? A.uid : null, actionSeq: state.actionSeq });
    return advance(A);
  }

  function advance(previous) {
    if (checkEnd()) return api;
    // 「跳过行动」只对当前行动单位生效：若被跳过，则直接连到下一个
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 1000) throw new Error("行动推进出现死循环");
      const order = actionOrder();
      if (!order.length) return api;
      let next;
      if (previous) {
        const idx = order.findIndex((u) => u.uid === previous.uid);
        next = order[idx >= 0 ? (idx + 1) % order.length : 0];
        if (idx >= 0 && idx + 1 >= order.length) {
          // 一轮结束
          state.cycle += 1;
          if (state.cycle >= state.maxCycles) {
            state.status = "finished";
            state.endReason = BATTLE_END_REASON.MAX_CYCLES;
            log(BATTLE_EVENT.BATTLE_END, { reason: state.endReason, winner: null });
            return api;
          }
          // 回合开始/结束：事件对象是「行动顺序最靠前的单位」，供触发积木的「自己指谁」取用
          const leader = livingUnits()
            .slice()
            .sort((x, y) => statsOf(y).speed - statsOf(x).speed || (x.uid < y.uid ? -1 : 1))[0];
          emit("turnEnd", leader ? [leader] : []);
          state.turn += 1;
          emit("turnStart", leader ? [leader] : []);
          if (state.status === "finished") return api;
          const order2 = actionOrder();
          if (!order2.length) return api;
          next = order2[0];
        }
      } else {
        next = order[0];
      }
      state.actionSeq += 1;
      state.activeId = next.uid;
      previous = null;
      log(BATTLE_EVENT.TURN_START, { activeId: state.activeId });
      emit("unitTurnStart", [next]);
      if (state.status === "finished") return api;
      if (state.skippedThisTurn.includes(next.uid)) {
        log(BATTLE_EVENT.ACTION_SKIP, { activeId: next.uid });
        log(BATTLE_EVENT.TURN_END, { activeId: next.uid, actionSeq: state.actionSeq, skipped: true });
        previous = next;
        continue;
      }
      log(BATTLE_EVENT.ACTION_START, { activeId: next.uid });
      return api;
    }
  }

  /* ================= side 模式：回合 / 选人 / 交替行动 ================= */
  /** 某方是否还有「本回合没行动过」的存活单位 */
  function hasActable(side) {
    return livingOf(side).some((u) => !state.acted.includes(u.uid));
  }

  /** 行动顺序最靠前的存活单位（回合开始/结束事件的对象） */
  function sideLeader() {
    return actionOrder()[0] || null;
  }

  /**
   * 回合结束 → 下一回合：
   *   回合结束效果 → 回合数 +1 → 双方入场新单位 → 回合开始效果
   */
  function endRound() {
    const leader = sideLeader();
    log(BATTLE_EVENT.ROUND_END, { turn: state.turn });
    emit("turnEnd", leader ? [leader] : []);
    if (state.status !== "running") return;
    state.turn += 1;
    if (state.turn > state.maxCycles) {
      state.status = "finished";
      state.endReason = BATTLE_END_REASON.MAX_CYCLES;
      state.winner = null;
      state.phase = BATTLE_PHASE.FINISHED;
      log(BATTLE_EVENT.BATTLE_END, { reason: state.endReason, winner: null });
      return;
    }
    state.acted = [];
    state.activeId = null;
    state.deploying = true;
    deployFromDeck("ally");
    deployFromDeck("enemy");
    state.deploying = false;
    if (state.status !== "running") return;
    const leader2 = sideLeader();
    log(BATTLE_EVENT.ROUND_START, { turn: state.turn });
    emit("turnStart", leader2 ? [leader2] : []);
  }

  /**
   * 推进到下一个「等待选人」状态：
   * 默认与上一行动方交替；若对方没有可行动单位，则本方继续；双方都没有 → 回合结束。
   */
  function advanceSide(previous) {
    if (state.status !== "running") return api;
    if (checkEnd()) return api;
    let side = previous ? otherSide(previous.side) : state.firstSide;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 1000) throw new Error("行动推进出现死循环");
      if (!hasActable(side)) {
        const other = otherSide(side);
        if (hasActable(other)) {
          side = other;
        } else {
          endRound();
          if (state.status !== "running") return api;
          if (checkEnd()) return api;
          side = state.firstSide;
          if (!hasActable(side)) side = otherSide(side);
          if (!hasActable(side)) {
            // 双方都没有可行动单位（理论上 checkEnd 已处理），避免卡死
            return api;
          }
        }
      }
      state.sideTurn = side;
      state.activeId = null;
      state.phase = BATTLE_PHASE.SELECT;
      log(BATTLE_EVENT.SIDE_TURN, { side });
      return api;
    }
  }

  /**
   * 选择本回合要行动的单位（side 模式）。
   * @param {string} unitRef uid / key
   * @returns {boolean} 是否选上
   */
  function selectUnit(unitRef) {
    if (!sideMode || state.status !== "running" || state.phase !== BATTLE_PHASE.SELECT) return false;
    const u = getUnit(unitRef);
    if (!isAlive(u) || u.side !== state.sideTurn || state.acted.includes(u.uid)) return false;
    state.activeId = u.uid;
    state.phase = BATTLE_PHASE.ACT;
    state.actionSeq += 1;
    log(BATTLE_EVENT.TURN_START, { activeId: u.uid });
    emit("unitTurnStart", [u]);
    if (state.status !== "running") return false;
    if (!isAlive(u)) {
      // 行动开始效果把人打死了：这个单位的行动直接结束
      endSideAction();
      return false;
    }
    log(BATTLE_EVENT.ACTION_START, { activeId: u.uid });
    return true;
  }

  /** side 模式：当前单位行动结束（没死也要收尾） */
  function endSideAction() {
    if (state.status !== "running") return api;
    const uid = state.activeId;
    const A = uid ? getUnit(uid) : null;
    state.activeId = null;
    state.phase = BATTLE_PHASE.SELECT;
    if (A && isAlive(A)) {
      emit("unitTurnEnd", [A]);
      for (const buff of A.buffs) if (buff.duration !== null) buff.duration -= 1;
      const expired = A.buffs.filter(buffExpired);
      if (expired.length) {
        A.buffs = A.buffs.filter((b) => !expired.includes(b));
        log(BATTLE_EVENT.BUFF_EXPIRED, { unit: A.uid, buffs: expired.map((b) => b.uid) });
      }
    }
    if (A && !state.acted.includes(A.uid)) state.acted.push(A.uid);
    log(BATTLE_EVENT.TURN_END, { activeId: A ? A.uid : null, actionSeq: state.actionSeq });
    if (state.status !== "running") return api;
    return advanceSide(A);
  }

  /* ================= 技能 ================= */
  function allSkillsOf(u) {
    const extra = u.granted.map((g) => registry.getSkill(g.skillId)).filter(Boolean);
    return [...u.skills, ...extra];
  }

  function useSkill(index, opts = {}) {
    if (state.status !== "running") return null;
    const A = active();
    if (!A) throw new Error("没有可行动的单位");
    const skill = allSkillsOf(A)[index];
    if (!skill) throw new Error(`${A.name} 没有第 ${index} 个技能`);
    if (skill.type !== "active") throw new Error(`${skill.name} 是被动技能，不能主动使用`);

    let primary = opts.targetRef ? getUnit(opts.targetRef) : null;
    if (primary && !isAlive(primary)) return null;
    if (!primary && skill.requiresTarget) {
      primary = selectTarget(state.units, otherSide(A.side));
      if (!primary) return null;
    }

    log(BATTLE_EVENT.SKILL, {
      caster: A.uid,
      skillId: skill.id,
      skillName: skill.name,
      target: primary ? primary.uid : null,
    });

    // 当前目标：技能的目标单独放一个变量，因为执行时会被其他流程里的流程上下文盖住
    const prev = state.current;
    prevSkillTargets = primary ? [primary] : [];
    state.current = { ...prev, skillUnit: A, curTargets: prevSkillTargets };
    try {
      // 带上被施放的技能 id：「单位释放该技能」据此只响应本技能自己
      emit("skillCast", [A], { skillId: skill.id });
      if (state.status === "finished") return skill;

      if (skill.format === "flow" && skill.flow) {
        // 技能流程：由施放者为主体执行
        const prepared = prepareFlow(skill.flow);
        if (!prepared.ok) {
          log(BATTLE_EVENT.FLOW_ERROR, { owner: A.uid, skillId: skill.id, errors: prepared.errors });
          return skill;
        }
        // 技能流程：触发积木的「自己」默认指施放者，可选「触发的单位」
        const triggerNode = [...prepared.nodes.values()].find((n) => n.type === "trigger");
        const scope = triggerNode ? triggerNode.options.unitScope : "self";
        const env = flowEnv(A, null);
        if (scope === "target") {
          const cur = prevSkillTargets[0];
          if (cur) env.self = cur;
        }
        // 没有指定目标时，技能默认把最近的敌方单位作为「当前目标」（与数据式技能一致）
        if (!prevSkillTargets.length) {
          const autoTarget = selectTarget(state.units, otherSide(A.side));
          if (autoTarget) prevSkillTargets = [autoTarget];
        }
        try {
          runFlow(prepared, env);
        } catch (err) {
          log(BATTLE_EVENT.FLOW_ERROR, { owner: A.uid, skillId: skill.id, reason: String((err && err.message) || err) });
        }
        return skill;
      }

      // 数据式技能（旧接口，保持兼容）
      const value = skill.valueSource === "atk" ? "atk" : skill.valueSource;
      const hitTargets = [];
      let attackDamage = 0;
      for (const eff of normalizeEffects(skill)) {
        if (eff.kind === "damage") {
          const targets = eff.target === "self"
            ? [A]
            : primary
              ? [primary]
              : [selectTarget(state.units, otherSide(A.side), { ignoreDistance: true })].filter(Boolean);
          for (const B of targets) {
            if (!isAlive(B)) continue;
            const attr = eff.attribute || "physical";
            const rec = dealDamage({
              attackerRef: A,
              targetRef: B,
              value,
              attribute: attr,
              skillId: skill.id,
              cause: "skill",
            });
            if (rec) attackDamage += rec.finalDamage;
            hitTargets.push(B);
          }
          if (state.status !== "running") break;
        } else if (eff.kind === "buff") {
          const target = eff.target === "enemy" ? primary : A;
          if (!target) throw new Error("buff 效果需要目标");
          if (!isAlive(target)) continue;
          const desc = structuredClone(eff.buff || {});
          if (desc.def) {
            for (const key of Object.keys(desc.def)) {
              if (desc.def[key] === "ATTACKER") desc.def[key] = statsOf(A).atk;
            }
          }
          applyBuff(target, desc);
        } else if (eff.kind === "dispel") {
          const target = eff.target === "enemy" ? primary : A;
          if (target) dispel(target, eff.tags || []);
        }
      }
      if (hitTargets.length) {
        A.stats.lastAttackDamage = attackDamage;
        A.stats.lastAttackTargets = hitTargets.map((t) => t.key);
        A.stats.lastAttackHits = hitTargets.length;
        log(BATTLE_EVENT.ATTACK, { attacker: A.uid, hits: hitTargets.length, targets: hitTargets.map((t) => t.uid), skillId: skill.id });
        emit("attack", [A]);
      }
      return skill;
    } finally {
      state.current = prev;
    }
  }

  function applyBuff(unitRef, desc) {
    const u = getUnit(unitRef);
    if (!isAlive(u)) return null;
    const buff = createBuff({ ...desc, sourceId: desc.sourceId ?? state.activeId });
    u.buffs.push(buff);
    log(BATTLE_EVENT.BUFF_ADDED, { unit: u.uid, buff: structuredClone(buff) });
    return buff;
  }

  function dispel(unitRef, tags) {
    const u = getUnit(unitRef);
    if (!isAlive(u)) return 0;
    const list = Array.isArray(tags) ? tags : [tags];
    const removed = u.buffs.filter((b) => list.some((t) => hasTag(b, t)));
    u.buffs = u.buffs.filter((b) => !removed.includes(b));
    if (removed.length) log(BATTLE_EVENT.BUFF_REMOVED, { unit: u.uid, tags: list, removed: removed.map((b) => b.uid) });
    return removed.length;
  }

  /* ================= 对外数据 ================= */
  function publicUnit(u) {
    if (!u) return null;
    const s = statsOf(u);
    return {
      uid: u.uid,
      key: u.key,
      cardId: u.cardId,
      name: u.name,
      side: u.side,
      slot: u.slot,
      hp: u.hp,
      hpMax: s.hp,
      atk: s.atk,
      def: s.def,
      label: displayLabel(u),
      state: u.state,
      countsAsUnit: u.countsAsUnit,
      occupiesSlot: u.occupiesSlot,
      invincible: isInvincible(u),
      parentKey: u.parentKey,
      /** side 模式：这个单位本回合是否已经行动过 */
      acted: state.acted.includes(u.uid),
      effects: u.effects.map((e) => ({ id: e.id, stacks: e.stacks })),
      buffs: u.buffs.map((b) => ({ uid: b.uid, label: b.label, duration: b.duration })),
      skills: allSkillsOf(u).map((sk) => ({ id: sk.id, name: sk.name, type: sk.type })),
    };
  }

  function publicBattle() {
    return {
      id: state.id,
      mode: state.mode,
      status: state.status,
      phase: state.phase,
      endReason: state.endReason,
      winner: state.winner,
      turn: state.turn,
      cycle: state.cycle,
      actionSeq: state.actionSeq,
      activeId: state.activeId,
      sideTurn: state.sideTurn,
      firstSide: state.firstSide,
      maxUnits: state.maxUnits,
      acted: state.acted.slice(),
      invincibleSides: state.invincibleSides.slice(),
      decks: { ally: (state.decks.ally || []).length, enemy: (state.decks.enemy || []).length },
      units: state.units.filter((u) => u.state !== UNIT_STATES[2]).map(publicUnit),
    };
  }

  /* ================= 启动 ================= */
  function start() {
    if (sideMode) return startSide();
    state.turn = 1;
    state.actionSeq = 1;
    const order = actionOrder();
    state.activeId = order[0] ? order[0].uid : null;
    log(BATTLE_EVENT.BATTLE_START, {
      battleId: state.id,
      seed: state.seed,
      mode: state.mode,
      units: state.units.map((u) => ({ uid: u.uid, cardId: u.cardId, side: u.side, slot: u.slot })),
    });
    emit("turnStart", []);
    emit("unitEnter", livingUnits().slice());
    if (state.status === "finished") return api;
    log(BATTLE_EVENT.TURN_START, { activeId: state.activeId });
    const A = active();
    if (A) {
      emit("unitTurnStart", [A]);
      if (state.skippedThisTurn.includes(A.uid)) log(BATTLE_EVENT.ACTION_SKIP, { activeId: A.uid });
      else log(BATTLE_EVENT.ACTION_START, { activeId: A.uid });
    }
    return api;
  }

  /** side 模式启动：双方入场 → 回合开始效果 → 红方先选人 */
  function startSide() {
    state.turn = 1;
    state.actionSeq = 0;
    state.phase = BATTLE_PHASE.SELECT;
    state.sideTurn = state.firstSide;
    log(BATTLE_EVENT.BATTLE_START, {
      battleId: state.id,
      seed: state.seed,
      mode: state.mode,
      units: [],
      decks: { ally: state.decks.ally.slice(), enemy: state.decks.enemy.slice() },
      maxUnits: state.maxUnits,
      invincibleSides: state.invincibleSides.slice(),
    });
    state.deploying = true;
    deployFromDeck("ally");
    deployFromDeck("enemy");
    state.deploying = false;
    if (state.status !== "running") return api;
    log(BATTLE_EVENT.ROUND_START, { turn: 1 });
    emit("turnStart", []);
    if (state.status !== "running") return api;
    if (checkEnd()) return api;
    let side = state.firstSide;
    if (!hasActable(side)) side = otherSide(side);
    state.sideTurn = side;
    if (!hasActable(side)) return api;
    log(BATTLE_EVENT.SIDE_TURN, { side });
    return api;
  }

  function endTurn() {
    if (state.status !== "running") return api;
    if (sideMode) {
      lastEndedAction = getUnit(state.activeId);
      return endSideAction();
    }
    const A = active();
    if (!A) return api;
    lastEndedAction = A;
    state.skippedThisTurn = state.skippedThisTurn.filter((k) => k !== A.uid);
    return finishAction(A);
  }

  function withMuted(shouldMute, fn) {
    const prev = muted;
    if (shouldMute) muted = true;
    try {
      return fn();
    } finally {
      muted = prev;
    }
  }

  const api = {
    state,
    getUnit,
    active,
    statsOf,
    order: actionOrder,
    useSkill,
    endTurn,
    /** side 模式：选择本回合要行动的单位 */
    selectUnit,
    /** side 模式：当前方还有没有没行动的单位 */
    hasActable,
    /** 当前模式（speed / side） */
    mode: state.mode,
    allSkillsOf,
    isAlive,
    isInvincible,
    effectStacks,
    publicUnit,
    publicBattle,
    hpCap(unitRef) {
      const u = getUnit(unitRef);
      return u ? statsOf(u).hp : 0;
    },
    get lastEndedAction() {
      return lastEndedAction;
    },

    /* 外部脚本 / 场景效果入口：默认不写事件日志，保证「存档 + 操作序列重放」只依赖玩家的 useSkill / endTurn。
       需要记录时传 { log: true }。 */
    dealDamage(params, { log: shouldLog = false } = {}) {
      return withMuted(!shouldLog, () => dealDamage(params));
    },
    applyBuff(unitRef, desc, { log: shouldLog = false } = {}) {
      return withMuted(!shouldLog, () => applyBuff(unitRef, desc));
    },
    dispel(unitRef, tags, { log: shouldLog = false } = {}) {
      return withMuted(!shouldLog, () => dispel(unitRef, tags));
    },
    heal(unitRef, amount, { log: shouldLog = false } = {}) {
      return withMuted(!shouldLog, () => heal(unitRef, amount));
    },
    attachEffect(unitRef, effectId, { log: shouldLog = false } = {}) {
      return withMuted(!shouldLog, () => attachEffect(getUnit(unitRef), effectId, {}));
    },
    forceExit(unitRef, { log: shouldLog = false } = {}) {
      return withMuted(!shouldLog, () => forceExit(getUnit(unitRef)));
    },
    removeEffect(unitRef, effectId, { force = false, layers = Infinity, log: shouldLog = false } = {}) {
      return withMuted(!shouldLog, () => removeEffectByMode(getUnit(unitRef), { mode: "specified", effectId, layers, force }));
    },
    summon(opts, { log: shouldLog = false } = {}) {
      return withMuted(!shouldLog, () => summonUnits({ count: 1, label: "", ignoreLimit: false, parent: null, owner: null, ...opts }));
    },
  };

  void pendingPick;
  start();
  return api;
}
