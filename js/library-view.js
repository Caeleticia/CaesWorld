/**
 * library-view.js —— 设计 / 卡牌库
 *
 * 汇总「默认包 + 已启用模组 + 编辑器工程」的单位 / 技能 / 效果，
 * 支持按卡包与关键字筛选；点开任意卡牌可以查看完整详情。
 */
import { loadContentPacks, DEFAULT_PACK_ID } from "./mods.js";
import {
  PLACEHOLDER_IMAGE,
  QUALITY_LABEL,
  EFFECT_POLARITY_LABEL,
  SKILL_TYPE_LABEL,
  buildFlowCatalog,
  normalizeEffectAttrBonus,
  effectColorOf,
  cardKindOf,
  resolveCardImage,
  resolveCardIcon,
} from "../engine/index.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const firstChar = (s) => [...String(s || "?")][0] || "?";

const FLOW_CATALOG = buildFlowCatalog();
const TRIGGER_LABEL = Object.fromEntries(FLOW_CATALOG.TRIGGER_EVENTS.map((t) => [t.value, t.label]));

/** 效果属性修正的显示名（与编辑器保持一致） */
const ATTR_BONUS_LABEL = {
  atkPct: "攻击力提升 %",
  atkFlat: "攻击力提升值",
  defPct: "防御力提升 %",
  defFlat: "防御力提升值",
  hpPct: "生命值提升 %",
  hpFlat: "生命值提升值",
  critRate: "暴击率",
  critDamage: "暴击伤害",
  speed: "速度",
  dmgBoostPct: "伤害提升 %",
  damageTakenPct: "受到伤害提升 %",
  vulnPct: "易伤 %",
  resistDownPct: "抗性降低 %",
  physical: "物理抗性",
  magic: "魔法抗性",
  spirit: "精神抗性",
  "attrDmgBoostPct.physical": "物理伤害提升 %",
  "attrDmgBoostPct.magic": "魔法伤害提升 %",
  "attrDmgBoostPct.spirit": "精神伤害提升 %",
  "attrPenPct.physical": "物理穿透 %",
  "attrPenPct.magic": "魔法穿透 %",
  "attrPenPct.spirit": "精神穿透 %",
};

/** 这些属性修正按百分比显示，其余按数值显示 */
const ATTR_BONUS_PERCENT = new Set([
  "atkPct",
  "defPct",
  "hpPct",
  "critRate",
  "critDamage",
  "dmgBoostPct",
  "damageTakenPct",
  "vulnPct",
  "resistDownPct",
  "physical",
  "magic",
  "spirit",
  "attrDmgBoostPct.physical",
  "attrDmgBoostPct.magic",
  "attrDmgBoostPct.spirit",
  "attrPenPct.physical",
  "attrPenPct.magic",
  "attrPenPct.spirit",
]);

let bound = false;
let page = null;
let data = null;
let tab = "units";
let pack = "all";
let search = "";
let loading = false;
/** 打开详情前的焦点，关闭时还原 */
let detailReturnFocus = null;

export async function initLibrary() {
  page = $("#library-page");
  if (!page) return;
  if (!bound) {
    bound = true;
    $("#library-back")?.addEventListener("click", () => {
      location.hash = "#menu";
    });
    $("#library-refresh")?.addEventListener("click", () => refresh());
    $("#library-pack")?.addEventListener("change", (e) => {
      pack = e.target.value || "all";
      render();
    });
    $("#library-search")?.addEventListener("input", (e) => {
      search = e.target.value.trim().toLowerCase();
      render();
    });
    $$(".sub-tab", page).forEach((btn) => {
      btn.addEventListener("click", () => {
        tab = btn.dataset.libTab || "units";
        $$(".sub-tab", page).forEach((b) => b.classList.toggle("is-active", b === btn));
        render();
      });
    });
    $("#library-list")?.addEventListener("click", onCardClick);
    $("#library-list")?.addEventListener("keydown", onCardKeydown);
    $("#library-detail")?.addEventListener("click", onDetailClick);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#library-detail")?.hidden) {
        e.preventDefault();
        closeDetail();
      }
    });
  }
  closeDetail({ restoreFocus: false });
  page.hidden = false;
  await refresh();
}

