/**
 * storage.js —— 数据存储：序列化 / 校验 / 存档槽
 *
 * 三种数据分开存（相互独立，便于以后模组只改其中一部分）：
 *   unit   单位卡      mods/<卡包>.json 里的 units
 *   skill  技能卡      mods/<卡包>.json 里的 skills
 *   battle 战斗存档    storage.save("battle", …)（默认走内存，可换 localStorage）
 *
 * 战斗存档是按卡 id 引用的「战局快照」，而不是引擎内部对象的深拷贝：
 * 每个单位只存 cardId / 站位 / 当前生命 / 状态 / buff / 累计统计。
 * 读档 = 用同一份内容 + 同一个种子重放操作序列（replay），
 * 因此存档体积小，且不会出现「存档里的数值和公式脱节」。
 */
import { ContentRegistry } from "./registry.js";
import { createBattle } from "./battle.js";
import { validateUnitCard, createUnitCard } from "./units.js";
import { validateSkillCard, createSkillCard } from "./skills.js";
import { normalizeSlot } from "./targeting.js";
import { EFFECT_POLARITIES, parseId, validateEffectAttrBonus, validateEffectDisplay } from "./constants.js";

export const SCHEMA_VERSION = 1;
/** 内置槽位名 */
export const SLOTS = Object.freeze({
  BATTLE: "battle", // 战斗存档（战局快照 + 操作序列）
  UNITS: "units", // 单位卡内容包
  SKILLS: "skills", // 技能卡内容包
});

/* ------------------------------------------------------------------ */
/* 内容包：校验 + 序列化                                                */
/* ------------------------------------------------------------------ */

export function serializeUnits(registry) {
  return { schema: SCHEMA_VERSION, kind: "units", units: registry.snapshot().units };
}

export function serializeSkills(registry) {
  return { schema: SCHEMA_VERSION, kind: "skills", skills: registry.snapshot().skills };
}

export function serializeEffects(registry) {
  return { schema: SCHEMA_VERSION, kind: "effects", effects: registry.snapshot().effects };
}

/**
 * 校验一份内容包（不抛异常，返回全部问题）。
 * @param {{units?: any[], skills?: any[]}} doc
 */
