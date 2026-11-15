/**
 * battle-log-format.js —— 战斗记录的详细文本（训练场 / 同屏共用）
 *
 * 只负责把引擎事件翻译成人能读的战报行：
 *   · 技能 / 「选择单位」指定了谁；
 *   · 每次伤害的数值、属性、暴击、附加 / 本源、扣血前后；
 *   · 获得 / 失去效果、来源与层数；
 *   · 哪些效果 / 被动技能被什么事件触发。
 *
 * 名字与阵营优先从当前战斗里的单位取，效果 / 技能名从注册表取。
 */
import { ATTRIBUTE_INFO, buildFlowCatalog } from "../engine/index.js";

const FLOW_CATALOG = buildFlowCatalog();
const TRIGGER_LABEL = Object.fromEntries(
  (FLOW_CATALOG.TRIGGER_EVENTS || []).map((item) => [item.value, item.label])
);

const EFFECT_REMOVE_MODE = {
  specified: "指定效果",
  onePositive: "一个正面效果",
  oneNegative: "一个负面效果",
  allPositive: "全部正面效果",
  allNegative: "全部负面效果",
  all: "全部效果",
};

const DEFAULT_FMT = (n) => {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

/**
 * @param {object} opts
 * @param {object} opts.registry 内容注册表
 * @param {(uid: string) => object|null} opts.unitOf 当前战斗单位查询
 * @param {(side: string) => string} opts.sideName 阵营显示名（红方 / 蓝方）
 * @param {(n: number) => string} [opts.fmt] 数字格式化
 */
export function createBattleLogFormatter({ registry, unitOf, sideName, fmt = DEFAULT_FMT }) {
  const unit = (uid) => (uid ? unitOf(uid) : null);
  const nameOf = (uid) => {
    const u = unit(uid);
    return u ? u.name : String(uid || "?");
  };
  const tagged = (uid) => {
    const u = unit(uid);
    return u ? `[${sideName(u.side)}]${u.name}` : "?";
  };
  const skillName = (id) => {
    if (!id) return "?";
    return registry.getSkill(id)?.name || String(id);
  };
  const effectName = (id) => {
    if (!id) return "?";
    return registry.getEffect(id)?.name || String(id);
  };
  const attrLabel = (attr) => ATTRIBUTE_INFO[attr]?.label || attr || "物理";

  /** 伤害：谁打谁、最终伤害、属性 / 暴击 / 附加 / 本源、扣血前后、击杀 */
  function damage(ev) {
    const target = unit(ev.target);
    if (!target) return "";
    const from = unit(ev.attacker) ? tagged(ev.attacker) : "?";
    const to = tagged(ev.target);
    const amount = ev.aborted
      ? "0"
      : Number(ev.finalDamage) > 0
        ? fmt(ev.finalDamage)
        : ev.targetInvincible
          ? "无敌"
          : ev.immune
            ? "免疫"
            : "0";
    const tags = [];
    if (ev.aborted) tags.push("未结算");
    if (ev.crit) tags.push("暴击");
    if (ev.isAdditionalDamage) tags.push("附加");
    if (ev.isTrueDamage) tags.push("本源");
    if (!ev.isAdditionalDamage && !ev.isTrueDamage) tags.push(attrLabel(ev.attribute));
    if (ev.ignoreReduction && !ev.isTrueDamage && !ev.isAdditionalDamage) tags.push("无视减免");
    let hp = "";
    if (
      ev.hpBefore !== null &&
      ev.hpBefore !== undefined &&
      ev.hpAfter !== null &&
      ev.hpAfter !== undefined &&
      Number.isFinite(Number(ev.hpBefore)) &&
      Number.isFinite(Number(ev.hpAfter))
    ) {
      hp = `  HP ${fmt(ev.hpBefore)} → ${fmt(ev.hpAfter)}`;
    }
    const kill = Number(ev.hpBefore) > 0 && Number(ev.hpAfter) <= 0 ? " · 击杀" : "";
    return `${from} → ${to}  ${amount}（${tags.join(" · ")}）${hp}${kill}`;
  }

  /** 回复 / 被 setHp 改生命：回复量、来源、前后生命 */
  function heal(ev) {
    const u = unit(ev.unit);
    if (!u) return "";
    const amount = Number(ev.amount) || 0;
    const src = unit(ev.source);
    const srcText = src ? `（来源：${tagged(src.uid)}）` : "";
    const cause = ev.cause === "refuse-exit" ? "（拒绝退场）" : "";
    const hp =
      ev.hpBefore !== null &&
      ev.hpBefore !== undefined &&
      ev.hpAfter !== null &&
      ev.hpAfter !== undefined &&
      Number.isFinite(Number(ev.hpBefore)) &&
      Number.isFinite(Number(ev.hpAfter))
        ? `  HP ${fmt(ev.hpBefore)} → ${fmt(ev.hpAfter)}`
        : "";
    if (amount < 0) return `${u.name} 失去 ${fmt(-amount)} 生命${cause}${srcText}${hp}`;
    return `${u.name} 回复 ${fmt(amount)} 生命${cause}${srcText}${hp}`;
  }

  /** 技能施放：施放者、技能名、主目标（实际命中目标以「选择目标」和伤害行为准） */
  function skill(ev) {
    const caster = unit(ev.caster);
    const name = ev.skillName || skillName(ev.skillId);
    const target = unit(ev.target);
    return `${caster ? caster.name : "?"} 使用「${name}」${
      target ? ` · 主目标 ${tagged(target.uid)}` : ""
    }`;
  }

  /** 「选择单位」/ 自动索敌：谁、通过什么技能 / 效果、选了谁 */
  function target(ev) {
    const owner = unit(ev.owner);
    const list = (Array.isArray(ev.targets) ? ev.targets : []).map(tagged).filter(Boolean);
    if (!list.length) return "";
    const source = ev.effectId
      ? `效果「${effectName(ev.effectId)}」`
      : ev.skillId
        ? `技能「${skillName(ev.skillId)}」`
        : "";
    const who = owner ? `${owner.name} ` : "";
    const verb = ev.auto ? "自动锁定目标" : "选择目标";
    const meta = [];
    if (Number(ev.max) > 1) meta.push(`最多 ${Number(ev.max)} 个`);
    if (ev.required) meta.push("必须选满");
    return `${who}${source ? `${source} ` : ""}${verb}：${list.join("、")}${
      meta.length ? `（${meta.join(" / ")}）` : ""
    }`;
  }

  /** 效果 / 被动技能被事件触发 */
  function trigger(ev) {
    const owner = unit(ev.unit);
    const effect = ev.effectName || effectName(ev.effect);
    const kind =
      ev.source === "passive"
        ? "被动技能"
        : ev.source === "activeSkill"
          ? "技能"
          : ev.source === "member"
            ? "卡面效果"
            : "效果";
    const eventLabel =
      (TRIGGER_LABEL[ev.event] || ev.event || "事件") +
      (ev.event === "unitEnter" && ev.cause === "effect" ? "（获得新效果）" : "");
    const eventTargets = (Array.isArray(ev.targets) ? ev.targets : []).map(nameOf).filter(Boolean);
    const scope = unit(ev.scopeUnit);
    const broadcast = ev.broadcast
      ? `（广播：${String(ev.broadcast.id || "").trim() || "?"}${
          String(ev.broadcast.content || "").trim() ? ` / ${String(ev.broadcast.content).trim()}` : ""
        }）`
      : "";
    let text = `【触发】${owner ? owner.name : "?"} 的${kind}「${effect}」· ${eventLabel}`;
    if (eventTargets.length) text += `（事件目标：${eventTargets.join("、")}）`;
    if (scope && (!owner || scope.uid !== owner.uid)) text += ` · 触发单位：${scope.name}`;
    return text + broadcast;
  }

  /** 获得效果：层数、当前总层数、施加来源 */
  function effectAdded(ev) {
    const u = unit(ev.unit);
    if (!u) return "";
    const name = effectName(ev.effect);
    const rawGained = Number(ev.gained);
    const hasGained = ev.gained !== undefined && ev.gained !== null && Number.isFinite(rawGained);
    const layers = hasGained ? Math.max(0, Math.floor(rawGained)) : Math.max(1, Number(ev.layers) || 1);
    const stacks = Math.max(1, Number(ev.stacks) || layers);
    const src = unit(ev.source);
    let text = `${u.name} 获得「${name}」`;
    if (hasGained && layers === 0) {
      text += `（层数未增加${stacks > 1 ? `，当前 ${fmt(stacks)} 层` : ""}）`;
    } else if (layers > 1 && stacks > layers) text += ` ×${fmt(layers)}（当前 ${fmt(stacks)} 层）`;
    else if (layers > 1) text += ` ×${fmt(layers)}`;
    else if (stacks > 1) text += `（当前 ${fmt(stacks)} 层）`;
    if (src) text += `（来源：${tagged(src.uid)}）`;
    return text;
  }

  /** 失去效果：层数 / 移除范围 / 是否为触发消耗 */
  function effectRemoved(ev) {
    const u = unit(ev.unit);
    if (!u) return "";
    const id = ev.effectId || ev.effect;
    const layers = Math.max(1, Number(ev.layers) || 1);
    const reason = ev.reason === "auto-consume" ? "（触发消耗）" : "";
    if (id) {
      return `${u.name} 失去「${effectName(id)}」${layers > 1 ? ` ×${fmt(layers)}` : ""}${reason}`;
    }
    const mode = EFFECT_REMOVE_MODE[ev.mode] || "效果";
    return `${u.name} 移除${mode}${layers > 1 ? `（共 ${fmt(layers)} 层）` : ""}${reason}`;
  }

  /** 效果被免疫 */
  function effectImmune(ev) {
    const u = unit(ev.unit);
    if (!u) return "";
    const kind = ev.kind === "control" ? "控制效果" : "负面效果";
    return `${u.name} 免疫了「${effectName(ev.effect)}」（${kind}）`;
  }

  /** 旧 buff 系统：获得 / 到期 / 被驱散 */
  function buffAdded(ev) {
    const u = unit(ev.unit);
    if (!u) return "";
    const b = ev.buff || {};
    const duration =
      b.duration !== null && b.duration !== undefined && Number.isFinite(Number(b.duration))
        ? `（持续 ${fmt(b.duration)} 次行动）`
        : "";
    return `${u.name} 获得状态「${b.label || "效果"}」${duration}`;
  }

  function buffExpired(ev) {
    const u = unit(ev.unit);
    if (!u) return "";
    const list = Array.isArray(ev.buffList) ? ev.buffList : [];
    const names = list.map((b) => (typeof b === "string" ? b : b.label || b.uid)).filter(Boolean);
    return `${u.name} 的状态到期：${names.length ? names.join("、") : "1 个状态"}`;
  }

  function buffRemoved(ev) {
    const u = unit(ev.unit);
    if (!u) return "";
    const list = Array.isArray(ev.removedBuffs) ? ev.removedBuffs : [];
    const names = list.map((b) => (typeof b === "string" ? b : b.label || b.uid)).filter(Boolean);
    const tags = Array.isArray(ev.tags) && ev.tags.length ? `（标签：${ev.tags.join("、")}）` : "";
    return `${u.name} 移除了状态「${names.length ? names.join("、") : "1 个状态"}」${tags}`;
  }

  /** 「给予技能」积木 */
  function skillGranted(ev) {
    const u = unit(ev.unit);
    if (!u) return "";
    const stacks = Number(ev.stacks) || 1;
    return `${u.name} 获得技能「${skillName(ev.skillId)}」${stacks > 1 ? ` ×${fmt(stacks)}` : ""}`;
  }

  return {
    damage,
    heal,
    skill,
    target,
    trigger,
    effectAdded,
    effectRemoved,
    effectImmune,
    buffAdded,
    buffExpired,
    buffRemoved,
    skillGranted,
  };
}