async function refresh() {
  if (loading) return;
  loading = true;
  setStatus("正在读取卡牌…");
  try {
    data = await loadContentPacks({ includeEditor: true });
    renderPackOptions();
    render();
    const errs = data.errors || [];
    const defaultLoaded = data.packs.some((p) => p.packId === DEFAULT_PACK_ID);
    const modCount = data.packs.filter(
      (p) => p.packId !== DEFAULT_PACK_ID && (p.source === "server" || p.source === "local")
    ).length;
    setStatus(
      `${defaultLoaded ? "默认包 + " : ""}${modCount} 个模组` +
        (errs.length ? ` · ${errs.length} 个读取问题` : "")
    );
    if (errs.length) console.warn("[卡牌库] 读取问题：", errs);
  } catch (err) {
    data = null;
    setStatus("读取失败：" + String((err && err.message) || err));
    render();
  } finally {
    loading = false;
  }
}

function setStatus(text) {
  const el = $("#library-status");
  if (el) el.textContent = text ? `· ${text}` : "";
}

function packOptions() {
  const map = new Map();
  for (const list of [data?.units || [], data?.skills || [], data?.effects || []]) {
    for (const card of list) {
      const id = card?.pack || "default";
      if (!map.has(id)) map.set(id, card?.packName || (id === "default" ? "默认包" : id));
    }
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function renderPackOptions() {
  const el = $("#library-pack");
  if (!el) return;
  const opts = packOptions();
  el.innerHTML =
    `<option value="all">全部卡包</option>` +
    opts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}（${escapeHtml(p.id)}）</option>`).join("");
  if (pack !== "all" && !opts.some((p) => p.id === pack)) pack = "all";
  el.value = pack;
}

function matches(card) {
  if (!card) return false;
  if (pack !== "all" && (card.pack || "default") !== pack) return false;
  if (!search) return true;
  return `${card.name || ""} ${card.id || ""} ${card.label || ""} ${card.description || ""}`
    .toLowerCase()
    .includes(search);
}

function cardAttrs(kind, card) {
  return `class="lib-card" role="button" tabindex="0" data-card-kind="${kind}" data-card-id="${escapeHtml(
    card.id
  )}" aria-label="查看${escapeHtml(card.name || card.id)}的详情"`;
}

function openHint() {
  return `<span class="lib-card-open" aria-hidden="true">详情 ›</span>`;
}

/** 技能 / 效果的小图标；没有图标时继续用首字字形 */
function iconCardArt(card, className = "lib-card-art") {
  const icon = resolveCardIcon(card);
  if (!icon) {
    return `<div class="${className} lib-card-glyph">${escapeHtml(firstChar(card.name || card.id))}</div>`;
  }
  return `<img class="${className} lib-card-icon" src="${icon}" alt="" loading="lazy" draggable="false"
    onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />`;
}

function unitCard(card) {
  const q = QUALITY_LABEL[card.quality] || card.quality || "白";
  return `
  <article ${cardAttrs("units", card)}>
    <img class="lib-card-art" src="${resolveCardImage(card)}" alt="" loading="lazy" draggable="false"
         onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
    <div class="lib-card-main">
      <div class="lib-card-head">
        <strong>${escapeHtml(card.name || card.id)}</strong>
        <span class="lib-card-pack">${escapeHtml(card.packName || card.pack || "默认包")}</span>
        ${openHint()}
      </div>
      <div class="lib-card-id">${escapeHtml(card.id)}</div>
      <div class="lib-card-meta">
        <span>品质 ${escapeHtml(q)}</span>
        <span>HP ${fmt(card.baseHp)}</span>
        <span>ATK ${fmt(card.baseAtk)}</span>
        <span>DEF ${fmt(card.baseDef)}</span>
        <span>技能 ${(card.skills || []).length}</span>
      </div>
      ${card.description ? `<p class="lib-card-desc">${escapeHtml(card.description)}</p>` : ""}
    </div>
  </article>`;
}

function skillCard(card) {
  const type = SKILL_TYPE_LABEL[card.type] || "主动";
  return `
  <article ${cardAttrs("skills", card)}>
    ${iconCardArt(card)}
    <div class="lib-card-main">
      <div class="lib-card-head">
        <strong>${escapeHtml(card.name || card.id)}</strong>
        <span class="lib-card-pack">${escapeHtml(card.packName || card.pack || "默认包")}</span>
        ${openHint()}
      </div>
      <div class="lib-card-id">${escapeHtml(card.id)}</div>
      <div class="lib-card-meta"><span>${escapeHtml(type)}</span><span>流程 ${card.flow?.nodes?.length || 0} 块</span></div>
      ${card.description ? `<p class="lib-card-desc">${escapeHtml(card.description)}</p>` : ""}
    </div>
  </article>`;
}