export function validateContent(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") {
    return { ok: false, errors: ["内容包必须是对象"] };
  }
  if (doc.schema !== undefined && doc.schema !== SCHEMA_VERSION) {
    errors.push(`schema 版本不支持：${doc.schema}`);
  }

  // 允许省略 units / skills（例如只给单位不引技能的场景）
  const units = Array.isArray(doc.units) ? doc.units : [];
  const skills = Array.isArray(doc.skills) ? doc.skills : [];
  const effects = Array.isArray(doc.effects) ? doc.effects : [];
  if (!Array.isArray(doc.units) && doc.units !== undefined) errors.push("units 必须是数组");
  if (!Array.isArray(doc.skills) && doc.skills !== undefined) errors.push("skills 必须是数组");

  const seen = new Set();
  for (const raw of units) {
    const { ok, errors: e } = validateUnitCard(raw ? createUnitCard(raw) : {});
    if (!ok) errors.push(`单位 ${raw && raw.id}: ${e.join("；")}`);
    else if (seen.has(raw.id)) errors.push(`单位 id 重复：${raw.id}`);
    else seen.add(raw.id);
  }

  const skillIds = new Set();
  for (const raw of skills) {
    const rawSkill = raw ? createSkillCard(raw) : {};
    rawSkill.skills = raw && Array.isArray(raw.skills) ? raw.skills : [];
    const { ok, errors: e } = validateSkillCard(rawSkill);
    if (!ok) errors.push(`技能 ${raw && raw.id}: ${e.join("；")}`);
    else if (skillIds.has(raw.id)) errors.push(`技能 id 重复：${raw.id}`);
    else skillIds.add(raw.id);
  }

  const effectIds = new Set();
  for (const raw of effects) {
    const id = raw && raw.id;
    if (parseId(id).ok !== true) errors.push(`效果 ${id}: id 格式不对`);
    else if (effectIds.has(id)) errors.push(`效果 id 重复：${id}`);
    else effectIds.add(id);
    if (raw && raw.polarity !== undefined && raw.polarity !== null && raw.polarity !== "" && !EFFECT_POLARITIES.includes(raw.polarity)) {
      errors.push(`效果 ${id}: 倾向必须是 ${EFFECT_POLARITIES.join("/")}：${raw.polarity}`);
    }
    if (raw && raw.stackable !== undefined && typeof raw.stackable !== "boolean") {
      errors.push(`效果 ${id}: stackable 必须是布尔值`);
    }
    if (raw && raw.maxStacks !== undefined) {
      const n = Number(raw.maxStacks);
      if (!Number.isFinite(n) || n < 0) errors.push(`效果 ${id}: maxStacks 必须是 ≥ 0 的数字`);
    }
    if (raw && raw.image !== undefined && raw.image !== null && typeof raw.image !== "string") {
      errors.push(`效果 ${id}: image 必须是字符串或 null`);
    }
    for (const e of validateEffectDisplay(raw)) errors.push(`效果 ${id}: ${e}`);
    for (const e of validateEffectAttrBonus(raw && raw.attrBonus)) errors.push(`效果 ${id}: ${e}`);
    if (raw && raw.skillIds !== undefined) {
      if (!Array.isArray(raw.skillIds)) errors.push(`效果 ${id}: skillIds 必须是数组`);
      else {
        for (const sid of raw.skillIds) {
          if (typeof sid !== "string" || !sid) errors.push(`效果 ${id}: skillIds 必须是非空字符串`);
          else if (!skillIds.has(sid)) errors.push(`效果 ${id} 挂载了不存在的技能 ${sid}`);
        }
      }
    }
  }

  for (const unit of units) {
    const card = unit ? createUnitCard(unit) : null;
    if (!card) continue;
    for (const sid of card.skills) {
      if (!skillIds.has(sid)) errors.push(`单位 ${card.id} 引用了不存在的技能 ${sid}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 从内容包建注册表（假定已校验；失败项仍会记录） */
export function registryFromContent(doc) {
  const registry = new ContentRegistry();
  registry.load({ units: doc.units || [], skills: doc.skills || [], effects: doc.effects || [] });
  return registry;
}

/* ------------------------------------------------------------------ */
/* 战斗存档                                                             */
/* ------------------------------------------------------------------ */

/**
 * 从战斗对象导出存档。
 * hp 是「当前」生命，只在战斗初始化时传入（createBattle 的 spec.hp），重放时不需要再设置。
 * @param {object} battle createBattle 的返回值
 * @param {Array<object>} actions 已执行的操作序列，形如
 *        { type: "skill", index: 0, targetRef?: "u3" } | { type: "end" }
 */
export function serializeBattle(battle, actions = []) {
  const s = battle.state;
  const seen = new Set();
  const order = [];
  for (const ev of s.events) {
    if (ev.type === "turn:start" && !seen.has(ev.activeId)) {
      seen.add(ev.activeId);
      order.push(ev.activeId);
    }
  }
  return {
    schema: SCHEMA_VERSION,
    kind: "battle",
    battleId: s.id,
    seed: s.seed,
    status: s.status,
    endReason: s.endReason,
    winner: s.winner,
    turn: s.turn,
    cycle: s.cycle,
    actionSeq: s.actionSeq,
    activeId: s.activeId,
    slotsPerSide: s.slotsPerSide,
    /** 行动顺序快照（第一个行动者） */
    openingOrder: order.slice(0, s.units.length),
    units: s.units.map((u) => ({
      uid: u.uid,
      cardId: u.cardId,
      side: u.side,
      slot: u.slot,
      hp: u.hp,
      state: u.state,
      buffs: structuredClone(u.buffs),
      damageDealt: u.damageDealt,
      damageTaken: u.damageTaken,
      killedBy: u.killedBy,
      invincible: u.invincible,
      runtimeInvincible: u.runtimeInvincible,
    })),
    actions: actions.map((a) => ({ ...a })),
    eventCount: s.events.length,
  };
}

/** 存档的基本校验 */
export function validateBattleSave(save) {
  const errors = [];
  if (!save || typeof save !== "object") return { ok: false, errors: ["存档必须是对象"] };
  if (save.schema !== SCHEMA_VERSION) errors.push(`schema 版本不支持：${save.schema}`);
  if (!Number.isInteger(save.seed)) errors.push("seed 必须是整数");
  if (!Array.isArray(save.units) || save.units.length === 0) errors.push("units 不能为空");
  if (!Array.isArray(save.actions)) errors.push("actions 必须是数组");
  for (const u of Array.isArray(save.units) ? save.units : []) {
    if (typeof u.cardId !== "string" || !u.cardId) errors.push("单位缺少 cardId");
    if (normalizeSlot(u.slot) === null) errors.push(`单位 ${u.cardId} 的 slot 无效`);
    if (!["ally", "enemy"].includes(u.side)) errors.push(`单位 ${u.cardId} 的 side 无效`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 读档：用内容注册表 + 存档里的种子重建战斗，然后按 actions 重放到同一时刻。
 * @returns {{battle: object, save: object, verified: boolean, mismatches: string[]}}
 */
export function restoreBattle(save, registry) {
  const check = validateBattleSave(save);
  if (!check.ok) throw new Error(`存档无效：${check.errors.join("；")}`);

  const battle = createBattle({
    registry,
    seed: save.seed,
    slotsPerSide: save.slotsPerSide,
    units: save.units.map((u) => ({ cardId: u.cardId, side: u.side, slot: u.slot })),
  });

  for (const action of save.actions) {
    if (battle.state.status !== "running") break;
    if (action.type === "skill") battle.useSkill(action.index, { targetRef: action.targetRef });
    else if (action.type === "end") battle.endTurn();
  }

  // 对账：重放后的战斗状态应与存档一致
  const replay = serializeBattle(battle, save.actions);
  const mismatches = [];
  const fields = ["turn", "actionSeq", "activeId", "status", "seed"];
  for (const f of fields) {
    if (replay[f] !== save[f]) mismatches.push(`${f}: 存档 ${save[f]} ≠ 重放 ${replay[f]}`);
  }
  for (const u of save.units) {
    const r = replay.units.find((x) => x.uid === u.uid);
    if (!r) {
      mismatches.push(`单位 ${u.uid} 在重放中不存在`);
      continue;
    }
    if (Math.abs(r.hp - u.hp) > 1e-6) mismatches.push(`单位 ${u.uid} 生命不符`);
    if (r.state !== u.state) mismatches.push(`单位 ${u.uid} 状态不符`);
  }

  return { battle, save, verified: mismatches.length === 0, mismatches, replay };
}

/* ------------------------------------------------------------------ */
/* 槽位                                                                */
/* ------------------------------------------------------------------ */

/** 内存存储（Node / 无 localStorage 环境） */
export function createMemoryDriver() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

/** localStorage 存储（浏览器） */
export function createLocalDriver(storage = globalThis.localStorage) {
  return {
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => storage.setItem(k, String(v)),
    removeItem: (k) => storage.removeItem(k),
  };
}

/**
 * 槽位管理器：save(slot, value) / load(slot) / clear(slot) / list()
 * value 总是 JSON 序列化的普通对象。
 */
export function createSaveStore(driver = createMemoryDriver()) {
  const prefix = (slot) => `caeworld:${slot}`;
  const metaKey = "caeworld:__slots__";
  const readSlots = () => {
    try {
      const raw = JSON.parse(driver.getItem(metaKey) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };
  const writeSlots = (list) => driver.setItem(metaKey, JSON.stringify([...new Set(list)]));

  return {
    save(slot, value) {
      if (!slot) throw new Error("槽位名不能为空");
      driver.setItem(prefix(slot), JSON.stringify(value));
      writeSlots([...readSlots(), slot]);
      return value;
    },
    load(slot) {
      const raw = driver.getItem(prefix(slot));
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    clear(slot) {
      driver.removeItem(prefix(slot));
      writeSlots(readSlots().filter((s) => s !== slot));
    },
    list() {
      return readSlots();
    },
    driver,
  };
}
