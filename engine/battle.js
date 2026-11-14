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
  effectAttrBonusTarget,
  effectPolarityOf,
  normalizeInvincible,
  normalizeUnselectable,
} from "./constants.js";
import { createRng } from "./math.js";
import { addBonus, emptyAccum } from "./modifiers.js";
import { computeStats } from "./stats.js";
import { calculateDamage } from "./damage.js";
import { normalizeEffects } from "./skills.js";
import { canSelectUnit } from "./units.js";
import { buffToBonus, buffExpired, createBuff, hasTag, resetBuffSequence } from "./buffs.js";
import { canPlace, normalizeSlot, otherSide, selectTarget, sideOf, DEFAULT_SLOTS } from "./targeting.js";
import { prepareFlow, runFlow } from "./flow.js";
import { isMultiTargetTriggerEvent } from "./flow-catalog.js";

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
  ACTION_POINTS: "action:points",
  SKILL: "skill",
  ATTACK: "attack",
  /** 「转移攻击」把这次伤害从原目标改到了另一个单位 */
  ATTACK_TRANSFERRED: "attack:transferred",
  DAMAGE: "damage",
  IMMUNE: "immune",
  EFFECT_IMMUNE: "effect:immune",
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
  /** 退场被无敌档位拦下（超级无敌拒绝一切退场 / 无敌拒绝普通退场） */
  EXIT_BLOCKED: "exit:blocked",
  /** 「拒绝退场」把这次退场取消掉了（并回了血） */
  EXIT_REFUSED: "exit:refused",
  FLOW_ERROR: "flow:error",
  BATTLE_END: "battle:end",
  /** 同屏模式：抽牌 / 从手牌上场 / 补牌 / 需要布阵 */
  HAND_DRAW: "hand:draw",
  HAND_PLAY: "hand:play",
  REFILL: "refill",
  REFILL_DONE: "refill:done",
  DEPLOY_REQUIRED: "deploy:required",
  DEPLOY_DONE: "deploy:done",
});

/**
 * 战斗模式：
 *   speed —— 按速度排序，每个单位轮流行动（旧流程，默认）
 *   side  —— 训练场流程：每回合双方各自入场新单位 → 触发回合开始效果 →
 *            红方先手、双方交替选择有剩余可动次数的单位行动 → 回合结束效果 → 下一回合
 *   local —— 游玩 / 同屏：手牌 + 手动上场 + 定时补牌，从手牌部署单位
 */
export const BATTLE_MODE = Object.freeze({
  SPEED: "speed",
  SIDE: "side",
  LOCAL: "local",
});