function effectCard(card) {
  const polarity = EFFECT_POLARITY_LABEL[card.polarity] || card.polarity || "正面";
  const stack = card.stackable ? `层数 ${Number(card.maxStacks) === 0 ? "无上限" : Number(card.maxStacks) || 1}` : "不叠层";
  return `
  <article ${cardAttrs("effects", card)}>
    ${iconCardArt(card)}
    <div class="lib-card-main">
      <div class="lib-card-head">
        <strong>${escapeHtml(card.name || card.id)}</strong>
        <span class="lib-card-pack">${escapeHtml(card.packName || card.pack || "默认包")}</span>
        ${openHint()}
      </div>
      <div class="lib-card-id">${escapeHtml(card.id)}</div>
      <div class="lib-card-meta">
        <span>${escapeHtml(polarity)}</span>
        <span>${escapeHtml(stack)}</span>
        ${card.bar ? `<span>条式${card.barInvert ? "·反转" : ""}</span>` : ""}
        <span>触发 ${(card.triggers || []).length}</span>
      </div>
      ${card.description ? `<p class="lib-card-desc">${escapeHtml(card.description)}</p>` : ""}
    </div>
  </article>`;
}

function render() {
  const list = $("#library-list");
  const count = $("#library-count");
  if (!list) return;
  if (!data) {
    list.innerHTML = `<p class="lib-empty">卡牌库尚未载入。</p>`;
    if (count) count.textContent = "0";
    return;
  }
  const source = tab === "skills" ? data.skills : tab === "effects" ? data.effects : data.units;
  const items = (source || []).filter(matches);
  if (count) count.textContent = `${items.length}`;
  if (!items.length) {
    list.innerHTML = `<p class="lib-empty">没有符合条件的${tab === "skills" ? "技能" : tab === "effects" ? "效果" : "单位"}。</p>`;
    return;
  }
  const renderCard = tab === "skills" ? skillCard : tab === "effects" ? effectCard : unitCard;
  list.innerHTML = items.map(renderCard).join("");
}

/* ---------------------------- 卡牌详情 ---------------------------- */
function onCardClick(e) {
  const cardEl = e.target.closest(".lib-card");
  if (!cardEl || !page?.contains(cardEl)) return;
  openDetail(cardEl.dataset.cardKind, cardEl.dataset.cardId);
}

function onCardKeydown(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const cardEl = e.target.closest(".lib-card");
  if (!cardEl || e.target !== cardEl) return;
  e.preventDefault();
  openDetail(cardEl.dataset.cardKind, cardEl.dataset.cardId);
}

function onDetailClick(e) {
  const modal = $("#library-detail");
  if (!modal || modal.hidden) return;
  if (e.target === modal || e.target.closest("[data-close-detail]")) {
    closeDetail();
    return;
  }
  const opener = e.target.closest("[data-open-kind]");
  if (opener) {
    e.preventDefault();
    openDetail(opener.dataset.openKind, opener.dataset.openId);
  }
}

function findCard(kind, id) {
  const list = kind === "skills" ? data?.skills : kind === "effects" ? data?.effects : data?.units;
  return (list || []).find((card) => card && card.id === id) || null;
}

function openDetail(kind, id) {
  const card = findCard(kind, id);
  const modal = $("#library-detail");
  const sheet = $("#library-detail-sheet");
  if (!card || !modal || !sheet) return;
  if (modal.hidden) detailReturnFocus = document.activeElement;
  sheet.innerHTML =
    kind === "skills" ? skillDetail(card) : kind === "effects" ? effectDetail(card) : unitDetail(card);
  modal.hidden = false;
  const body = sheet.querySelector(".lib-detail-body");
  if (body) body.scrollTop = 0;
  sheet.querySelector("[data-close-detail]")?.focus();
}

function closeDetail({ restoreFocus = true } = {}) {
  const modal = $("#library-detail");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  const sheet = $("#library-detail-sheet");
  if (sheet) sheet.innerHTML = "";
  if (restoreFocus && detailReturnFocus && detailReturnFocus.isConnected) {
    try {
      detailReturnFocus.focus();
    } catch {
      /* 元素已不可聚焦时忽略 */
    }
  }
  detailReturnFocus = null;
}

