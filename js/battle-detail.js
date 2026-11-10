/**
 * battle-detail.js —— 战斗里的「角色详情」面板（训练场 / 同屏共用）
 *
 * 两种数据来源：
 *   · openUnit(uid)  场上的单位：实时面板、当前效果 / 增益、已挂载技能
 *   · openCard(card) 手牌 / 还没上场的卡：卡面基础数值与技能
 *
 * 详情里的技能可以点开看介绍；技能 / 效果介绍页可以返回角色。
 * 面板本身只读，不参与战斗结算。
 */
import {
  ATTRIBUTE_INFO,
  EFFECT_POLARITY_LABEL,
  QUALITY_LABEL,
  effectPolarityOf,
  resolveCardImage,
  resolveCardIcon,
  PLACEHOLDER_IMAGE,
} from "../engine/index.js";

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};
const pct = (v) => {
  const n = (Number(v) || 0) * 100;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
};
const firstChar = (s) => [...String(s || "?")][0] || "?";
const sideName = (side) => (side === "ally" ? "红方" : "蓝方");

function statRow(label, base, cur, { percent = false, wide = false, extra = "" } = {}) {
  const bonus = cur - base;
  const baseTxt = percent ? pct(base) : fmt(base);
  let bonusTxt = "";
  if (Math.abs(bonus) > 1e-9) {
    const sign = bonus > 0 ? "+" : "";
    const v = percent ? `${sign}${pct(bonus)}` : `${sign}${fmt(bonus)}`;
    bonusTxt = `<i class="plus ${bonus < 0 ? "is-neg" : ""}">${v}</i>`;
  }
  return `<li class="${wide ? "is-wide" : ""}"><span>${label}</span><b>${baseTxt}${bonusTxt}${
    extra ? `<em>${extra}</em>` : ""
  }</b></li>`;
}

function effectDesc(def) {
  if (!def) return "（效果不存在）";
  const auto = def.autoConsume ? "（自动消耗：每次执行完该效果的流程后消耗 1 层）" : "";
  const bar = def.bar ? `（条式显示${def.barInvert ? " · 反转条" : ""}）` : "";
  return (def.description || "（这个效果还没有填写描述）") + auto + bar;
}