/** side / local 模式的阶段 */
export const BATTLE_PHASE = Object.freeze({
  /** 等待当前方选择行动单位 */
  SELECT: "select",
  /** 已选中单位，等待使用技能 / 结束行动 */
  ACT: "act",
  /** 同屏模式：等待布阵 / 补上场 */
  DEPLOY: "deploy",
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
 * —— side 模式（训练场）/ local 模式（同屏）专用 ——
 * @param {"speed"|"side"|"local"} [setup.mode]
 * @param {{ally?: string[], enemy?: string[]}} [setup.decks] 双方牌组（单位卡 id，按入场顺序）
 * @param {number} [setup.maxUnits] 每侧场上最多单位数（默认取 summonLimit / slotsPerSide）
 * @param {"ally"|"enemy"} [setup.firstSide] 先手方（默认 ally = 红方）
 * @param {string[]} [setup.invincibleSides] 整方无敌（训练场「红方无敌 / 蓝方无敌」）
 *
 * —— local 模式（游玩 / 同屏）专用 ——
 * @param {number} [setup.initialHand] 初始抽牌数（默认 8）
 * @param {boolean} [setup.refillEnabled] 是否补牌（默认 true）
 * @param {number} [setup.refillEvery] 补牌间隔回合（默认 3）
 * @param {number} [setup.refillCount] 每次补牌数（默认 2）
 * @param {boolean} [setup.allowSameName] 是否允许同名角色（默认 true）
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
    initialHand = 8,
    refillEnabled = true,
    refillEvery = 3,
    refillCount = 2,
    allowSameName = true,
  } = setup || {};

  if (!registry) throw new Error("createBattle 需要 registry");
  if (!Object.values(BATTLE_MODE).includes(mode)) throw new Error(`无效战斗模式：${mode}`);

  const localMode = mode === BATTLE_MODE.LOCAL;
  const sideMode = mode === BATTLE_MODE.SIDE || localMode;
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
  /** 广播队列：流程（含嵌套流程）结束后统一发出，避免广播互相嵌套递归 */
  let pendingBroadcasts = [];
  /** 当前流程执行嵌套深度：只有最外层流程结束时才发送广播 */
  let flowDepth = 0;
  let flushingBroadcasts = false;
  /** 一次广播批次的最大发送数，防止「广播 → 再广播」死循环 */
  const MAX_BROADCASTS = 1000;
  /** 退场处理嵌套深度：所有退场触发跑完后再做一次战斗结算 */
  let exitDepth = 0;
  let summonSeq = 0;
  let lastEndedAction = null;
  let pendingPick = null;
  let immuneGroup = [];
  /**
   * 「攻击动作」批次：一次「攻击」积木对多个目标结算时共用同一个批次 id。
   * 表现层据此把同一次群攻的命中动画同时播放；循环里的每轮攻击是新批次。
   */
  let attackGroupSeq = 0;
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
    /** 战斗模式：speed / side / local */
    mode,
    /** side / local 模式：select / act / deploy / finished；speed 模式恒为 act */
    phase: localMode ? BATTLE_PHASE.DEPLOY : sideMode ? BATTLE_PHASE.SELECT : BATTLE_PHASE.ACT,
    /** side 模式：当前轮到哪一方选单位 */
    sideTurn: first,
    firstSide: first,
    /** side 模式：本回合已经触发过「单位行动开始时」的单位 uid（换人时不重复触发） */
    started: [],
    /** side 模式：当前行动单位是否已经使用过技能（用于禁止用过技能后再换单位） */
    actionUsed: false,
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
    /** local 模式：手牌（单位卡 id，可重复） */
    hand: localMode ? { ally: [], enemy: [] } : { ally: [], enemy: [] },
    /** local 模式：初始抽牌 / 补牌设置 */
    local: localMode
      ? {
          initialHand: Math.max(0, Math.floor(Number(initialHand) || 0)),
          refillEnabled: Boolean(refillEnabled),
          refillEvery: Math.max(1, Math.floor(Number(refillEvery) || 1)),
          refillCount: Math.max(0, Math.floor(Number(refillCount) || 0)),
          allowSameName: Boolean(allowSameName),
        }
      : null,
    /** local 模式：当前需要布阵 / 补上场的一方（null = 战斗正常进行） */
    localDeploy: localMode ? { initial: true, side: first, previousUid: null } : null,
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
    const unit = makeUnit(uid, card, side, slot, spec.hp, spec.label);
    // 预留多阵营：单位可以单独指定阵营，缺省跟 side 一致
    if (spec.faction !== undefined && spec.faction !== null && String(spec.faction) !== "") {
      unit.faction = String(spec.faction);
    }
    state.units.push(unit);
  });

  function makeUnit(uid, card, side, slot, hp, label) {
    const skills = card.skills.map((sid) => {
      const s = registry.getSkill(sid);
      if (!s) throw new Error(`单位 ${card.id} 引用了不存在的技能 ${sid}`);
      return structuredClone(s);
    });
    const startHp = hp === undefined || hp === null ? card.baseHp : hp;
    const perTurn = Number.isFinite(Number(card.actionsPerTurn))
      ? Math.max(0, Math.min(99, Math.floor(Number(card.actionsPerTurn))))
      : 1;
    return {
      uid,
      key: uid,
      card: structuredClone(card),
      cardId: card.id,
      name: card.name || card.id,
      side,
      /**
       * 阵营：目前默认等于 side，但「单位所属的阵营」只认这个字段。
       * 以后要做多阵营时，给单位指定不同的 faction 即可，卡包不用重写；
       * 战斗的先后手 / 站位仍按 side（两阵营）。
       */
      faction: side,
      slot,
      occupiesSlot: card.occupiesSlot,
      countsAsUnit: card.countsAsUnit,
      /** 选中限制：none / enemy / ally / all */
      unselectable: normalizeUnselectable(card.unselectable),
      immuneNegative: Boolean(card.immuneNegative),
      immuneControl: Boolean(card.immuneControl),
      invincible: card.invincible,
      rarity: card.quality,
      /** 标签：一个单位一个（召唤时可覆盖） */
      label: label !== undefined && label !== null ? String(label) : card.label,
      skills,
      /** 每回合默认可行动次数；回合开始时 actionsLeft 重置到这个值 */
      actionsPerTurn: perTurn,
      /** 本回合剩余可动次数；角色不再用「是否已行动」的布尔值 */
      actionsLeft: perTurn,
      /** 本场对局每个技能的已使用次数：{ [skillId]: { round, turn, total } } */
      skillUses: {},
      buffs: [],
      /** 效果层栈：[{ id, stacks }]，按首次附加顺序 */
      effects: [],
      /** 效果属性修正层：{ mods: { atkPct… }, resistances: { physical… } } */
      attrBonus: { mods: {}, resistances: {} },
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
        lastHealSource: null,
        lastLose: 0,
        lastHpChange: 0,
        lastHitDamage: 0,
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
  /** 单位卡上的无敌档位：none / damage（免伤）/ invincible（无敌）/ super（超级无敌） */
  const invincibleLevelOf = (u) => normalizeInvincible(u ? u.invincible : "none");
  /** 伤害免疫：免伤 / 无敌 / 超级无敌都记 0 伤害（整方无敌的训练场开关同样记 0） */
  const isInvincible = (u) =>
    Boolean(u) && (invincibleLevelOf(u) !== "none" || state.invincibleSides.includes(u.side));
  const livingUnits = () => state.units.filter(isAlive);
  const livingOf = (side) => livingUnits().filter((u) => u.side === side);
  /**
   * 「目标集」：某侧所有当前选择者能选中的存活单位。
   * 计数只影响「阵营单位数量上限」，不再影响目标集；选中限制按 fromSide 判断。
   */
  const listSide = (side, opts = {}) => livingOf(side).filter((u) => canSelectUnit(u, opts.fromSide));
  /** 单位所属阵营：没写 faction 的旧数据回落到 side */
  const factionOf = (u) => {
    if (!u) return null;
    const f = u.faction;
    return f === undefined || f === null || f === "" ? u.side : String(f);
  };
  /** 某阵营的存活单位；默认包含不计数单位（不计数只影响数量上限） */
  const listFaction = (faction, opts = {}) => {
    if (!faction) return [];
    const includeUncounted = opts.includeUncounted !== false;
    return livingUnits().filter((u) => factionOf(u) === faction && (includeUncounted || u.countsAsUnit));
  };
  /** 场上全部存活单位；默认包含不计数单位 */
  const listAllUnits = (opts = {}) => {
    const countedOnly = opts.countedOnly === true;
    return livingUnits().filter((u) => !countedOnly || u.countsAsUnit);
  };
  const displayLabel = (u) => (u && u.label !== undefined && u.label !== null ? String(u.label) : "");

  /* ================= 行动次数 ================= */
  /** 回合开始：把所有存活单位的剩余可动次数重置为「每回合默认可动次数」 */
  function resetActions() {
    for (const u of livingUnits()) {
      u.actionsLeft = Math.max(0, Math.floor(Number(u.actionsPerTurn) || 0));
    }
  }
  const canAct = (u) => Boolean(u) && isAlive(u) && (Number(u.actionsLeft) || 0) > 0;
  function spendAction(u, n = 1) {
    if (!u) return 0;
    const before = Math.max(0, Number(u.actionsLeft) || 0);
    u.actionsLeft = Math.max(0, before - Math.max(0, Math.floor(n) || 0));
    return before - u.actionsLeft;
  }
  /** 「额外行动」积木：增加 / 扣减本回合剩余可动次数（负值扣减） */
  function addActions(unitRef, amount) {
    const u = getUnit(unitRef);
    if (!u || !isAlive(u)) return null;
    const n = Math.trunc(Number(amount) || 0);
    if (!n) return u;
    u.actionsLeft = Math.max(0, Math.min(99, (Number(u.actionsLeft) || 0) + n));
    log(BATTLE_EVENT.ACTION_POINTS, {
      unit: u.uid,
      delta: n,
      actionsLeft: u.actionsLeft,
    });
    return u;
  }

  /** 作用范围为 ally / enemy / all 的效果属性修正（光环层），unitKey -> { mods, resistances } */
  let auraBonus = new Map();

  function statsOf(unit, scope = "normal") {
    if (!unit) return null;
    const card = unit.card;
    if (scope === "origin") return computeStats(card, emptyAccum());
    const acc = emptyAccum();
    for (const b of unit.permanentBonuses) addBonus(acc, b);
    for (const b of unit.extraBonuses) addBonus(acc, b);
    for (const buff of unit.buffs) addBonus(acc, buffToBonus(buff));
    // 效果属性修正：直接进加成累加器，与常驻加成同一套叠算顺序
    const layer = unit.attrBonus || {};
    if (layer.mods) addBonus(acc, layer.mods);
    // 作用范围为 ally / enemy / all 的属性修正（来自场上持有者）
    const aura = auraBonus.get(unit.key);
    if (aura && aura.mods) addBonus(acc, aura.mods);
    return computeStats(card, acc);
  }

  function resistancesOf(u) {
    const s = statsOf(u);
    const out = { ...s.resistances };
    const own = u.attrBonus || {};
    const aura = auraBonus.get(u.key) || {};
    for (const attr of RESISTANCE_ATTRIBUTES) {
      const add = (own.resistances ? own.resistances[attr] : 0) + (aura.resistances ? aura.resistances[attr] : 0);
      if (add) out[attr] = (out[attr] || 0) + add;
    }
    return out;
  }

  /* ================= 效果层栈 ================= */
  const effectStacks = (u, eid) => {
    const e = u.effects.find((x) => x.id === eid);
    return e ? e.stacks : 0;
  };
  const effectFlag = (eid, flag) => {
    const def = registry.getEffect(eid);
    return Boolean(def && Array.isArray(def.flags) && def.flags.includes(flag));
  };
  /** 效果倾向：正面 / 负面 / 特殊（「特殊」两类移除都不算） */
  const effectPolarity = (eid) => effectPolarityOf(registry.getEffect(eid));

  /** 把一条属性修正累加进 { mods, resistances } 层；value 已经乘过层数 */
  function applyAttrBonusEntry(layer, target, value) {
    if (!layer || !target || !value) return;
    if (target.resistance) {
      layer.resistances[target.resistance] = (layer.resistances[target.resistance] || 0) + value;
      return;
    }
    // 四系伤害提升 / 穿透是嵌套对象（按「键.系」存放），其余键直接累加
    const [key, element] = target.mod.split(".");
    if (element) {
      const group = layer.mods[key] && typeof layer.mods[key] === "object" ? layer.mods[key] : (layer.mods[key] = {});
      group[element] = (group[element] || 0) + value;
    } else {
      layer.mods[target.mod] = (layer.mods[target.mod] || 0) + value;
    }
  }

  /**
   * 按当前效果层重算「自己」属性修正层。
   * scope=self 的条目才进这里；ally / enemy / all 走 recomputeAuraBonuses。
   * 每层效果的 attrBonus 数值 × 层数（perStack=false 时只算一次），三系抗性单独累计。
   */
  function recomputeAttrBonuses(u) {
    const layer = { mods: {}, resistances: {} };
    for (const eff of u.effects) {
      const def = registry.getEffect(eff.id);
      if (!def || !Array.isArray(def.attrBonus)) continue;
      const times = eff.stacks;
      for (const entry of def.attrBonus) {
        const target = effectAttrBonusTarget(entry);
        if (!target || target.scope !== "self") continue;
        applyAttrBonusEntry(layer, target, target.value * (target.perStack ? times : 1));
      }
    }
    u.attrBonus = layer;
  }

  /**
   * 重算全场光环层：所有存活持有者身上 ally / enemy / all 范围的属性修正。
   * 召唤物继承来的效果副本不作为光环源，避免同一份效果被重复计算。
   */
  function recomputeAuraBonuses() {
    const layers = new Map();
    const alive = livingUnits();
    for (const u of alive) layers.set(u.key, { mods: {}, resistances: {} });
    for (const holder of alive) {
      const holderFaction = factionOf(holder);
      for (const eff of holder.effects) {
        if (eff.inheritedFrom) continue;
        const def = registry.getEffect(eff.id);
        if (!def || !Array.isArray(def.attrBonus)) continue;
        for (const entry of def.attrBonus) {
          const target = effectAttrBonusTarget(entry);
          if (!target || target.scope === "self") continue;
          const value = target.value * (target.perStack ? eff.stacks : 1);
          if (!value) continue;
          const targets =
            target.scope === "all"
              ? alive
              : target.scope === "ally"
                ? alive.filter((x) => factionOf(x) === holderFaction)
                : alive.filter((x) => factionOf(x) !== holderFaction);
          for (const t of targets) {
            const layer = layers.get(t.key);
            if (layer) applyAttrBonusEntry(layer, target, value);
          }
        }
      }
    }
    auraBonus = layers;
  }

  function attachEffect(target, eid, extra = {}) {
    const u = getUnit(target);
    if (!isAlive(u)) return null;
    const def = registry.getEffect(eid);
    if (!def) throw new Error(`未知效果：${eid}`);
    // 效果免疫：在附加前拒绝，不触发该效果的入场 / 数据更新
    if (u.immuneNegative && effectPolarity(eid) === "negative") {
      log(BATTLE_EVENT.EFFECT_IMMUNE, { unit: u.uid, effect: eid, kind: "negative" });
      return null;
    }
    if (u.immuneControl && effectFlag(eid, "control")) {
      log(BATTLE_EVENT.EFFECT_IMMUNE, { unit: u.uid, effect: eid, kind: "control" });
      return null;
    }
    const rawLayers = extra.layers === undefined ? 1 : Number(extra.layers);
    const add = Number.isFinite(rawLayers) ? Math.max(0, Math.floor(rawLayers)) : 1;
    if (add <= 0) return null;
    let layer = u.effects.find((e) => e.id === eid);
    const isNew = !layer;
    if (isNew) {
      layer = { id: eid, stacks: 0, sourceId: null, sourceFaction: null };
      u.effects.push(layer);
    }
    // 施加者：同一次附加只记一个，取「最近一次带来源的附加」。
    // sourceFaction 是附加时的阵营快照，施加者退场 / 被移出战场后仍能兜底。
    // 多层由不同单位分别附加时，层数会合并，归属统一算最后一个施加者——
    // 需要严格按层归属时，得升级成「每层来源」，当前先保持单字段。
    if (extra.source) {
      layer.sourceId = extra.source.key;
      layer.sourceFaction = factionOf(extra.source);
    }
    // 层数计数默认关闭：关闭时永远只有 1 层；开启时按「层数上限」叠加（0 = 无上限）
    const stackable = Boolean(def.stackable);
    const rawCap = Number(def.maxStacks);
    const cap = Number.isFinite(rawCap) ? Math.max(0, Math.floor(rawCap)) : 1;
    if (!stackable) {
      layer.stacks = 1;
    } else {
      const next = Math.max(0, Number(layer.stacks) || 0) + add;
      layer.stacks = cap === 0 ? next : Math.min(cap, next);
      if (layer.stacks < 1) layer.stacks = 1;
    }
    recomputeAttrBonuses(u);
    recomputeAuraBonuses();
    log(BATTLE_EVENT.EFFECT_ADDED, {
      unit: u.uid,
      effect: eid,
      stacks: layer.stacks,
      layers: add,
      source: extra.source ? extra.source.uid : null,
      sourceFaction: layer.sourceFaction || null,
    });
    // 只有「第一次获得该效果」才算一次获得；重复附加只刷新层数
    if (isNew) emit("unitEnter", [u]);
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
    recomputeAuraBonuses();
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
      const layer = u.effects.find(
        (e) => canRemove(e) && (effectPolarity(e.id) === (negative ? "negative" : "positive"))
      );
      if (layer) total += removeLayers(u, layer, layers);
    } else {
      const allNegative = mode === "allNegative";
      const list = u.effects.filter(
        (e) =>
          canRemove(e) &&
          (mode === "all" || effectPolarity(e.id) === (allNegative ? "negative" : "positive"))
      );
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
  /** 单位身上的全部效果（卡面成员效果 + 战斗中动态附加的效果；效果不能初始挂载） */
  function activeEffectsOf(u) {
    const out = [];
    for (const m of u.card.members || []) {
      if (m && m.effect) out.push({ ...m.effect, __member: { block: m.block, flow: m.flow } });
    }
    for (const layer of u.effects) {
      const def = registry.getEffect(layer.id);
      if (def) out.push(def);
    }
    return out;
  }

  /**
   * 技能的事件触发流程：技能流程里有「触发」积木时，把技能包装成与效果卡
   * 同形的触发源，让它的流程随事件广播自动运行。
   *
   * 主动技能的 skillCast / skillCastSelf 由 useSkill 执行，排除在广播外避免重复；
   * 主动技能上的其他事件触发（如单位退场时）仍然随事件广播执行。
   * 被动技能的全部触发都随事件广播。
   */
  function eventSkillEffectsOf(u) {
    const out = [];
    // 含「给予技能」临时获得的技能，以及效果授予、效果移除后会立刻消失的技能
    for (const skill of allSkillsOf(u)) {
      if (!skill || !skill.flow) continue;
      const nodes = Array.isArray(skill.flow.nodes) ? skill.flow.nodes : [];
      const triggers = nodes
        .filter((n) => n && n.type === "trigger" && n.options && n.options.event)
        .map((n) => ({
          id: n.id,
          event: n.options.event,
          unitScope: n.options.unitScope || "self",
        }))
        .filter((t) => skill.type === "passive" || (t.event !== "skillCast" && t.event !== "skillCastSelf"));
      if (!triggers.length) continue;
      const flows = {};
      for (const t of triggers) flows[t.id] = skill.flow;
      out.push({
        id: skill.id,
        name: skill.name,
        triggers,
        flows,
        attrBonus: [],
        /** 标记来源，便于日志/去重区分（技能 id 与效果 id 可能重名） */
        passiveSkill: skill.type === "passive",
      });
    }
    return out;
  }

  /**
   * 入场播报：先广播「单位入场」，再为单位补一次「数据更新」。
   * 「始终」类被动技能 / 效果据此在入场时完成首次结算（战前没有数据更新事件）。
   */
  function announceEntry(units) {
    for (const unit of units) emit("unitEnter", [unit]);
    for (const unit of units) emit("dataUpdate", [unit]);
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
    // 广播过滤：触发积木上的广播 id / 内容留空 = 任意，两个都填时同时匹配
    const matchesBroadcast = (options = {}) => {
      if (eventType !== "broadcast") return true;
      const b = (info && info.broadcast) || {};
      const id = String(b.id ?? "");
      const content = String(b.content ?? "");
      const filterId = String(options.broadcastId ?? "");
      const filterContent = String(options.broadcastContent ?? "");
      return (!filterId || filterId === id) && (!filterContent || filterContent === content);
    };
    if (effect.__member) {
      const block = effect.__member.block;
      if (!block || !block.event) return false;
      return matchesEvent(block.event) && matchesBroadcast(block.options || {});
    }
    return (effect.triggers || []).some(
      (t) => t && t.event && matchesEvent(t.event) && matchesBroadcast(triggerOptionsOf(effect, t.id))
    );
  }

  /** 取触发节点上的选项（广播过滤等）；缺失时返回空对象 */
  function triggerOptionsOf(effect, blockId) {
    const flow = triggerFlowOf(effect, blockId);
    if (!flow || !Array.isArray(flow.nodes)) return {};
    const node = flow.nodes.find((n) => n && n.id === blockId && n.type === "trigger");
    return (node && node.options) || {};
  }

  /**
   * 自动消耗：每次该效果的触发流程执行完后消耗 1 层。
   * · 只剩 1 层 → 移除整个效果；
   * · 不通过层数计数的效果 → 直接移除；
   * · 无视「不可解除」标记（自动消耗不是解除效果，是效果自身的代价）。
   */
  function autoConsumeAfterFlow(unit, effect) {
    if (!effect || !effect.autoConsume || effect.__member) return;
    if (state.status === "finished") return;
    const layer = (unit.effects || []).find((e) => e.id === effect.id);
    if (!layer) return;
    // 层数效果每次减 1；非层数效果直接把这一层全部移除
    const removed = removeLayers(unit, layer, effect.stackable ? 1 : layer.stacks);
    if (!removed) return;
    log(BATTLE_EVENT.EFFECT_REMOVED, {
      unit: unit.uid,
      effectId: effect.id,
      layers: removed,
      reason: "auto-consume",
    });
    emit("dataUpdate", [unit]);
  }

  /** 找触发节点所在的流程（技能 / 效果 / 单位卡 member） */
  function triggerFlowOf(effect, blockId) {
    return effect && effect.__member
      ? effect.__member.flow
      : effect && effect.flows
        ? effect.flows[blockId]
        : null;
  }

  /** 触发节点是否接了「单位集」输入（决定它是否要跨单位监听） */
  function triggerHasUnitInput(effect, blockId) {
    const flow = triggerFlowOf(effect, blockId);
    if (!flow || !Array.isArray(flow.links)) return false;
    return flow.links.some((link) => link && link.to === blockId && link.portTo === "unit");
  }

  /** 触发节点的单位集方式：each（按单位分别触发）/ any（旧：只判一次） */
  function triggerUnitMode(effect, blockId) {
    const flow = triggerFlowOf(effect, blockId);
    if (!flow || !Array.isArray(flow.nodes)) return "each";
    const node = flow.nodes.find((n) => n && n.id === blockId && n.type === "trigger");
    return (node && node.options && node.options.unitMode) || "each";
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
    // 「始终」= 任意单位的数据更新都触发（入场 / 扣血 / 附加效果等）。
    // 它不是「只对事件目标生效」：靠 forEach 遍历我方 / 自检层数的常驻光环，
    // 需要在任何单位入场、数据变化时都重新结算一次。
    const globalEvent =
      eventType === "turnStart" ||
      eventType === "turnEnd" ||
      eventType === "dataUpdate" ||
      eventType === "broadcast";
    /** 「我方单位攻击时」：事件对象是攻击者，但同阵营所有存活单位身上的触发都参与 */
    const allyAttackEvent = eventType === "allyAttack";
    const candidates = [];
    const seen = new Set();
    // 退场事件的目标已经不在 livingUnits() 里，但它的「退场时」触发仍然要执行；
    // 否则最后一个单位退场时，召唤 / 复活类效果会先被战斗结算跳过。
    const triggerUnits = livingUnits().slice();
    if (eventType === "unitExit") {
      for (const t of targets) {
        if (t && !triggerUnits.includes(t)) triggerUnits.push(t);
      }
    }
    for (const u of triggerUnits) {
      // 效果卡（卡面成员 + 已附加效果）与技能的事件触发共用同一套广播
      const sources = [
        ...activeEffectsOf(u).map((effect) => ({ effect, key: effect.id })),
        ...eventSkillEffectsOf(u).map((effect) => ({ effect, key: `skill:${effect.id}` })),
      ];
      for (const { effect, key: sourceKey } of sources) {
        if (!triggerMatches(effect, eventType, info)) continue;
        const sameEvent = (ev) =>
          ev === eventType ||
          (ev === "always" && eventType === "dataUpdate") ||
          (ev === "skillCastSelf" && eventType === "skillCast" && Boolean(info.skillId) && effect.id === info.skillId);
        const blocks = effect.__member
          ? [effect.__member.block].filter((b) => b && sameEvent(b.event))
          : (effect.triggers || []).filter((t) => t && t.event && sameEvent(t.event));
        if (!blocks.length) continue;
        // 全局事件人人有份；其余事件只有「事件涉及的单位」身上的效果才会触发
        // （受击事件的目标就是正在挨打的单位，所以反伤不会再反向触发攻击方）
        // 「我方单位攻击时」则让攻击者同阵营的所有单位都参与。
        // 接了「单位集」的 12 种事件要跨单位监听：事件对象不是持有者也跑，
        // 由流程里的单位集 / 条件再筛选。事件对象必须带上单位 key（key = uid）。
        const crossUnit =
          isMultiTargetTriggerEvent(eventType) &&
          blocks.some(
            (b) => triggerHasUnitInput(effect, b.id) && triggerUnitMode(effect, b.id) !== "any"
          );
        const sameSide = allyAttackEvent && targets.some((t) => t && t.side === u.side);
        const relevant = globalEvent || sameSide || targets.some((t) => t && t.key === u.key) || crossUnit;
        if (!relevant) continue;
        const key = `${u.key}|${sourceKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ unit: u, effect, blocks });
      }
    }
    if (!candidates.length) return;

    const frame = { type: eventType, targets, info };
    const prevEmitting = emitting;
    emitting = frame;
    emitStack.push(frame);
    triggerDepth += 1;
    try {
      for (const { unit, effect, blocks } of candidates) {
        // unitExit 允许刚退场的单位执行自己的退场触发
        const exitingOwner = eventType === "unitExit" && unit.exited;
        if (!isAlive(unit) && !exitingOwner) continue;
        const flows = effect.flows || {};
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
          // 同一张卡可能有多个触发，每个触发可以单独选「自己」指谁
          const triggerNode = prepared.nodes.get(block.id);
          const scope = triggerNode && triggerNode.options && triggerNode.options.unitScope;
          if (scope === "target") {
            const target = frame.targets.find((t) => t && t.key === unit.key) || frame.targets[0];
            if (target) env.self = target;
          } else if (scope === "self") {
            env.self = unit;
          }
          try {
            const run = runFlowAndFlush(prepared, env, { triggerNode: prepared.nodes.has(block.id) ? block.id : undefined });
            // 触发条件没通过（或没有可执行的触发入口）= 这条流程没有真正执行，不结算自动消耗。
            // 单位集里多个单位分别触发时（run.runs > 1），每次独立运行各消耗 1 层。
            if (run.ran && !run.triggerBlocked) {
              const times = Math.max(1, Number(run.runs) || 1);
              for (let i = 0; i < times; i += 1) autoConsumeAfterFlow(unit, effect);
            }
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

  /** 运行一次流程；只有最外层流程结束时才发送排队中的广播 */
  function runFlowAndFlush(prepared, env, opts) {
    flowDepth += 1;
    try {
      return runFlow(prepared, env, opts);
    } finally {
      flowDepth -= 1;
      if (flowDepth === 0) flushBroadcasts();
    }
  }

  /** 发送队列里的广播；广播触发流程里新排队的广播会在本轮继续发出 */
  function flushBroadcasts() {
    if (flushingBroadcasts) return;
    if (!pendingBroadcasts.length) return;
    flushingBroadcasts = true;
    let sent = 0;
    try {
      while (pendingBroadcasts.length) {
        if (sent >= MAX_BROADCASTS) {
          pendingBroadcasts = [];
          log(BATTLE_EVENT.FLOW_ERROR, { reason: "广播次数过多（可能有广播循环）" });
          break;
        }
        const batch = pendingBroadcasts;
        pendingBroadcasts = [];
        for (const b of batch) {
          sent += 1;
          emit("broadcast", [], { broadcast: b });
          if (sent >= MAX_BROADCASTS) break;
        }
      }
    } finally {
      flushingBroadcasts = false;
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
    const healSourceKey = current && current.info && current.info.source ? current.info.source : null;
    return {
      self,
      owner,
      /** 「当前效果」积木：正在执行的效果 id（技能流程为 null） */
      currentEffectId: effect ? effect.id : null,
      /** 「触发的单位」积木：本次触发的单位（技能流程里就是自己） */
      triggerUnit: effect ? triggerUnit || owner : owner,
      /** 「回复来源」：本次 heal 事件的治疗者；不在回复触发里为空 */
      healSource: healSourceKey ? getUnit(healSourceKey) : null,
      /** 当前退场请求是否已经被拒绝（只在 unitExit 触发里有意义） */
      exitSaved: () => Boolean(currentExitRequest() && currentExitRequest().saved),
      /** 当前退场请求是否强制退场（只在 unitExit 触发里有意义） */
      exitForced: () => Boolean(currentExitRequest() && currentExitRequest().force),
      /** 本次触发拿到的广播信息（「接收到广播」触发的输出来源） */
      currentBroadcast: current && current.info ? current.info.broadcast || null : null,
      /** 「广播」积木：先排队，最外层流程结束后统一发出 */
      broadcast: (id, content) => {
        pendingBroadcasts.push({ id: String(id ?? ""), content: String(content ?? "") });
      },
      context: { unit: null },
      interrupted: false,
      rng,
      sideOf: (u) => (u ? u.side : "ally"),
      otherSide,
      listSide: (side, opts = {}) => listSide(side, { fromSide: opts.fromSide ?? (owner ? owner.side : "ally") }),
      factionOf,
      listFaction,
      listAllUnits,
      effectSource: effectSourceOf,
      effectSourceFaction: effectSourceFactionOf,
      currentTarget: () => prevSkillTargets.slice(),
      pickForPlayer: (cands, opts = {}) => playerChoose(cands, { ...opts, fromSide: opts.fromSide ?? (owner ? owner.side : "ally") }),
      /** 开一个新的「攻击动作」批次；同一次攻击积木的多目标命中共用它 */
      newAttackGroup: () => ++attackGroupSeq,
      /** 「额外行动」积木：增加目标本回合剩余可动次数 */
      addActions,
      unitData: (u, field, opts) => unitDataOf(u, field, opts),
      damage: (target, value, attribute, extra) => {
        const t = getUnit(target);
        if (!isAlive(t)) return null;
        return dealDamage({
          attackerRef: extra && extra.source ? extra.source : owner,
          targetRef: t,
          value,
          attribute,
          cause: "flow",
          ignoreReduction: Boolean(extra && extra.ignoreReduction),
          additional: Boolean(extra && extra.additional),
          attackGroup: extra && extra.attackGroup,
        });
      },
      /** 流程攻击结算完成后登记「单位攻击时」：附加伤害不调用它 */
      noteAttack: (source, targets, totalDamage, meta = {}) => {
        const A = getUnit(source) || owner;
        if (!A || !isAlive(A)) return;
        A.stats.lastAttackDamage = Number(totalDamage) || 0;
        A.stats.lastAttackTargets = (targets || []).map((t) => t.key);
        A.stats.lastAttackHits = (targets || []).length;
        log(BATTLE_EVENT.ATTACK, {
          attacker: A.uid,
          hits: A.stats.lastAttackHits,
          targets: A.stats.lastAttackTargets.map((k) => (getUnit(k) ? getUnit(k).uid : k)),
          ...(meta.attackGroup ? { attackGroup: meta.attackGroup } : {}),
        });
        emit("attack", [A]);
        emit("allyAttack", [A]);
      },
      healUnit: (target, amount) => heal(getUnit(target), amount, "flow", owner),
      setHp: (target, value) => setHp(getUnit(target), value, "flow", owner),
      attachEffect: (target, eid, layers) =>
        attachEffect(getUnit(target), eid, { source: owner, layers }),
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
      /** 「退场」积木：force=true 时是强制退场（不接受「拒绝退场」，但超级无敌仍能拦下） */
      forceExit: (target, opts) =>
        forceExit(getUnit(target), { source: owner, force: Boolean(opts && opts.force) }),
      /** 「拒绝退场」积木：取消本次退场并回血（只在自己的、非强制退场时有效；可传目标集做筛选） */
      refuseExit: (mode, value, targets) => refuseExit(owner, mode, value, targets),
      /** 「转移攻击」积木：把本次受到的伤害改到另一个单位身上（force = 强制转移，本源也能转） */
      transferAttack: (from, to, opts) => transferAttack(owner, from, to, opts),
      /** 「全部子单位」积木：这个单位下面还活着的子单位 */
      childrenOf: (ref) => {
        const parent = getUnit(ref);
        if (!parent) return [];
        return livingUnits().filter((c) => c.parentKey === parent.key);
      },
      /** 「父单位」积木：召唤它的那个单位（不在场就为空） */
      parentOf: (ref) => {
        const u = getUnit(ref);
        if (!u || !u.parentKey) return null;
        const parent = getUnit(u.parentKey);
        return parent && isAlive(parent) ? parent : null;
      },
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

  /**
   * 「选择单位」积木：让玩家从候选里挑 1..max 个。
   * opts.max 最多可选（默认 1）；opts.required 必须选满——界面没给够时按候选顺序补齐，
   * 这样人机 / 不支持多选的旧界面也能跑。
   * opts.fromSide 选择者阵营，用于过滤不可被敌方 / 我方选中的单位。
   */
  function playerChoose(cands, opts = {}) {
    // 按选择者阵营过滤「不可被敌方 / 我方选中」的单位；显式目标集带进来也要过滤
    const fromSide = opts.fromSide || null;
    const list = cands && cands.length ? cands.filter((u) => u && canSelectUnit(u, fromSide)) : null;
    if (!list) return [];
    const max = Math.max(1, Math.floor(Number(opts.max) || 1));
    const required = Boolean(opts.required);
    const need = Math.min(max, list.length);
    let picked;
    if (typeof setup.chooseTargets !== "function") {
      picked = list.slice(0, max);
    } else {
      picked = setup.chooseTargets({
        candidates: list.map((u) => publicUnit(u)),
        max,
        need,
        required,
        multiple: max > 1,
        battle: publicBattle(),
      });
    }
    const out = [];
    for (const p of Array.isArray(picked) ? picked : picked ? [picked] : []) {
      const u = getUnit(p);
      if (u && !out.some((x) => x.key === u.key)) out.push(u);
      if (out.length >= max) break;
    }
    if (required && out.length < need) {
      for (const u of list) {
        if (out.length >= need) break;
        if (!out.some((x) => x.key === u.key)) out.push(u);
      }
    }
    return out;
  }

  function unitDataOf(u, field, opts = {}) {
    if (!u) return field === "name" || field === "label" || field === "id" || field === "faction" ? "" : 0;
    switch (field) {
      case "atk": return statsOf(u).atk;
      case "def": return statsOf(u).def;
      case "hp": return u.hp;
      case "hpMax": return statsOf(u).hp;
      case "lastAttackDamage": return u.stats.lastAttackDamage || 0;
      case "lastAttackHits": return u.stats.lastAttackHits || 0;
      case "lastHeal": return u.stats.lastHeal || 0;
      case "lastHealSource": return u.stats.lastHealSource ? getUnit(u.stats.lastHealSource) : null;
      case "lastLose": return u.stats.lastLose || 0;
      case "lastHpChange": return u.stats.lastHpChange || 0;
      case "lastHitDamage": return u.stats.lastHitDamage || 0;
      case "lastAttackTarget": {
        const t = (u.stats.lastAttackTargets || [])[0];
        return t ? getUnit(t) : null;
      }
      case "lastHitSource": return u.stats.lastHitSource ? getUnit(u.stats.lastHitSource) : null;
      case "effectStacks": return typeof opts.effectId === "string" && opts.effectId ? effectStacks(u, opts.effectId) : 0;
      case "children": return livingUnits().filter((c) => c.parentKey === u.key).length;
      case "faction": return factionOf(u) || "";
      case "label": return displayLabel(u);
      case "name": return u.name;
      case "id": return u.cardId;
      case "uid": return u.uid;
      default: return 0;
    }
  }

  /** 读取「某个效果」的施加者；没有记录（卡面初始效果 / 系统施加）返回 null */
  function effectSourceOf(holderRef, effectId) {
    const u = getUnit(holderRef);
    if (!u || !effectId) return null;
    const layer = u.effects.find((e) => e.id === effectId);
    if (!layer || !layer.sourceId) return null;
    return getUnit(layer.sourceId);
  }

  /**
   * 施加者阵营的全体单位：优先按施加者的「当前」阵营取；
   * 施加者已经不在场（或记录不到）时用附加时的阵营快照兜底。
   */
  function effectSourceFactionOf(holderRef, effectId, opts = {}) {
    const u = getUnit(holderRef);
    if (!u || !effectId) return [];
    const layer = u.effects.find((e) => e.id === effectId);
    if (!layer) return [];
    const src = layer.sourceId ? getUnit(layer.sourceId) : null;
    const faction = src ? factionOf(src) : layer.sourceFaction;
    return listFaction(faction, opts);
  }

  /* ================= 伤害 ================= */
  /**
   * 正在结算的伤害（「转移攻击」把这次伤害改到别的单位身上）。
   * 用栈保管：一次「受击时」的流程里可能再打出一次伤害。
   */
  const damageFrames = [];
  const currentDamageFrame = () => (damageFrames.length ? damageFrames[damageFrames.length - 1] : null);

  /**
   * 「转移攻击」积木：把本次伤害从「来源」改到「对象」身上。
   * 只认本次正在受击的那个单位（来源不接 = 就是它），对象必须活着且不是它自己。
   * 本源伤害默认不能转移，勾了「强制转移」才可以。
   * @returns {boolean} 是否记下了转移
   */
  function transferAttack(owner, from, to, opts = {}) {
    const frame = currentDamageFrame();
    if (!frame) return false;
    if (frame.isTrue && !opts.force) return false;
    const src = getUnit(from) || (from === undefined || from === null ? frame.target : null);
    if (!src || src.key !== frame.target.key) return false;
    const dst = getUnit(to);
    if (!dst || !isAlive(dst) || dst.key === src.key) return false;
    frame.to = dst;
    frame.by = owner || null;
    return true;
  }

  function dealDamage(p) {
    const A = getUnit(p.attackerRef);
    const B = getUnit(p.targetRef);
    if (!A || !B) throw new Error("dealDamage 需要攻击方与目标");
    if (!isAlive(B)) return null;
    const attribute = p.attribute || "physical";
    if (!ATTRIBUTES.includes(attribute)) throw new Error(`无效伤害属性：${attribute}`);
    const isTrue = attribute === TRUE_DAMAGE_ATTRIBUTE;
    const additional = Boolean(p.additional);
    const ignoreReduction = Boolean(p.ignoreReduction) || isTrue || additional;

    const aStats = statsOf(A, isTrue ? "origin" : "normal");

    const auto = p.value === undefined || p.value === null || p.value === "atk";
    // 本源 / 附加伤害的数值不吃加成：未指定数值时用卡面基础攻击力
    const skillValue =
      isTrue || additional
        ? auto
          ? A.card.baseAtk
          : Number(p.value)
        : auto
          ? aStats.atk
          : Number(p.value);

    // 结算前的「单位受击时」：效果可以给自己叠加免疫（本组伤害共同生效），
    // 也可以「转移攻击」——把这次伤害改到另一个单位身上。
    // 本源伤害同样算一次受击（会触发受击时），只是伤害本身依然无视减免 / 免疫。
    immuneGroup = [];
    {
      const frame = { target: B, to: null, by: null, isTrue };
      damageFrames.push(frame);
      try {
        emit("attacked", [B]);
      } finally {
        damageFrames.pop();
      }
      if (frame.to && frame.to.key !== B.key) {
        if ((Number(p.transferDepth) || 0) >= 6) {
          log(BATTLE_EVENT.FLOW_ERROR, {
            reason: "转移攻击嵌套过深",
            from: B.uid,
            to: frame.to.uid,
          });
        } else {
          // 改到新目标：新目标自己的「受击时」会照常播一遍，原目标这次记 0 伤害
          log(BATTLE_EVENT.ATTACK_TRANSFERRED, {
            attacker: A.uid,
            from: B.uid,
            to: frame.to.uid,
            skillId: p.skillId || null,
            trueDamage: isTrue,
          });
          return dealDamage({
            ...p,
            targetRef: frame.to.key,
            transferDepth: (Number(p.transferDepth) || 0) + 1,
          });
        }
      }
    }

    const bStats = statsOf(B, isTrue ? "origin" : "normal");
    if (!isTrue) bStats.resistances = resistancesOf(B);

    const result = calculateDamage({
      attacker: aStats,
      target: bStats,
      skillValue,
      attribute,
      crit: p.crit,
      noCrit: p.noCrit || isTrue,
      rng,
      targetInvincible: isInvincible(B),
      ignoreReduction,
      additional,
    });
    const rawFinal = Math.round(result.finalDamage * 1e9) / 1e9;
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
        ...(p.attackGroup ? { attackGroup: p.attackGroup } : {}),
      });
      return null;
    }
    // 本源伤害视为受击，但仍然无视「免疫伤害」的效果（本源无视一切减伤 / 免伤）
    const immune = !isTrue && group.includes(B.key);
    const final = immune ? 0 : rawFinal;

    const hpBefore = B.hp;
    B.hp = Math.max(0, B.hp - final);
    const applied = hpBefore - B.hp;
    A.damageDealt += applied;
    B.damageTaken += applied;
    if (final > 0) B.stats.lastHitDamage = final;
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
      ...(p.attackGroup ? { attackGroup: p.attackGroup } : {}),
    };
    log(BATTLE_EVENT.DAMAGE, record);
    if (immune) log(BATTLE_EVENT.IMMUNE, { unit: B.uid, by: A.uid, group: group.slice() });

    if (applied > 0) {
      log(BATTLE_EVENT.HP_LOST, { unit: B.uid, amount: applied, by: A.uid, hpBefore, hpAfter: B.hp });
      emit("loseHp", [B]);
      // 「单位生命变动时」：回复 / 损失都算，这里在死亡判定之前广播，救回类效果能接
      emit("hpChanged", [B]);
      emit("dataUpdate", [B]);
    }

    if (B.hp <= 0) {
      // 致命伤害：效果有机会把自己救回来（致命伤害触发 / 「拒绝退场」）
      if (final > 0) emit("lethalDamage", [B]);
      if (B.hp <= 0) {
        const exited = kill(B, A);
        if (!exited && isAlive(B)) {
          record.saved = true;
          record.hpAfter = B.hp;
        }
      } else {
        record.saved = true;
        record.hpAfter = B.hp;
      }
    }
    return record;
  }

  /**
   * 退场门禁（无敌档位）：
   *   免伤（damage）—— 正常退场 / 强制退场都吃；
   *   无敌（invincible）—— 只吃强制退场；
   *   超级无敌（super）—— 什么退场都不吃。
   * @returns {string|null} 被拦下的档位（null = 允许退场）
   */
  function exitBlockedBy(u, force) {
    const level = invincibleLevelOf(u);
    if (level === "super") return "super";
    if (level === "invincible" && !force) return "invincible";
    return null;
  }

  /**
   * 正在结算的退场请求（「拒绝退场」写在这里）。
   * 子单位退场会在父单位的流程里嵌套，所以用栈。
   */
  const exitRequests = [];
  const currentExitRequest = () => (exitRequests.length ? exitRequests[exitRequests.length - 1] : null);

  /**
   * 「拒绝退场」积木：只有本次触发是「退场时」、且这次退场不是强制退场时才有效；
   * 只能拒绝自己的退场（owner = 流程拥有者）。
   */
  function refuseExit(owner, mode = "full", value = 0, targets = null) {
    const req = currentExitRequest();
    if (!req || req.saved) return Boolean(req && req.saved);
    if (req.force) return false;
    if (!emitting || emitting.type !== "unitExit") return false;
    if (Array.isArray(targets)) {
      // 接了目标集：只有正在退场的单位在集合里才拒绝
      if (!targets.some((t) => t && t.key === req.unit.key)) return false;
    } else if (owner && owner.key && req.unit.key !== owner.key) return false;
    const to = mode === "to";
    req.saved = { mode: to ? "to" : "full", value: to ? Math.max(1, Number(value) || 1) : 0 };
    log(BATTLE_EVENT.EXIT_REFUSED, {
      unit: req.unit.uid,
      mode: req.saved.mode,
      value: req.saved.value,
      cause: req.cause,
    });
    return true;
  }

  /**
   * 退场（死亡 / 普通退场 / 强制退场 / 父单位连带退场）。
   * 分两段：① 先广播「退场时」——此时单位还在场，可以被「拒绝退场」救回来；
   *          ② 再真正退场（子单位一起带走）。
   * @returns {boolean} 是否真的退场了
   */
  function exitUnit(u, cause, opts = {}) {
    // exiting：正在跑这个单位的「退场时」流程——防止流程里再退它一次导致无限递归
    if (!u || u.exited || u.exiting) return false;
    const force = Boolean(opts.force);
    const blocked = exitBlockedBy(u, force);
    if (blocked) {
      // 被无敌档位拦下：不留「0 血还活着」的单位
      if (u.hp <= 0 && isAlive(u)) u.hp = 1;
      log(BATTLE_EVENT.EXIT_BLOCKED, {
        unit: u.uid,
        cause,
        level: blocked,
        forced: force,
      });
      return false;
    }
    const dying = cause === EXIT_CAUSE.DEATH;
    if (dying) u.killedBy = opts.by ? opts.by.key : null;

    // ① 退场时（可拒绝）
    const request = { unit: u, cause, force, saved: null };
    exitRequests.push(request);
    u.exiting = true;
    try {
      emit("unitExit", [u]);
    } finally {
      u.exiting = false;
      exitRequests.pop();
    }
    if (request.saved) {
      const max = statsOf(u).hp;
      const hp = request.saved.mode === "full" ? max : Math.max(1, Math.min(max, request.saved.value));
      u.state = UNIT_STATES[0];
      u.hp = hp;
      u.exited = false;
      u.exitedCause = null;
      u.killedBy = null;
      u.stats.lastHeal = hp;
      u.stats.lastHpChange = hp;
      log(BATTLE_EVENT.HEAL, { unit: u.uid, amount: hp, hpBefore: 0, hpAfter: hp, cause: "refuse-exit" });
      emit("hpChanged", [u]);
      emit("dataUpdate", [u]);
      return false;
    }

    // ② 真正退场
    u.exited = true;
    u.exitedCause = cause;
    u.state = dying ? UNIT_STATES[1] : UNIT_STATES[2];
    u.hp = 0;
    if (dying) log(BATTLE_EVENT.DEATH, { unit: u.uid, by: opts.by ? opts.by.uid : null });
    else if (cause !== EXIT_CAUSE.PARENT) {
      log(BATTLE_EVENT.EXIT, {
        unit: u.uid,
        cause,
        forced: force,
        by: opts.by ? opts.by.uid : null,
      });
    }
    // 同屏对战「允许同名角色」时：从手牌上场的卡被击败后回到牌组，之后还能再抽到；
    // 召唤物（fromDeck=false）不回流。
    if (dying && localMode && state.local && state.local.allowSameName !== false && u.fromDeck) {
      const deck = state.decks[u.side];
      if (Array.isArray(deck)) deck.push(u.cardId);
    }
    exitDepth += 1;
    try {
      const children = livingUnits().filter((c) => c.parentKey === u.key);
      for (const c of children) exitUnit(c, EXIT_CAUSE.PARENT, { force });
    } finally {
      exitDepth -= 1;
    }
    recomputeAuraBonuses();
    // 退场触发（包括嵌套退场）全部跑完后再结算，避免最后一个单位的
    // 召唤 / 复活被 checkEnd 抢先判负。
    if (exitDepth === 0) checkEnd();
    return true;
  }

  /** 退场（死亡） */
  function kill(u, by) {
    if (!isAlive(u)) return false;
    return exitUnit(u, EXIT_CAUSE.DEATH, { by });
  }

  /**
   * 退场积木 / 外部脚本入口。
   * @param {object} u 单位
   * @param {object} [extra] source：来源单位；force：强制退场（不接受「拒绝退场」，但超级无敌仍能拦下）
   */
  function forceExit(u, extra = {}) {
    if (!isAlive(u)) return false;
    return exitUnit(u, EXIT_CAUSE.FORCE, {
      force: Boolean(extra.force),
      by: extra.source || null,
    });
  }

  function heal(target, amount, cause = "direct", source = null) {
    const u = getUnit(target);
    if (!isAlive(u)) return 0;
    const before = u.hp;
    u.hp = Math.min(statsOf(u).hp, u.hp + Math.max(0, Number(amount) || 0));
    const delta = u.hp - before;
    if (delta > 0) {
      u.stats.lastHeal = delta;
      u.stats.lastHealSource = source ? source.key : null;
      u.stats.lastHpChange = delta;
      log(BATTLE_EVENT.HEAL, { unit: u.uid, amount: delta, hpBefore: before, hpAfter: u.hp, cause, source: source ? source.uid : null });
      emit("heal", [u], { source: source ? source.key : null });
      emit("hpChanged", [u]);
      emit("dataUpdate", [u]);
    }
    return delta;
  }

  function setHp(target, value, cause = "direct", source = null) {
    const u = getUnit(target);
    if (!isAlive(u)) return 0;
    const before = u.hp;
    u.hp = Math.max(0, Math.min(statsOf(u).hp, Number(value) || 0));
    const delta = u.hp - before;
    if (delta > 0) {
      u.stats.lastHeal = delta;
      u.stats.lastHealSource = source ? source.key : null;
      u.stats.lastHpChange = delta;
      log(BATTLE_EVENT.HEAL, { unit: u.uid, amount: delta, hpBefore: before, hpAfter: u.hp, cause, source: source ? source.uid : null });
      emit("heal", [u], { source: source ? source.key : null });
      emit("hpChanged", [u]);
    } else if (delta < 0) {
      u.stats.lastLose = -delta;
      u.stats.lastHpChange = delta;
      log(BATTLE_EVENT.HP_LOST, { unit: u.uid, amount: -delta, hpBefore: before, hpAfter: u.hp, cause });
      emit("loseHp", [u]);
      emit("hpChanged", [u]);
    }
    emit("dataUpdate", [u]);
    if (u.hp <= 0) kill(u, null);
    return delta;
  }

  /* ================= 召唤 ================= */
  function freeSlotFor(side) {
    for (let s = 1; s <= state.slotsPerSide; s += 1) {
      const used = state.units.some(
        (u) => isAlive(u) && !u.exiting && u.side === side && u.occupiesSlot && Math.abs(u.slot) === s
      );
      if (!used) return side === "ally" ? s : -s;
    }
    return null;
  }

  /**
   * 在某一侧生成 1 个单位（入场流程走 summon 事件）。
   * @returns {object|null} 生成失败（未知卡 / 超出上限 / 没有空格）返回 null
   */
  function spawnCard({
    unitId,
    side,
    label,
    parent,
    ignoreLimit = false,
    markActed = false,
    cause = "summon",
    slotHint = null,
  }) {
    const card = registry.getUnit(unitId);
    if (!card) {
      log(BATTLE_EVENT.FLOW_ERROR, { reason: `未知单位卡：${unitId}` });
      return null;
    }
    // 不计数单位本身不占「场上单位上限」的名额，不该被现有计数单位卡住
    const countsTowardLimit = card.countsAsUnit !== false;
    if (
      !ignoreLimit &&
      countsTowardLimit &&
      livingOf(side).filter((u) => u.countsAsUnit && !u.exiting).length >= state.summonLimit
    ) {
      return null;
    }
    let slot = freeSlotFor(side);
    let overflow = false;
    if (slot === null) {
      // 不占位单位（occupiesSlot:false）本来就不占格，没有空格时可以共享召唤者 / 父单位的格子；
      // 其余单位要勾「无视单位上限」才允许溢出（溢出单位同样不占格）。
      const canShareSlot = card.occupiesSlot === false;
      if (!ignoreLimit && !canShareSlot) return null;
      const maxSlot = Math.max(1, Number(state.slotsPerSide) || 1);
      const hint = Number(slotHint);
      const use = Number.isFinite(hint) && hint !== 0
        ? Math.min(maxSlot, Math.max(1, Math.abs(Math.floor(hint))))
        : 1;
      slot = side === "ally" ? use : -use;
      overflow = true;
    }
    const uid = `s${++summonSeq}`;
    const unit = makeUnit(uid, card, side, slot, undefined, label || card.label);
    if (overflow) unit.occupiesSlot = false;
    unit.fromDeck = cause === "play";
    // 召唤物跟召唤者同阵营（多阵营时不会被算进别的阵营）
    unit.faction = parent ? factionOf(parent) : side;
    unit.parentKey = parent ? parent.key : null;
    if (parent) {
      const inherited = parent.attrBonus || {};
      unit.attrBonus = {
        mods: structuredClone(inherited.mods || {}),
        resistances: { ...(inherited.resistances || {}) },
      };
      for (const layer of parent.effects) {
        const def = registry.getEffect(layer.id);
        // 「不继承」的效果不复制给召唤物（黑名单式的持有控制仍由流程条件负责）
        if (def && def.inherit === false) continue;
        unit.effects.push({
          id: layer.id,
          stacks: layer.stacks,
          sourceId: layer.sourceId || null,
          sourceFaction: layer.sourceFaction || null,
          inheritedFrom: { source: parent.key, effectId: layer.id },
        });
      }
      recomputeAttrBonuses(unit);
    }
    state.units.push(unit);
    recomputeAuraBonuses();
    // 召唤出来的单位默认保留本回合可动次数；只有调用方显式要求（markActed: true）时才用完。
    if (markActed) unit.actionsLeft = 0;
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
    // 默认不标记「已行动」：召唤物当回合就能行动（见 spawnCard 的注释）
    const acted = markActed === undefined ? false : Boolean(markActed);
    for (let i = 0; i < count; i += 1) {
      const unit = spawnCard({
        unitId,
        side,
        label,
        parent,
        ignoreLimit,
        markActed: acted,
        cause: parent ? "summon-child" : "summon",
        slotHint: parent ? parent.slot : owner ? owner.slot : null,
      });
      if (!unit) break;
      spawned.push(unit);
    }
    announceEntry(spawned);
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
    announceEntry(spawned);
    return spawned.length;
  }

  /* ================= local 模式：抽牌 / 手牌 / 布阵 ================= */
  function handOf(side) {
    return state.hand[side] || [];
  }

  /** 从牌堆顶抽 count 张进手牌；返回实际抽到的卡 id */
  function drawCards(side, count, opts = {}) {
    if (!localMode) return [];
    const deck = state.decks[side] || [];
    const hand = state.hand[side];
    const drawn = [];
    // 先清掉损坏 / 不存在的卡，避免随机抽牌时反复命中
    for (let i = deck.length - 1; i >= 0; i -= 1) {
      if (!registry.getUnit(deck[i])) {
        log(BATTLE_EVENT.FLOW_ERROR, { reason: `牌组里有未知单位卡：${deck[i]}`, side });
        deck.splice(i, 1);
      }
    }
    const allowSameName = !state.local || state.local.allowSameName !== false;
    /** 不允许同名时：该方场上 / 手牌已有的角色名不能再被抽到 */
    const blockedNames = new Set();
    if (!allowSameName) {
      for (const u of state.units) {
        if (u.side === side && isAlive(u)) blockedNames.add(u.name || u.cardId);
      }
      for (const id of hand) {
        const card = registry.getUnit(id);
        if (card) blockedNames.add(card.name || card.id);
      }
    }

    for (let i = 0; i < Math.max(0, Math.floor(Number(count) || 0)); i += 1) {
      if (!deck.length) break;
      const candidates = [];
      for (let j = 0; j < deck.length; j += 1) {
        const card = registry.getUnit(deck[j]);
        if (!card) continue;
        if (!allowSameName && blockedNames.has(card.name || card.id)) continue;
        candidates.push(j);
      }
      // 允许同名时，即使剩下的卡名字都已在手牌 / 场上，也直接在当前牌库中抽；
      // 每张牌仍按牌库下标等概率命中，不因为同名而降低重复卡概率。
      if (!candidates.length && allowSameName) {
        for (let j = 0; j < deck.length; j += 1) {
          if (registry.getUnit(deck[j])) candidates.push(j);
        }
      }
      // 只有「不允许同名」且全是同名 / 不可抽的卡时，这次才不抽
      if (!candidates.length) break;
      // 随机抽：双方即使拿到同一份牌库，也不会按同一顺序抽到同样的牌
      const pick = candidates[Math.floor(rng() * candidates.length)];
      const cardId = deck.splice(pick, 1)[0];
      const card = registry.getUnit(cardId);
      hand.push(cardId);
      drawn.push(cardId);
      if (!allowSameName && card) blockedNames.add(card.name || card.id);
      log(BATTLE_EVENT.HAND_DRAW, {
        side,
        cardId,
        handIndex: hand.length - 1,
        handLeft: hand.length,
        deckLeft: deck.length,
        refill: Boolean(opts.refill),
      });
    }
    return drawn;
  }

  /** 手牌是否可以上场（数量 / 同名限制 / 场上上限） */
  function canDeploy(side) {
    if (!localMode || state.status !== "running") return false;
    if (!["ally", "enemy"].includes(side)) return false;
    if (!handOf(side).length) return false;
    if (livingOf(side).filter((u) => u.countsAsUnit).length >= state.maxUnits) return false;
    if (state.localDeploy && state.localDeploy.side !== side) return false;
    return true;
  }

  /**
   * 从手牌上场 1 个单位。
   * @param {"ally"|"enemy"} side
   * @param {number} handIndex 手牌下标
   * @returns {object|null} 上场的单位
   */
  function deployFromHand(side, handIndex) {
    if (!canDeploy(side)) return null;
    const hand = state.hand[side];
    const idx = Math.floor(Number(handIndex));
    if (!Number.isInteger(idx) || idx < 0 || idx >= hand.length) return null;
    const cardId = hand[idx];
    const card = registry.getUnit(cardId);
    if (!card) return null;
    if (!state.local.allowSameName && livingOf(side).some((u) => u.name === (card.name || card.id))) return null;
    const unit = spawnCard({ unitId: cardId, side, markActed: false, cause: "play" });
    if (!unit) return null;
    hand.splice(idx, 1);
    log(BATTLE_EVENT.HAND_PLAY, {
      side,
      unit: unit.uid,
      cardId,
      handIndex: idx,
      handLeft: hand.length,
    });
    announceEntry([unit]);
    return unit;
  }

  /**
   * 结束当前布阵（初始布阵 / 场上全灭后的补上场）。
   * 初始布阵：红方先布，再换蓝方，两边都至少 1 个单位后正式开战。
   * 补上场：回到回合推进。
   */
  function finishDeploy(side) {
    if (!localMode || state.status !== "running") return false;
    const d = state.localDeploy;
    if (!d || d.side !== side) return false;
    const count = livingOf(side).length;
    if (count < 1) return false;
    if (d.initial) {
      log(BATTLE_EVENT.DEPLOY_DONE, { side, initial: true });
      if (side === state.firstSide) {
        state.localDeploy = { initial: true, side: otherSide(side), previousUid: null };
        state.sideTurn = state.localDeploy.side;
        log(BATTLE_EVENT.DEPLOY_REQUIRED, {
          side: state.localDeploy.side,
          reason: "initial",
          hand: handOf(state.localDeploy.side).length,
        });
        return true;
      }
      state.localDeploy = null;
      state.phase = BATTLE_PHASE.SELECT;
      state.sideTurn = state.firstSide;
      state.turn = 1;
      log(BATTLE_EVENT.ROUND_START, { turn: state.turn });
      const leader = sideLeader();
      emit("turnStart", leader ? [leader] : []);
      if (state.status !== "running") return true;
      if (checkEnd()) return true;
      if (pauseForReinforce(null)) return true;
      log(BATTLE_EVENT.SIDE_TURN, { side: state.sideTurn });
      return true;
    }
    const previous = d.previousUid ? getUnit(d.previousUid) : null;
    state.localDeploy = null;
    state.phase = BATTLE_PHASE.SELECT;
    log(BATTLE_EVENT.DEPLOY_DONE, { side, initial: false });
    advanceSide(previous);
    return true;
  }

  /** 经过指定回合后，双方交替补牌 */
  function refillLocal() {
    const cfg = state.local;
    if (!cfg || !cfg.refillEnabled || cfg.refillCount <= 0) return false;
    if (cfg.refillEvery <= 0 || (state.turn - 1) % cfg.refillEvery !== 0) return false;
    const order = [state.firstSide, otherSide(state.firstSide)];
    let any = false;
    for (let i = 0; i < cfg.refillCount; i += 1) {
      for (const side of order) {
        const drawn = drawCards(side, 1, { refill: true });
        if (!drawn.length) continue;
        any = true;
        log(BATTLE_EVENT.REFILL, {
          side,
          cardId: drawn[0],
          handIndex: handOf(side).length - 1,
          roundIndex: i,
          totalRounds: cfg.refillCount,
          refillEvery: cfg.refillEvery,
          turn: state.turn,
        });
      }
    }
    if (any) log(BATTLE_EVENT.REFILL_DONE, { turn: state.turn });
    return any;
  }

  /** local 模式：场上全灭但有手牌时，暂停回合推进，先补上场 */
  function pauseForReinforce(previous) {
    if (!localMode || state.status !== "running" || state.localDeploy) return false;
    const ordered = previous
      ? [otherSide(previous.side), previous.side]
      : [state.firstSide, otherSide(state.firstSide)];
    const side = ordered.find(
      (s) => livingOf(s).length === 0 && handOf(s).length > 0
    );
    if (!side) return false;
    state.phase = BATTLE_PHASE.DEPLOY;
    state.sideTurn = side;
    state.localDeploy = { initial: false, side, previousUid: previous ? previous.uid : null };
    log(BATTLE_EVENT.DEPLOY_REQUIRED, { side, reason: "reinforce", hand: handOf(side).length });
    return true;
  }

  function actionOrder() {
    return livingUnits()
      .slice()
      .sort((a, b) => statsOf(b).speed - statsOf(a).speed || Math.abs(a.slot) - Math.abs(b.slot) || (a.uid < b.uid ? -1 : 1));
  }

  function checkEnd() {
    if (state.status !== "running") return true;
    // 计数只影响「阵营单位数量上限」，胜负判定按场上所有存活单位
    const allies = livingOf("ally");
    const enemies = livingOf("enemy");
    // side 模式：牌组里还有单位 = 还没输，下回合会补上场
    const deckLeft = (side) => (state.decks[side] || []).length;
    // local 模式：场上全灭但手里还有牌 = 还能补上场，不算输；
    // 开了补牌时牌组也算资源（被击败回流的卡还在牌组里，等补牌抽回手牌）。
    const handLeft = (side) => (state.hand[side] || []).length;
    const localRefill = localMode && state.local && state.local.refillEnabled && state.local.refillCount > 0;
    const localOut = (side) => handLeft(side) === 0 && (!localRefill || deckLeft(side) === 0);
    const allyOut = allies.length === 0 && (localMode ? localOut("ally") : !sideMode || deckLeft("ally") === 0);
    const enemyOut = enemies.length === 0 && (localMode ? localOut("enemy") : !sideMode || deckLeft("enemy") === 0);
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
    // 从上一个行动者之后找一个「本回合还有剩余可动次数」的单位；
    // 全都没有时结束本回合，重置所有人的剩余次数后再开始下一回合。
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 1000) throw new Error("行动推进出现死循环");
      const order = actionOrder();
      if (!order.length) return api;
      const startIdx = previous ? order.findIndex((u) => u.uid === previous.uid) + 1 : 0;
      let next = null;
      for (let i = 0; i < order.length; i += 1) {
        const u = order[(startIdx + i + order.length) % order.length];
        if (canAct(u)) {
          next = u;
          break;
        }
      }
      if (!next) {
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
        state.started = [];
        state.skippedThisTurn = [];
        state.actionUsed = false;
        resetActions();
        emit("turnStart", leader ? [leader] : []);
        if (state.status === "finished") return api;
        const order2 = actionOrder();
        if (!order2.length) return api;
        next = order2.find((u) => canAct(u)) || order2[0];
      }
      state.actionSeq += 1;
      state.activeId = next.uid;
      previous = null;
      log(BATTLE_EVENT.TURN_START, { activeId: state.activeId });
      emit("unitTurnStart", [next]);
      if (state.status === "finished") return api;
      if (state.skippedThisTurn.includes(next.uid)) {
        next.actionsLeft = 0;
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
  /** 某方是否还有「本回合有剩余可动次数」的存活单位 */
  function hasActable(side) {
    return livingOf(side).some((u) => canAct(u));
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
    state.started = [];
    state.skippedThisTurn = [];
    state.activeId = null;
    state.actionUsed = false;
    resetActions();
    if (localMode) {
      // 同屏模式不自动从牌组上场；按设置给双方交替补牌
      refillLocal();
    } else {
      state.deploying = true;
      deployFromDeck("ally");
      deployFromDeck("enemy");
      state.deploying = false;
    }
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
    if (pauseForReinforce(previous)) return api;
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
    if (!sideMode || state.status !== "running") return false;
    // side 模式：select 阶段选人；act 阶段且还没用技能时，允许点另一个未行动单位换人
    if (state.phase !== BATTLE_PHASE.SELECT && state.phase !== BATTLE_PHASE.ACT) return false;
    if (state.phase === BATTLE_PHASE.ACT && state.actionUsed) return false;
    const u = getUnit(unitRef);
    if (!isAlive(u) || u.side !== state.sideTurn || !canAct(u)) return false;
    if (state.phase === BATTLE_PHASE.ACT && state.activeId === u.uid) return true;
    state.activeId = u.uid;
    state.phase = BATTLE_PHASE.ACT;
    state.actionUsed = false;
    state.actionSeq += 1;
    log(BATTLE_EVENT.TURN_START, { activeId: u.uid });
    // 换人时同一个单位本回合只触发一次「行动开始时」，避免开始效果重复结算
    if (!state.started.includes(u.uid)) {
      state.started.push(u.uid);
      emit("unitTurnStart", [u]);
    }
    if (state.status !== "running") return false;
    if (!isAlive(u)) {
      // 行动开始效果把人打死了：这个单位的行动直接结束
      endSideAction();
      return false;
    }
    // 行动开始时被「跳过行动」：本次行动作废，但必须记为已行动，
    // 否则同一个单位会在本回合被反复选中，控制效果等于没有。
    if (state.skippedThisTurn.includes(u.uid)) {
      state.skippedThisTurn = state.skippedThisTurn.filter((uid) => uid !== u.uid);
      u.actionsLeft = 0;
      state.activeId = null;
      state.actionUsed = false;
      state.phase = BATTLE_PHASE.SELECT;
      log(BATTLE_EVENT.ACTION_SKIP, { activeId: u.uid });
      log(BATTLE_EVENT.TURN_END, { activeId: u.uid, actionSeq: state.actionSeq, skipped: true });
      if (state.status !== "running") return false;
      advanceSide(u);
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
    state.actionUsed = false;
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
    if (A) A.actionsLeft = 0;
    log(BATTLE_EVENT.TURN_END, { activeId: A ? A.uid : null, actionSeq: state.actionSeq });
    if (state.status !== "running") return api;
    return advanceSide(A);
  }

  /* ================= 技能 ================= */
  /**
   * 效果挂载的技能：只按当前仍然持有的效果层计算。
   * 效果被移除（自然掉层 / 强制移除 / 自动消耗 / 继承来源消失）后，
   * 这一项立刻消失，不需要额外的回收逻辑；召唤物继承效果时也会跟着获得。
   */
  function effectSkillsOf(u) {
    const ids = [];
    for (const layer of u.effects || []) {
      const def = registry.getEffect(layer.id);
      if (!def || !Array.isArray(def.skillIds)) continue;
      for (const sid of def.skillIds) if (!ids.includes(sid)) ids.push(sid);
    }
    return ids.map((id) => registry.getSkill(id)).filter(Boolean);
  }

  function allSkillsOf(u) {
    const seen = new Set();
    const out = [];
    const push = (skill) => {
      if (!skill || seen.has(skill.id)) return;
      seen.add(skill.id);
      out.push(skill);
    };
    for (const skill of u.skills || []) push(skill);
    for (const g of u.granted || []) push(registry.getSkill(g.skillId));
    for (const skill of effectSkillsOf(u)) push(skill);
    return out;
  }

  /** 技能流程预处理缓存：技能卡在一次战斗里不会变，避免 UI/AI 反复 prepare */
  const flowCache = new WeakMap();
  function preparedFlowOf(flow) {
    if (!flow || typeof flow !== "object") return null;
    let prepared = flowCache.get(flow);
    if (!prepared) {
      prepared = prepareFlow(flow);
      flowCache.set(flow, prepared);
    }
    return prepared;
  }

  /** 技能「释放条件」：由释放类触发积木的 condition 输入决定；没接条件 = 可以释放 */
  function skillConditionOk(u, skill) {
    if (!skill || skill.format !== "flow" || !skill.flow) return true;
    const prepared = preparedFlowOf(skill.flow);
    if (!prepared || !prepared.ok) return false;
    const castTriggers = [...prepared.nodes.values()].filter(
      (n) =>
        n &&
        n.type === "trigger" &&
        n.options &&
        (n.options.event === "skillCastSelf" || n.options.event === "skillCast")
    );
    if (!castTriggers.length) return true;
    try {
      return castTriggers.some((trigger) => {
        const env = flowEnv(u, null);
        // 可用性检查只是求条件，不应读取上一次技能的目标、不应向玩家弹选择框，
        // 也不能消耗战斗 RNG（否则 UI 每次刷新都会改变战斗随机序列 / 存档重放）。
        env.currentTarget = () => [];
        env.pickForPlayer = () => null;
        env.rng = () => 0.5;
        const res = runFlow(prepared, env, {
          triggerNode: trigger.id,
          conditionOnly: true,
        });
        return res.conditionPassed !== false;
      });
    } catch {
      // 条件本身有错时不阻塞 UI：技能显示为不可用，具体错误由释放时的流程错误日志报告
      return false;
    }
  }

  /**
   * 技能的可用状态：释放条件 + 每回合次数 + 总次数。
   * 0 次 = 不限；每回合次数按当前回合数（state.turn）独立计算，单位本身保存总次数。
   */
  function skillStateOf(u, skill) {
    const perTurn = Math.max(0, Math.floor(Number(skill?.usesPerTurn) || 0));
    const total = Math.max(0, Math.floor(Number(skill?.usesTotal) || 0));
    const rec = u && u.skillUses ? u.skillUses[skill?.id] : null;
    const turnUsed = rec && rec.round === state.turn ? Math.max(0, Number(rec.turn) || 0) : 0;
    const totalUsed = rec ? Math.max(0, Number(rec.total) || 0) : 0;
    const turnLeft = perTurn === 0 ? null : Math.max(0, perTurn - turnUsed);
    const totalLeft = total === 0 ? null : Math.max(0, total - totalUsed);
    const conditionOk = skillConditionOk(u, skill);
    let reason = "";
    if (!isAlive(u)) reason = "单位已不在场";
    else if (skill?.type !== "active") reason = "被动技能";
    else if (turnLeft === 0) reason = "本回合次数已用完";
    else if (totalLeft === 0) reason = "总次数已用完";
    else if (!conditionOk) reason = "释放条件未满足";
    return {
      perTurn,
      total,
      turnUsed,
      totalUsed,
      turnLeft,
      totalLeft,
      conditionOk,
      available: !reason,
      reason,
    };
  }

  function spendSkillUse(u, skill) {
    if (!u || !skill) return;
    const id = skill.id;
    let rec = u.skillUses[id];
    if (!rec || rec.round !== state.turn) {
      rec = { round: state.turn, turn: 0, total: rec ? Math.max(0, Number(rec.total) || 0) : 0 };
    }
    rec.turn += 1;
    rec.total += 1;
    u.skillUses[id] = rec;
  }

  function useSkill(index, opts = {}) {
    if (state.status !== "running") return null;
    const A = active();
    if (!A) throw new Error("没有可行动的单位");
    const skill = allSkillsOf(A)[index];
    if (!skill) throw new Error(`${A.name} 没有第 ${index} 个技能`);
    if (skill.type !== "active") throw new Error(`${skill.name} 是被动技能，不能主动使用`);
    if (!canAct(A)) throw new Error(`${A.name} 本回合没有剩余可动次数`);
    const skillState = skillStateOf(A, skill);
    if (!skillState.available) throw new Error(`${skill.name} 当前不可用：${skillState.reason}`);

    let primary = opts.targetRef ? getUnit(opts.targetRef) : null;
    if (primary && !isAlive(primary)) return null;
    // 按施放者阵营检查选中限制（直接 API / 旧界面也一并拦住）
    if (primary && !canSelectUnit(primary, A.side)) return null;
    if (!primary && skill.requiresTarget) {
      primary = selectTarget(state.units, otherSide(A.side), { fromSide: A.side });
      if (!primary) return null;
    }

    log(BATTLE_EVENT.SKILL, {
      caster: A.uid,
      skillId: skill.id,
      skillName: skill.name,
      target: primary ? primary.uid : null,
    });
    // 一次技能 = 消耗 1 次可动次数 + 1 次技能次数
    spendSkillUse(A, skill);
    spendAction(A, 1);
    // 本次行动已经使用过技能：不能再换人；还有剩余次数时留在本单位继续用技能
    state.actionUsed = true;

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
        // 技能流程里可能有多个「触发」；释放技能时执行所有 skillCastSelf 触发，
        // 每个触发只跑它自己后面的内容。没有 cast 触发时兼容旧流程，跑第一个触发。
        const triggers = [...prepared.nodes.values()].filter((n) => n.type === "trigger");
        const castTriggers = triggers.filter(
          (n) => n.options && (n.options.event === "skillCastSelf" || n.options.event === "skillCast")
        );
        const startTriggers = castTriggers.length ? castTriggers : triggers.slice(0, 1);

        // 没有指定目标时，技能默认把最近的敌方单位作为「当前目标」（与数据式技能一致）
        if (!prevSkillTargets.length) {
          const autoTarget = selectTarget(state.units, otherSide(A.side), { fromSide: A.side });
          if (autoTarget) prevSkillTargets = [autoTarget];
        }
        for (const trigger of startTriggers) {
          const env = flowEnv(A, null);
          // 每个触发可以单独选「自己」指谁
          if (trigger.options && trigger.options.unitScope === "target") {
            const cur = prevSkillTargets[0];
            if (cur) env.self = cur;
          }
          try {
            runFlowAndFlush(prepared, env, { triggerNode: trigger.id });
          } catch (err) {
            log(BATTLE_EVENT.FLOW_ERROR, { owner: A.uid, skillId: skill.id, reason: String((err && err.message) || err) });
          }
          if (state.status !== "running" || !isAlive(A)) break;
        }
        // 技能效果都结算完再广播一次；需要「父单位技能结算后」的效果用这个事件
        emit("skillResolved", [A], { skillId: skill.id });
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
              : [selectTarget(state.units, otherSide(A.side), { ignoreDistance: true, fromSide: A.side })].filter(Boolean);
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
        emit("allyAttack", [A]);
      }
      emit("skillResolved", [A], { skillId: skill.id });
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
      faction: factionOf(u),
      slot: u.slot,
      hp: u.hp,
      hpMax: s.hp,
      atk: s.atk,
      def: s.def,
      /** 每回合默认可动次数 / 本回合剩余可动次数 */
      actionsPerTurn: u.actionsPerTurn,
      actionsLeft: u.actionsLeft,
      label: displayLabel(u),
      state: u.state,
      countsAsUnit: u.countsAsUnit,
      occupiesSlot: u.occupiesSlot,
      /** 选中限制：none / enemy / ally / all */
      unselectable: normalizeUnselectable(u.unselectable),
      immuneNegative: Boolean(u.immuneNegative),
      immuneControl: Boolean(u.immuneControl),
      /** 伤害免疫（任一档无敌 / 整方无敌）——旧界面按布尔值用 */
      invincible: isInvincible(u),
      /** 无敌档位：none / damage（免伤）/ invincible（无敌）/ super（超级无敌） */
      invincibleLevel: invincibleLevelOf(u),
      parentKey: u.parentKey,
      /** side 模式：这个单位本回合是否已经行动过 */
      /** 兼容旧界面：没有剩余可动次数就等价于「已行动」 */
      acted: (Number(u.actionsLeft) || 0) <= 0,
      effects: u.effects.map((e) => ({
        id: e.id,
        stacks: e.stacks,
        sourceId: e.sourceId || null,
        sourceFaction: e.sourceFaction || null,
      })),
      buffs: u.buffs.map((b) => ({ uid: b.uid, label: b.label, duration: b.duration })),
      skills: allSkillsOf(u).map((sk) => ({
        id: sk.id,
        name: sk.name,
        type: sk.type,
        ...skillStateOf(u, sk),
      })),
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
      actionUsed: state.actionUsed,
      sideTurn: state.sideTurn,
      firstSide: state.firstSide,
      maxUnits: state.maxUnits,
      acted: state.units.filter((u) => isAlive(u) && (Number(u.actionsLeft) || 0) <= 0).map((u) => u.uid),
      invincibleSides: state.invincibleSides.slice(),
      decks: { ally: (state.decks.ally || []).length, enemy: (state.decks.enemy || []).length },
      ...(localMode
        ? {
            hand: { ally: state.hand.ally.slice(), enemy: state.hand.enemy.slice() },
            local: { ...state.local },
            localDeploy: state.localDeploy ? { ...state.localDeploy } : null,
          }
        : {}),
      units: state.units.filter((u) => u.state !== UNIT_STATES[2]).map(publicUnit),
    };
  }

  /* ================= 启动 ================= */
  function start() {
    if (localMode) return startLocal();
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
    announceEntry(livingUnits().slice());
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

  /** local 模式启动：先抽初始手牌，双方依次布阵，再正式开战 */
  function startLocal() {
    state.turn = 1;
    state.actionSeq = 0;
    state.phase = BATTLE_PHASE.DEPLOY;
    state.sideTurn = state.firstSide;
    state.localDeploy = { initial: true, side: state.firstSide, previousUid: null };
    log(BATTLE_EVENT.BATTLE_START, {
      battleId: state.id,
      seed: state.seed,
      mode: state.mode,
      units: [],
      decks: { ally: state.decks.ally.slice(), enemy: state.decks.enemy.slice() },
      maxUnits: state.maxUnits,
      invincibleSides: state.invincibleSides.slice(),
      local: { ...state.local },
    });
    drawCards("ally", state.local.initialHand);
    drawCards("enemy", state.local.initialHand);
    log(BATTLE_EVENT.DEPLOY_REQUIRED, {
      side: state.firstSide,
      reason: "initial",
      hand: handOf(state.firstSide).length,
    });
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
    // 主动结束行动：本回合剩余可动次数作废，下回合重置
    A.actionsLeft = 0;
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
    /** side / local 模式：选择本回合要行动的单位 */
    selectUnit,
    /** side / local 模式：当前方还有没有没行动的单位 */
    hasActable,
    /** local 模式：手牌（单位卡 id 数组） */
    handOf,
    /** local 模式：手牌能否上场 */
    canDeploy,
    /** local 模式：从手牌上场 1 个单位 */
    deployFromHand,
    /** local 模式：结束当前布阵 / 补上场 */
    finishDeploy,
    /** local 模式：抽牌（主要给界面的补牌动画使用） */
    drawCards(side, count) {
      return drawCards(side, count);
    },
    /** 当前模式（speed / side / local） */
    mode: state.mode,
    allSkillsOf,
    /** 技能可用状态：释放条件 / 本回合剩余次数 / 总剩余次数 */
    skillStateOf,
    /** 增加 / 扣减单位本回合剩余可动次数（额外行动） */
    addActions,
    resetActions,
    canAct,
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
    attachEffect(unitRef, effectId, { log: shouldLog = false, layers = 1, source = null } = {}) {
      return withMuted(!shouldLog, () =>
        attachEffect(getUnit(unitRef), effectId, { layers, source: source ? getUnit(source) : null })
      );
    },
    forceExit(unitRef, { log: shouldLog = false, force = true } = {}) {
      return withMuted(!shouldLog, () => forceExit(getUnit(unitRef), { force }));
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