function detailHead(kicker, card, art, subline) {
  return `<header class="lib-detail-head">
    ${art}
    <div class="lib-detail-title">
      <span class="lib-detail-kicker">${escapeHtml(kicker)}</span>
      <h2 id="library-detail-title">${escapeHtml(card.name || card.id)}</h2>
      <p>${subline}</p>
      <code>${escapeHtml(card.id)}</code>
    </div>
    <button class="lib-detail-close" type="button" data-close-detail aria-label="关闭详情">×</button>
  </header>`;
}

function artFor(card) {
  if (cardKindOf(card) !== "unit") {
    const icon = resolveCardIcon(card);
    if (!icon) return glyphFor(card);
    return `<img class="lib-detail-art lib-detail-icon" src="${icon}" alt="" draggable="false"
      onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />`;
  }
  return `<img class="lib-detail-art" src="${resolveCardImage(card)}" alt="" draggable="false"
    onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />`;
}

function glyphFor(card) {
  return `<div class="lib-detail-art lib-detail-glyph" aria-hidden="true">${escapeHtml(
    firstChar(card.name || card.id)
  )}</div>`;
}

function statItem(label, value, wide = false) {
  return `<li${wide ? ' class="is-wide"' : ""}><span>${escapeHtml(label)}</span><b>${escapeHtml(
    value
  )}</b></li>`;
}

function unitChip(unit) {
  return `<button type="button" class="lib-detail-linkbtn" data-open-kind="units" data-open-id="${escapeHtml(
    unit.id
  )}">${escapeHtml(unit.name || unit.id)}</button>`;
}

function skillDetailItem(skill) {
  const type = SKILL_TYPE_LABEL[skill.type] || "主动";
  const icon = resolveCardIcon(skill);
  return `<button type="button" class="lib-detail-skill" data-open-kind="skills" data-open-id="${escapeHtml(
    skill.id
  )}">
    <span class="lib-detail-skill-head">
      ${
        icon
          ? `<img class="lib-detail-skill-icon" src="${escapeHtml(icon)}" alt="" draggable="false" />`
          : ""
      }
      <strong>${escapeHtml(skill.name || skill.id)}</strong>
      <em>${escapeHtml(type)}</em>
      <span>查看详情 ›</span>
    </span>
    <span class="lib-detail-skill-desc">${escapeHtml(skill.description || "暂无技能说明")}</span>
  </button>`;
}

function unitDetail(card) {
  const quality = QUALITY_LABEL[card.quality] || card.quality || "白";
  const res = card.resistances || {};
  const skillIds = card.skills || [];
  const skills = skillIds.map((id) => findCard("skills", id)).filter(Boolean);
  const missing = skillIds.length - skills.length;
  const members = (card.members || []).map((m) => m && m.effect).filter(Boolean);
  const intro = card.description
    ? `<p class="lib-detail-lore">${escapeHtml(card.description)}</p>`
    : `<p class="lib-detail-empty">这个角色还没有角色介绍。可在编辑器的「设计角色 → 角色介绍」里补充。</p>`;
  return `${detailHead(
    "单位 · 角色",
    card,
    artFor(card),
    `${escapeHtml(card.packName || card.pack || "默认包")} · ${escapeHtml(quality)} · Lv.${escapeHtml(card.level ?? 1)}`
  )}
  <div class="lib-detail-body">
    <section class="lib-detail-section">
      <h3>角色介绍</h3>
      ${intro}
      ${
        card.label
          ? `<div class="lib-detail-chips" style="margin-top:8px"><span class="lib-detail-chip">${escapeHtml(
              card.label
            )}</span></div>`
          : ""
      }
    </section>
    <section class="lib-detail-section">
      <h3>数值</h3>
      <ul class="lib-detail-stats">
        ${statItem("生命值", fmt(card.baseHp))}
        ${statItem("攻击力", fmt(card.baseAtk))}
        ${statItem("防御力", fmt(card.baseDef))}
        ${statItem("速度", fmt(card.speed))}
        ${statItem("暴击率", pct(card.critRate))}
        ${statItem("暴击伤害", pct(card.critDamage))}
        ${statItem(
          "抗性",
          `物理 ${pct(res.physical)} · 魔法 ${pct(res.magic)} · 精神 ${pct(res.spirit)}`,
          true
        )}
      </ul>
    </section>
    <section class="lib-detail-section">
      <h3>技能${skillIds.length ? `（${skillIds.length}）` : ""}</h3>
      ${
        skills.length
          ? `<div class="lib-detail-skill-list">${skills.map(skillDetailItem).join("")}</div>`
          : missing > 0
            ? ""
            : `<p class="lib-detail-empty">还没有挂载技能。</p>`
      }
      ${missing > 0 ? `<p class="lib-detail-empty">另有 ${missing} 个技能未在当前卡牌库中找到。</p>` : ""}
    </section>
    ${
      members.length
        ? `<section class="lib-detail-section">
            <h3>自带效果</h3>
            <div class="lib-detail-chips">${members
              .map((m) => `<span class="lib-detail-chip">${escapeHtml(m.name || m.id || "未命名效果")}</span>`)
              .join("")}</div>
          </section>`
        : ""
    }
  </div>`;
}