function buffDesc(buff) {
  const label = {
    atkPct: "攻击力",
    defPct: "防御力",
    hpPct: "生命值",
    atkFlat: "攻击力",
    defFlat: "防御力",
    hpFlat: "生命值",
    critRate: "暴击率",
    critDamage: "暴击伤害",
    speed: "速度",
    dmgBoostPct: "伤害提升",
    resistDownPct: "抗性降低",
    damageTakenPct: "受到伤害提升",
    vulnPct: "易伤",
    atkMul: "攻击力倍率",
    defMul: "防御力倍率",
    hpMul: "生命值倍率",
    attrDmgBoostPct: "属性伤害提升",
    attrPenPct: "属性穿透",
  };
  const percentKey = /(Pct|Rate|critDamage|critRate)$/;
  const parts = [];
  for (const [key, val] of Object.entries(buff.def || {})) {
    const name = label[key] || key;
    if (typeof val === "number") {
      const v = Math.abs(val) < 1e-9 ? 0 : val;
      if (!v) continue;
      parts.push(
        percentKey.test(key) || key.endsWith("Mul")
          ? `${name} ${v > 0 ? "+" : ""}${pct(v)}`
          : `${name} ${v > 0 ? "+" : ""}${fmt(v)}`
      );
    } else if (val && typeof val === "object") {
      for (const [attr, n] of Object.entries(val)) {
        if (!n) continue;
        parts.push(`${ATTRIBUTE_INFO[attr]?.label || attr}${name} ${n > 0 ? "+" : ""}${pct(n)}`);
      }
    }
  }
  if (buff.duration !== null) parts.push(`持续 ${buff.duration} 次行动`);
  return parts.length ? parts.join(" · ") : "（没有数值加成）";
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container 详情容器（.tbt-modal）
 * @param {object} opts.battle 当前战斗
 * @param {object} opts.registry 内容注册表
 * @param {(open:boolean)=>void} [opts.onOpenChange] 打开 / 关闭时通知（用来停用底部按钮）
 */
export function createBattleDetail({ container, battle, registry, onOpenChange }) {
  if (!container) return { openUnit() {}, openCard() {}, close() {}, handleClick() {}, handleKey() {}, get open() { return false; } };

  /** 当前详情页：{ kind:"unit", uid } 或 { kind:"card", card, opts } */
  let view = null;
  /** 当前是否在技能 / 效果介绍页 */
  let intro = null;

  const notify = () => onOpenChange?.(!container.hidden);
  const unitOf = (uid) => battle?.state.units.find((u) => u.uid === uid) || null;
  const pubOf = (uid) => battle?.publicBattle().units.find((u) => u.uid === uid) || null;

  function collectUnitEffects(unit) {
    const effects = [];
    for (const layer of unit.effects || []) {
      const def = registry.getEffect(layer.id);
      // 效果层记录了施加者：详情里标出来，方便核对「施加者阵营」类效果按谁结算
      const srcUnit = layer.sourceId ? unitOf(layer.sourceId) : null;
      const srcTag = layer.sourceId ? `施加者：${srcUnit ? srcUnit.name : "已离场"}` : "";
      effects.push({
        key: `e:${layer.id}`,
        name: def?.name || layer.id,
        stacks: def?.stackable ? layer.stacks : null,
        desc: srcTag ? `${effectDesc(def)} · ${srcTag}` : effectDesc(def),
        icon: resolveCardIcon(def),
        polarity: effectPolarityOf(def),
        tag: layer.inheritedFrom ? "继承" : "",
        /** 效果挂载的技能：效果移除后会自动消失 */
        skillIds: Array.isArray(def?.skillIds) ? def.skillIds.slice() : [],
      });
    }
    for (const buff of unit.buffs || []) {
      effects.push({
        key: `b:${buff.uid}`,
        name: buff.label,
        stacks: null,
        desc: buffDesc(buff),
        polarity: null,
        tag: "增益",
      });
    }
    return effects;
  }

  function skillsOfView() {
    if (!view) return [];
    if (view.kind === "unit") {
      const unit = unitOf(view.uid);
      return unit ? battle.allSkillsOf(unit) : [];
    }
    return (view.card.skills || []).map((id) => registry.getSkill(id)).filter(Boolean);
  }

  function ownerName() {
    if (!view) return "";
    if (view.kind === "unit") return unitOf(view.uid)?.name || "";
    return view.card.name || view.card.id || "";
  }

  function ownerSideText() {
    if (!view) return "";
    if (view.kind === "unit") return sideName(unitOf(view.uid)?.side || "ally");
    return view.opts?.sideText || "";
  }

  function headerHtml(iconUrl, title, subtitle) {
    return `<header class="tbt-sheet-head">
      ${
        iconUrl
          ? `<img src="${escapeHtml(iconUrl)}" alt="" draggable="false"
               onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />`
          : `<div class="tbd-entry-glyph" aria-hidden="true">${escapeHtml(firstChar(title))}</div>`
      }
      <div class="tbt-sheet-title">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      <button class="tbt-close" type="button" data-close-detail aria-label="关闭">×</button>
    </header>`;
  }

  function renderUnit() {
    const unit = unitOf(view.uid);
    if (!unit) {
      close();
      return;
    }
    const card = unit.card || {};
    const stats = battle.statsOf(unit);
    const pub = pubOf(view.uid);
    const quality = QUALITY_LABEL[card.quality] || card.quality || "白";
    const status = pub?.acted ? "本回合已行动" : "本回合未行动";
    const invincible = unit.invincible || battle.state.invincibleSides.includes(unit.side);
    const effects = collectUnitEffects(unit);
    const resist = stats.resistances || {};
    const skills = skillsOfView();

    container.innerHTML = `
      <div class="tbt-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(unit.name)} 的数据">
        ${headerHtml(
          resolveCardImage(card),
          unit.name,
          `${sideName(unit.side)} · ${quality} · Lv.${card.level ?? 1} · ${status}${invincible ? " · 无敌" : ""}`
        )}
        <div class="tbt-sheet-body">
          ${
            card.description
              ? `<section class="tbd-section">
                  <h4>角色介绍</h4>
                  <p class="tbd-entry-desc">${escapeHtml(card.description)}</p>
                </section>`
              : ""
          }
          <section class="tbd-section">
            <h4>数值</h4>
            <ul class="tbd-stats">
              ${statRow("攻击力", card.baseAtk, stats.atk)}
              ${statRow("防御力", card.baseDef, stats.def)}
              ${statRow("生命值", card.baseHp, stats.hp, { wide: true, extra: `当前 ${Math.ceil(unit.hp)}` })}
              ${statRow("暴击率", card.critRate, stats.critRate, { percent: true })}
              ${statRow("暴击伤害", card.critDamage, stats.critDamage, { percent: true })}
              ${statRow("速度", card.speed, stats.speed)}
              <li class="is-wide"><span>抗性</span><b>物理 ${pct(resist.physical || 0)} · 魔法 ${pct(
                resist.magic || 0
              )} · 精神 ${pct(resist.spirit || 0)}</b></li>
            </ul>
          </section>
          <section class="tbd-section">
            <h4>效果${effects.length ? `（${effects.length}）` : ""}</h4>
            ${
              effects.length
                ? effects
                    .map(
                      (eff) => `
                <div class="tbd-eff" role="button" tabindex="0" data-effect-key="${escapeHtml(eff.key)}"
                     aria-label="查看效果 ${escapeHtml(eff.name)} 的介绍">
                  <div class="tbd-eff-head">
                    ${
                      eff.icon
                        ? `<img class="tbd-eff-icon" src="${escapeHtml(eff.icon)}" alt="" draggable="false" />`
                        : ""
                    }
                    <span>${escapeHtml(eff.name)}</span>
                    ${eff.stacks ? `<em>${eff.stacks} 层</em>` : ""}
                    ${
                      eff.polarity
                        ? `<em class="${
                            eff.polarity === "negative" ? "neg" : eff.polarity === "special" ? "special" : "pos"
                          }">${EFFECT_POLARITY_LABEL[eff.polarity]}</em>`
                        : ""
                    }
                    ${eff.tag ? `<em>${escapeHtml(eff.tag)}</em>` : ""}
                    <span class="tbd-entry-more" aria-hidden="true">介绍 ›</span>
                  </div>
                  <p>${escapeHtml(eff.desc)}</p>
                </div>`
                    )
                    .join("")
                : `<p class="tbd-empty">暂无效果。</p>`
            }
          </section>
          ${skillsHtml(skills)}
        </div>
      </div>`;
  }

  function renderCard() {
    const card = view.card;
    const quality = QUALITY_LABEL[card.quality] || card.quality || "白";
    const resist = card.resistances || {};
    const skills = skillsOfView();
    const sideText = view.opts?.sideText ? `${view.opts.sideText} · ` : "";
    container.innerHTML = `
      <div class="tbt-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(card.name || card.id)} 的详情">
        ${headerHtml(
          resolveCardImage(card),
          card.name || card.id,
          `${sideText}${quality} · Lv.${card.level ?? 1}${view.opts?.subtitle ? ` · ${view.opts.subtitle}` : ""}`
        )}
        <div class="tbt-sheet-body">
          ${
            card.description
              ? `<section class="tbd-section">
                  <h4>角色介绍</h4>
                  <p class="tbd-entry-desc">${escapeHtml(card.description)}</p>
                </section>`
              : ""
          }
          <section class="tbd-section">
            <h4>卡面数值</h4>
            <ul class="tbd-stats">
              ${statRow("攻击力", card.baseAtk, card.baseAtk)}
              ${statRow("防御力", card.baseDef, card.baseDef)}
              ${statRow("生命值", card.baseHp, card.baseHp, { wide: true })}
              ${statRow("暴击率", card.critRate, card.critRate, { percent: true })}
              ${statRow("暴击伤害", card.critDamage, card.critDamage, { percent: true })}
              ${statRow("速度", card.speed, card.speed)}
              <li class="is-wide"><span>抗性</span><b>物理 ${pct(resist.physical || 0)} · 魔法 ${pct(
                resist.magic || 0
              )} · 精神 ${pct(resist.spirit || 0)}</b></li>
            </ul>
          </section>
          ${skillsHtml(skills)}
          <p class="tbd-empty">效果 / 增益会在战斗中附加。</p>
        </div>
      </div>`;
  }

  function skillsHtml(skills) {
    return `<section class="tbd-section">
      <h4>技能</h4>
      ${
        skills.length
          ? `<div class="tbd-skills">${skills
              .map(
                (sk) =>
                  `<button type="button" class="tbd-skill" data-skill-id="${escapeHtml(sk.id)}"
                    aria-label="查看技能 ${escapeHtml(sk.name)} 的介绍">${
                      resolveCardIcon(sk)
                        ? `<img class="tbd-skill-icon" src="${escapeHtml(resolveCardIcon(sk))}" alt="" draggable="false" />`
                        : ""
                    }${escapeHtml(sk.name)}<em>${
                      sk.type === "active" ? "主动" : "被动"
                    }</em><span class="tbd-entry-more" aria-hidden="true">介绍 ›</span></button>`
              )
              .join("")}</div>`
          : `<p class="tbd-empty">没有技能。</p>`
      }
    </section>`;
  }

  function entrySheet({ glyph, icon, title, subtitle, body }) {
    return `<div class="tbt-sheet tbd-entry-sheet" role="dialog" aria-modal="true"
      aria-label="${escapeHtml(title)} 的介绍">
      <header class="tbt-sheet-head">
        ${
          icon
            ? `<img class="tbd-entry-glyph tbd-entry-icon" src="${escapeHtml(icon)}" alt="" draggable="false" />`
            : `<div class="tbd-entry-glyph" aria-hidden="true">${escapeHtml(glyph)}</div>`
        }
        <div class="tbt-sheet-title">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(subtitle)}</p>
        </div>
        <button class="tbt-close" type="button" data-close-detail aria-label="关闭">×</button>
      </header>
      <div class="tbt-sheet-body">
        <button class="tbd-back" type="button" data-back-detail>← 返回角色</button>
        ${body}
      </div>
    </div>`;
  }

  function renderSkillIntro(skill) {
    const type = skill.type === "active" ? "主动技能" : "被动技能";
    const nodes = Array.isArray(skill.flow?.nodes) ? skill.flow.nodes.length : 0;
    container.innerHTML = entrySheet({
      glyph: "技",
      icon: resolveCardIcon(skill),
      title: skill.name,
      subtitle: [type, nodes ? `流程 ${nodes} 块` : "", ownerName()].filter(Boolean).join(" · "),
      body: `<section class="tbd-section">
        <h4>技能介绍</h4>
        <p class="tbd-entry-desc">${escapeHtml(skill.description || "这个技能还没有填写介绍。")}</p>
      </section>`,
    });
  }

  function renderEffectIntro(eff) {
    const unit = view.kind === "unit" ? unitOf(view.uid) : null;
    const meta = [
      eff.polarity ? EFFECT_POLARITY_LABEL[eff.polarity] : "",
      eff.tag || "",
      eff.stacks ? `${eff.stacks} 层` : "",
    ].filter(Boolean);
    container.innerHTML = entrySheet({
      glyph: "效",
      icon: eff.icon,
      title: eff.name,
      subtitle: [...meta, unit?.name || ownerName()].filter(Boolean).join(" · "),
      body: `<section class="tbd-section">
        <h4>效果介绍</h4>
        <p class="tbd-entry-desc">${escapeHtml(eff.desc)}</p>
      </section>
      ${(() => {
        const mounted = (eff.skillIds || []).map((id) => registry.getSkill(id)).filter(Boolean);
        if (!mounted.length) return "";
        return `<section class="tbd-section">
          <h4>效果挂载技能</h4>
          <p class="tbd-entry-desc">持有该效果期间临时获得；效果移除后失去。</p>
          <div class="tbd-skills">${mounted
            .map(
              (sk) =>
                `<button type="button" class="tbd-skill" data-skill-id="${escapeHtml(sk.id)}"
                  aria-label="查看技能 ${escapeHtml(sk.name)} 的介绍">${
                    resolveCardIcon(sk)
                      ? `<img class="tbd-skill-icon" src="${escapeHtml(resolveCardIcon(sk))}" alt="" draggable="false" />`
                      : ""
                  }${escapeHtml(sk.name)}<em>${sk.type === "active" ? "主动" : "被动"}</em><span class="tbd-entry-more" aria-hidden="true">介绍 ›</span></button>`
            )
            .join("")}</div>
        </section>`;
      })()}`,
    });
  }

  function show() {
    container.hidden = false;
    notify();
  }

  function close() {
    if (container.hidden) return;
    container.hidden = true;
    view = null;
    intro = null;
    notify();
  }

  function openUnit(uid) {
    const unit = unitOf(uid);
    if (!unit) return;
    view = { kind: "unit", uid };
    intro = null;
    renderUnit();
    show();
  }

  function openCard(card, opts = {}) {
    if (!card) return;
    view = { kind: "card", card, opts };
    intro = null;
    renderCard();
    show();
  }

  function openSkillIntro(skill) {
    if (!skill) return;
    intro = { kind: "skill", skill };
    renderSkillIntro(skill);
    show();
    container.querySelector("[data-back-detail]")?.focus?.();
  }

  function openEffectIntro(eff) {
    if (!eff) return;
    intro = { kind: "effect", eff };
    renderEffectIntro(eff);
    show();
    container.querySelector("[data-back-detail]")?.focus?.();
  }

  function backToDetail() {
    intro = null;
    if (!view) return;
    if (view.kind === "unit") renderUnit();
    else renderCard();
  }

  function handleClick(event) {
    if (container.hidden) return;
    if (event.target === container || event.target.closest("[data-close-detail]")) {
      close();
      return;
    }
    if (event.target.closest("[data-back-detail]")) {
      backToDetail();
      return;
    }
    const skillBtn = event.target.closest("[data-skill-id]");
    if (skillBtn) {
      const skill = skillsOfView().find((sk) => sk.id === skillBtn.dataset.skillId);
      if (skill) openSkillIntro(skill);
      return;
    }
    const effBtn = event.target.closest("[data-effect-key]");
    if (effBtn && view?.kind === "unit") {
      const unit = unitOf(view.uid);
      const eff = unit ? collectUnitEffects(unit).find((item) => item.key === effBtn.dataset.effectKey) : null;
      if (eff) openEffectIntro(eff);
    }
  }

  function handleKey(event) {
    if (container.hidden) return false;
    if (event.key === "Escape") {
      if (intro) backToDetail();
      else close();
      return true;
    }
    if ((event.key === "Enter" || event.key === " ") && event.target.closest?.("[data-effect-key]")) {
      event.preventDefault();
      handleClick(event);
      return true;
    }
    return false;
  }

  return {
    openUnit,
    openCard,
    close,
    handleClick,
    handleKey,
    get open() {
      return !container.hidden;
    },
    get view() {
      return view;
    },
  };
}