function triggerLabelsOfFlow(flow) {
  return ((flow && flow.nodes) || [])
    .filter((n) => n && n.type === "trigger")
    .map((n) => TRIGGER_LABEL[n.options?.event] || "未选择触发");
}

function flowSummary(flow) {
  const counts = new Map();
  for (const node of (flow && flow.nodes) || []) {
    if (!node || node.type === "trigger") continue;
    const title = FLOW_CATALOG.blocks[node.type]?.title || node.type || "积木";
    counts.set(title, (counts.get(title) || 0) + 1);
  }
  return [...counts.entries()].map(([title, n]) => (n > 1 ? `${title} ×${n}` : title)).join("、");
}

function skillDetail(card) {
  const type = SKILL_TYPE_LABEL[card.type] || "主动";
  const nodes = (card.flow && card.flow.nodes) || [];
  const triggers = triggerLabelsOfFlow(card.flow);
  const triggerText = triggers.length
    ? triggers.join("、")
    : card.type === "passive"
      ? "未设置触发（被动技能不会生效）"
      : "未设置触发（释放时执行默认流程）";
  const summary = flowSummary(card.flow);
  const hasActionBlock = nodes.some((n) => n && n.type !== "trigger");
  const related = (data?.units || []).filter((u) => (u.skills || []).includes(card.id));
  const relatedEffects = (data?.effects || []).filter((e) => (e.skillIds || []).includes(card.id));
  return `${detailHead(
    `技能 · ${type}`,
    card,
    artFor(card),
    `${escapeHtml(card.packName || card.pack || "默认包")} · 流程 ${nodes.length} 块`
  )}
  <div class="lib-detail-body">
    <section class="lib-detail-section">
      <h3>技能介绍</h3>
      ${
        card.description
          ? `<p class="lib-detail-lore">${escapeHtml(card.description)}</p>`
          : `<p class="lib-detail-empty">这个技能还没有说明。</p>`
      }
    </section>
    <section class="lib-detail-section">
      <h3>触发</h3>
      <div class="lib-detail-chips"><span class="lib-detail-chip">${escapeHtml(triggerText)}</span></div>
    </section>
    <section class="lib-detail-section">
      <h3>流程概要</h3>
      ${
        summary
          ? `<p class="lib-detail-lore">${escapeHtml(summary)}</p>`
          : `<p class="lib-detail-empty">${
              hasActionBlock ? "流程里还没有可展示的动作积木。" : nodes.length ? "流程里只有触发积木，还没有后续动作。" : "流程里还没有积木。"
            }</p>`
      }
    </section>
    <section class="lib-detail-section">
      <h3>关联角色</h3>
      ${
        related.length
          ? `<div class="lib-detail-chips">${related.map(unitChip).join("")}</div>`
          : `<p class="lib-detail-empty">还没有角色挂载这个技能。</p>`
      }
    </section>
    <section class="lib-detail-section">
      <h3>关联效果</h3>
      ${
        relatedEffects.length
          ? `<p class="lib-detail-empty">持有这些效果期间会临时获得该技能，效果移除后失去。</p>
             <div class="lib-detail-chips">${relatedEffects
               .map(
                 (eff) =>
                   `<button type="button" class="lib-detail-linkbtn" data-open-kind="effects" data-open-id="${escapeHtml(
                     eff.id
                   )}">${escapeHtml(eff.name || eff.id)}</button>`
               )
               .join("")}</div>`
          : `<p class="lib-detail-empty">还没有效果挂载这个技能。</p>`
      }
    </section>
  </div>`;
}

function bonusText(attr, value) {
  const n = Number(value) || 0;
  const text = ATTR_BONUS_PERCENT.has(attr) ? pct(n) : fmt(n);
  return `${n >= 0 ? "+" : ""}${text}`;
}

function effectDetail(card) {
  const polarity = EFFECT_POLARITY_LABEL[card.polarity] || card.polarity || "正面";
  const stackable = Boolean(card.stackable);
  const maxStacks = Number(card.maxStacks);
  const stack = stackable
    ? Number.isFinite(maxStacks) && maxStacks === 0
      ? "按层数叠加 · 无上限"
      : `按层数叠加 · 上限 ${Number.isFinite(maxStacks) ? maxStacks : 1} 层`
    : "不叠层";
  const unremovable = (card.flags || []).includes("unremovable") ? "不可解除" : "可解除";
  const consume = card.autoConsume ? "每次执行完效果流程后消耗 1 层（无视不可解除）" : "不会自动消耗";
  const display = card.bar
    ? `血条上方进度条${card.barInvert ? "（反转：显示 (上限-当前)/上限）" : "（当前/上限）"}`
    : "角色旁图标";
  const color = card.color ? card.color : `自动（${effectColorOf(card)}）`;
  const attrBonus = normalizeEffectAttrBonus(card.attrBonus);
  const triggers = (card.triggers || []).map((t) => TRIGGER_LABEL[t.event] || t.event || "未选择触发");
  const mountedSkillIds = Array.isArray(card.skillIds) ? card.skillIds : [];
  const mountedSkills = mountedSkillIds.map((id) => findCard("skills", id)).filter(Boolean);
  const missingSkills = mountedSkillIds.length - mountedSkills.length;
  return `${detailHead(
    `效果 · ${polarity}`,
    card,
    artFor(card),
    `${escapeHtml(card.packName || card.pack || "默认包")} · ${escapeHtml(stack)}`
  )}
  <div class="lib-detail-body">
    <section class="lib-detail-section">
      <h3>效果介绍</h3>
      ${
        card.description
          ? `<p class="lib-detail-lore">${escapeHtml(card.description)}</p>`
          : `<p class="lib-detail-empty">这个效果还没有说明。</p>`
      }
    </section>
    <section class="lib-detail-section">
      <h3>基本信息</h3>
      <ul class="lib-detail-stats">
        ${statItem("倾向", polarity)}
        ${statItem("层数", stack)}
        ${statItem("解除", unremovable)}
        ${statItem("显示", display, true)}
        ${statItem("颜色", color)}
        ${statItem("自动消耗", consume, true)}
      </ul>
    </section>
    <section class="lib-detail-section">
      <h3>挂载技能${mountedSkillIds.length ? `（${mountedSkillIds.length}）` : ""}</h3>
      ${
        mountedSkills.length
          ? `<p class="lib-detail-empty">持有该效果时临时获得；效果移除后失去。</p>
             <div class="lib-detail-skill-list">${mountedSkills.map(skillDetailItem).join("")}</div>`
          : missingSkills > 0
            ? ""
            : `<p class="lib-detail-empty">没有挂载技能。</p>`
      }
      ${missingSkills > 0 ? `<p class="lib-detail-empty">另有 ${missingSkills} 个技能未在当前卡牌库中找到。</p>` : ""}
    </section>
    <section class="lib-detail-section">
      <h3>属性修正</h3>
      ${
        attrBonus.length
          ? `<ul class="lib-detail-stats">${attrBonus
              .map((b) => statItem(ATTR_BONUS_LABEL[b.attr] || b.attr, bonusText(b.attr, b.value)))
              .join("")}</ul>`
          : `<p class="lib-detail-empty">没有属性修正。</p>`
      }
    </section>
    <section class="lib-detail-section">
      <h3>触发</h3>
      ${
        triggers.length
          ? `<div class="lib-detail-chips">${triggers
              .map((t) => `<span class="lib-detail-chip">${escapeHtml(t)}</span>`)
              .join("")}</div>`
          : `<p class="lib-detail-empty">没有配置触发。</p>`
      }
    </section>
  </div>`;
}

function fmt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function pct(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "0%";
  const percent = value * 100;
  const text = Math.abs(percent - Math.round(percent)) < 0.05 ? String(Math.round(percent)) : percent.toFixed(1);
  return `${text}%`;
}
