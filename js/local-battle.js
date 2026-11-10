/**
 * local-battle.js —— 游玩 / 同屏：战斗界面
 *
 * 战斗逻辑在 engine/battle.js 的 local 模式：
 *   · 初始抽牌进手牌，双方依次布阵（至少 1 个，最多场上上限）
 *   · 场上单位少于上限时，点虚线格从手牌补上场
 *   · 每经过设定回合，双方交替补牌（牌背 → 翻面 → 飞入手牌按钮）
 *   · 场上全灭但还有手牌时，立刻要求补上场；手上没有牌则失败
 *
 * 本文件只负责表现与交互：卡牌、手牌、布阵、补牌动画、行动栏、特效。
 */
import {
  createBattle,
  BATTLE_MODE,
  ATTRIBUTE_INFO,
  EFFECT_POLARITY_LABEL,
  QUALITY_LABEL,
  effectPolarityOf,
  effectColorOf,
  parseEffectColor,
  resolveCardImage,
  resolveCardIcon,
  cardImagePath,
  PLACEHOLDER_IMAGE,
  skillNeedsPlayerTarget,
} from "../engine/index.js";
import { createStageScaler, STAGE_DESIGN } from "./training-stage.js";
import { BattleFX } from "./battle-fx.js";
import { chooseAISkill, chooseBestDeployCard } from "./battle-ai.js";
import { createBattleDetail } from "./battle-detail.js";

const $ = (sel, root = document) => root.querySelector(sel);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};
const firstChar = (s) => [...String(s || "?")][0] || "?";
const sideName = (side) => (side === "ally" ? "红方" : "蓝方");
const sideKey = (side) => (side === "ally" ? "red" : "blue");
const otherSide = (side) => (side === "ally" ? "enemy" : "ally");

let current = null;

/**
 * @param {object} opts
 * @param {object} opts.registry
 * @param {object} opts.config { maxUnits, initialHand, refillEnabled, refillEvery, refillCount, allowSameName, redAI, blueAI, red:[], blue:[] }
 * @param {function} [opts.onExit]
 */
export function openLocalBattle({ registry, config, onExit }) {
  if (current) current.stop();
  const page = $("#play-battle-page");
  const stage = $("#pb-stage");
  if (!page || !stage) throw new Error("同屏战斗页面不存在");
  if (!registry) throw new Error("没有可用的内容注册表");
  if (!config || !config.red?.length || !config.blue?.length) throw new Error("双方卡组都不能为空");

  const s = {
    registry,
    config,
    onExit,
    page,
    stage,
    scaler: null,
    fx: null,
    battle: null,
    capture: null,
    destroyed: false,
    busy: true,
    pending: null,
    preferredTargets: [],
    timers: new Set(),
    sleepers: new Map(),
    displayHp: new Map(),
    cardEls: new Map(),
    log: [],
    statusSig: new Map(),
    effectBarSig: new Map(),
    resultShown: false,
    aiStalled: false,
    /** 已经结算但还没播完退场动画的单位：刷新时先留在场上，避免「附加伤害击杀时角色突然消失」 */
    deathPending: new Set(),
    handSide: null,
    handRequired: false,
    refillBusy: false,
  };

  page.hidden = false;
  page.classList.remove("is-opening");
  void page.offsetWidth;
  page.classList.add("is-opening");

  const refs = {
    redGrid: $("#pb-red-grid"),
    blueGrid: $("#pb-blue-grid"),
    redDeck: $("#pb-red-deck"),
    blueDeck: $("#pb-blue-deck"),
    redBadge: $("#pb-red-badge"),
    blueBadge: $("#pb-blue-badge"),
    round: $("#pb-round"),
    status: $("#pb-status"),
    turn: $("#pb-turn"),
    turnSide: $("#pb-turn-side"),
    turnHint: $("#pb-turn-hint"),
    log: $("#pb-log"),
    actions: $("#pb-actions"),
    result: $("#pb-result"),
    detail: $("#pb-detail"),
    canvas: $("#pb-fx"),
    redHand: $("#pb-red-hand"),
    blueHand: $("#pb-blue-hand"),
    handOverlay: $("#pb-hand-overlay"),
    handTitle: $("#pb-hand-title"),
    handHint: $("#pb-hand-hint"),
    handCards: $("#pb-hand-cards"),
    handClose: $("#pb-hand-close"),
    handDone: $("#pb-hand-done"),
    refillLayer: $("#pb-refill-layer"),
    toast: $("#pb-toast"),
  };

  /** 定位/尺寸：卡牌在舞台里的坐标（设计 px，不含缩放） */
  const rectOf = (uid) => {
    const wrap = s.cardEls.get(uid);
    if (!wrap) return null;
    const sp = s.stage.getBoundingClientRect();
    const r = wrap.getBoundingClientRect();
    const k = s.scaler?.scale || 1;
    return { x: (r.left - sp.left) / k, y: (r.top - sp.top) / k, w: r.width / k, h: r.height / k };
  };

  const unitOf = (uid) => s.battle?.state.units.find((u) => u.uid === uid) || null;
  const pubOf = (uid) => s.battle?.publicBattle().units.find((u) => u.uid === uid) || null;
  const activeUnit = () => s.battle?.active() || null;
  const isHumanSide = (side) => !(side === "ally" ? s.config.redAI : s.config.blueAI);

  /* ---------------- 舞台 / 画布 ---------------- */
  s.scaler = createStageScaler(page, stage, () => {
    const d = STAGE_DESIGN[s.scaler?.orient || "landscape"];
    const ratio = (window.devicePixelRatio || 1) * (s.scaler?.scale || 1);
    s.fx?.resize(d.w, d.h, ratio);
    if (s.battle && !s.destroyed) {
      syncUnits();
      renderActions();
      updateHeader();
    }
  });
  const design = STAGE_DESIGN[s.scaler.orient];
  s.fx = new BattleFX(refs.canvas);
  s.fx.resize(design.w, design.h, (window.devicePixelRatio || 1) * s.scaler.scale);

  /* ---------------- 建战斗（先收初始事件） ---------------- */
  s.capture = [];
  try {
    s.battle = createBattle({
      registry,
      mode: BATTLE_MODE.LOCAL,
      decks: { ally: config.red.slice(), enemy: config.blue.slice() },
      slotsPerSide: config.maxUnits,
      maxUnits: config.maxUnits,
      maxCycles: 60,
      firstSide: "ally",
      seed: (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0,
      initialHand: config.initialHand,
      refillEnabled: Boolean(config.refillEnabled),
      refillEvery: config.refillEvery,
      refillCount: config.refillCount,
      allowSameName: Boolean(config.allowSameName),
      chooseTargets: ({ candidates, multiple }) => {
        const list = candidates || [];
        if (!list.length) return null;
        const preferred = (s.preferredTargets || []).filter((uid) => list.some((c) => c.uid === uid));
        const picked = preferred.length ? preferred : list;
        return multiple ? picked : picked[0];
      },
      onEvent: (ev) => {
        if (s.capture) s.capture.push(ev);
      },
    });
  } catch (err) {
    const initial = s.capture;
    s.capture = null;
    s.fx.destroy();
    s.scaler.destroy();
    page.hidden = true;
    throw err;
  }
  const initialEvents = s.capture || [];
  s.capture = null;

  /* ---------------- 角色详情 ---------------- */
  const setHandButtonsVisible = (visible) => {
    if (refs.redHand) refs.redHand.hidden = !visible;
    if (refs.blueHand) refs.blueHand.hidden = !visible;
  };
  const updateHandButtonsVisible = () => {
    const blocked =
      detail?.open ||
      Boolean(refs.handOverlay && !refs.handOverlay.hidden) ||
      Boolean(refs.result && !refs.result.hidden);
    setHandButtonsVisible(!blocked);
  };
  const detail = createBattleDetail({
    container: refs.detail,
    battle: s.battle,
    registry,
    onOpenChange: () => {
      updateHandButtonsVisible();
      renderHand();
    },
  });

  /* ---------------- 生命周期 ---------------- */
  const sleep = (ms) => {
    if (s.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        s.timers.delete(t);
        s.sleepers.delete(t);
        resolve();
      }, ms);
      s.timers.add(t);
      s.sleepers.set(t, resolve);
    });
  };
  const clearTimers = () => {
    for (const t of s.timers) clearTimeout(t);
    s.timers.clear();
    for (const resolve of s.sleepers.values()) resolve();
    s.sleepers.clear();
  };
  const stop = () => {
    if (s.destroyed) return;
    s.destroyed = true;
    clearTimers();
    detail?.close();
    s.deathPending.clear();
    s.fx?.destroy();
    s.scaler?.destroy();
    window.removeEventListener("hashchange", onHash);
    window.removeEventListener("keydown", onKey);
    if (refs.handOverlay) refs.handOverlay.hidden = true;
    if (refs.result) refs.result.hidden = true;
    if (refs.toast) refs.toast.hidden = true;
    if (refs.refillLayer) refs.refillLayer.innerHTML = "";
    if (current === session) current = null;
  };
  const closeToConfig = () => {
    stop();
    page.hidden = true;
    page.classList.remove("is-opening");
    if (typeof onExit === "function") onExit();
  };
  const restart = () => {
    stop();
    page.classList.remove("is-opening");
    openLocalBattle({ registry, config, onExit });
  };
  const onHash = () => {
    if (location.hash !== "#play") {
      stop();
      page.hidden = true;
      page.classList.remove("is-opening");
    }
  };
  const session = { stop, close: closeToConfig, get battle() { return s.battle; } };
  current = session;

  window.addEventListener("hashchange", onHash);
  const pbBack = $("#pb-back");
  if (pbBack) pbBack.onclick = closeToConfig;

  function onKey(e) {
    if (detail?.handleKey(e)) return;
    if (e.key !== "Escape") return;
    if (refs.handOverlay && !refs.handOverlay.hidden) {
      if (!s.handRequired) closeHand();
      return;
    }
    if (refs.result && !refs.result.hidden) return;
    closeToConfig();
  }
  window.addEventListener("keydown", onKey);

  /* ---------------- 捕获一段同步事件 ---------------- */
  const take = (fn) => {
    s.capture = [];
    let out;
    try {
      fn();
    } finally {
      out = s.capture;
      s.capture = null;
    }
    return out || [];
  };

  /* ---------------- 卡牌 ---------------- */
  const canPickUnit = (pub) => {
    const pb = s.battle.publicBattle();
    if (s.busy || pb.status !== "running") return false;
    if (!isHumanSide(pub.side) || pub.side !== pb.sideTurn || pub.acted || pub.state !== "alive") return false;
    if (pb.phase === "select") return true;
    if (pb.phase === "act" && !s.pending && !pb.actionUsed) return pb.activeId !== pub.uid;
    return false;
  };

  const createCard = (pub) => {
    const unit = unitOf(pub.uid);
    const card = unit?.card || {};
    const wrap = document.createElement("div");
    wrap.className = "tbt-unit";
    wrap.dataset.uid = pub.uid;
    wrap.dataset.side = pub.side;
    const hasArt = Boolean(cardImagePath(card));
    wrap.innerHTML = `
      <button class="tbt-card" type="button" data-uid="${escapeHtml(pub.uid)}" data-quality="${escapeHtml(card.quality || "white")}"
              data-no-art="${hasArt ? "0" : "1"}">
        <img class="tbt-card-img" src="${resolveCardImage(card)}" alt="" draggable="false"
             onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}';var c=this.closest('.tbt-card');if(c)c.setAttribute('data-no-art','1')" />
        <span class="tbt-card-monogram" aria-hidden="true">${escapeHtml(firstChar(pub.name))}</span>
        <span class="tbt-card-shade"></span>
        <span class="tbt-card-name"></span>
        <span class="tbt-card-lv"></span>
        <span class="tbt-card-atk"></span>
        <span class="tbt-card-effectbars" hidden></span>
        <span class="tbt-card-hpbar"><i></i></span>
        <span class="tbt-card-hptext"></span>
      </button>
      <div class="tbt-statuses"></div>`;
    return wrap;
  };

  const updateCard = (wrap, pub) => {
    const unit = unitOf(pub.uid);
    if (!unit) return;
    const card = unit.card || {};
    const hp = s.displayHp.get(pub.uid);
    const max = Math.max(1, pub.hpMax);
    const cur = clamp(hp === undefined ? pub.hp : hp, 0, max);
    const ratio = clamp(cur / max, 0, 1);

    const nameEl = wrap.querySelector(".tbt-card-name");
    if (nameEl) nameEl.textContent = pub.name;
    const lvEl = wrap.querySelector(".tbt-card-lv");
    if (lvEl) lvEl.textContent = `Lv.${card.level ?? 1}`;
    const atkEl = wrap.querySelector(".tbt-card-atk");
    if (atkEl) atkEl.textContent = `ATK ${fmt(pub.atk)}`;
    const bar = wrap.querySelector(".tbt-card-hpbar i");
    if (bar) {
      bar.style.width = `${ratio * 100}%`;
      bar.classList.toggle("is-mid", ratio <= 0.5 && ratio > 0.25);
      bar.classList.toggle("is-low", ratio <= 0.25);
      bar.classList.toggle("is-invincible", pub.invincible);
    }
    const hpText = wrap.querySelector(".tbt-card-hptext");
    if (hpText) hpText.textContent = `${Math.ceil(cur)} / ${Math.ceil(max)}`;

    wrap.classList.toggle("is-acted", Boolean(pub.acted));
    wrap.classList.toggle("is-active", s.battle.state.activeId === pub.uid);
    wrap.classList.toggle("is-selectable", canPickUnit(pub));
    wrap.classList.toggle("is-invincible", Boolean(pub.invincible));
    const active = activeUnit();
    const targetable =
      !s.busy && s.pending && active && pub.side !== active.side && pub.state === "alive";
    wrap.classList.toggle("is-targetable", Boolean(targetable));
    const pb = s.battle.publicBattle();
    const fieldDup =
      !s.config.allowSameName &&
      pb.units.some(
        (x) => x.uid !== pub.uid && x.side === pub.side && x.state === "alive" && x.name === pub.name
      );
    const handDup =
      !s.config.allowSameName &&
      (pb.hand?.[pub.side] || []).some((id) => {
        const card = s.registry.getUnit(id);
        return card && (card.name || card.id) === pub.name;
      });
    wrap.classList.toggle("is-dup", Boolean(fieldDup || handDup));

    const statuses = statusesOf(unit);
    const sig = statuses.map((x) => `${x.key}:${x.title}`).join("|");
    if (s.statusSig.get(pub.uid) !== sig) {
      s.statusSig.set(pub.uid, sig);
      const box = wrap.querySelector(".tbt-statuses");
      if (box) {
        box.innerHTML = statuses
          .slice(0, 5)
          .map((st) => {
            const style = st.color
              ? ` style="background:${escapeHtml(st.color)};border-color:${escapeHtml(st.color)};color:${escapeHtml(st.textColor)}"`
              : "";
            return `<button class="tbt-status-ico ${st.cls}" type="button" data-status-uid="${escapeHtml(pub.uid)}" title="${escapeHtml(st.title)}"${style}>${escapeHtml(st.glyph)}${
              st.count ? `<span class="tbt-status-count" aria-hidden="true">${escapeHtml(String(st.count))}</span>` : ""
            }</button>`;
          })
          .join("");
      }
    }

    const bars = effectBarsOf(unit);
    const barSig = bars.map((b) => `${b.key}:${b.current}/${b.max}:${b.ratio}:${b.color}:${b.inverted}`).join("|");
    if (s.effectBarSig.get(pub.uid) !== barSig) {
      s.effectBarSig.set(pub.uid, barSig);
      const box = wrap.querySelector(".tbt-card-effectbars");
      if (box) {
        box.hidden = bars.length === 0;
        box.innerHTML = bars
          .map(
            (b) => `<span class="tbt-card-effectbar" title="${escapeHtml(b.title)}" aria-label="${escapeHtml(b.title)}">
              <span class="tbt-card-effectbar-glyph">${escapeHtml(b.glyph)}</span>
              <span class="tbt-card-effectbar-track">
                <i style="width:${(b.ratio * 100).toFixed(2)}%;background:${escapeHtml(b.color)}"></i>
                <span class="tbt-card-effectbar-num">${b.shown}/${b.max}</span>
              </span>
            </span>`
          )
          .join("");
      }
    }
  };

  function statusesOf(unit) {
    const out = [];
    if (unit.invincible || s.battle.state.invincibleSides.includes(unit.side)) {
      out.push({ key: "inv", glyph: "无", cls: "is-invincible", title: "无敌" });
    }
    for (const layer of unit.effects || []) {
      const def = s.registry.getEffect(layer.id);
      if (def && def.bar) continue;
      const polarity = effectPolarityOf(def);
      const custom = parseEffectColor(def?.color);
      out.push({
        key: `e:${layer.id}`,
        glyph: firstChar(def?.name || layer.id),
        cls: polarity === "negative" ? "is-bad" : polarity === "special" ? "is-special" : "is-good",
        color: custom || "",
        textColor: custom ? "#fff" : "",
        // 叠加类效果在图标右下角圆圈里标层数
        count: def?.stackable ? Math.max(1, Math.floor(Number(layer.stacks) || 1)) : 0,
        title: `${def?.name || layer.id}${def?.stackable ? ` ${layer.stacks} 层` : ""} · ${EFFECT_POLARITY_LABEL[polarity]}`,
      });
    }
    for (const buff of unit.buffs || []) {
      out.push({
        key: `b:${buff.uid}`,
        glyph: firstChar(buff.label),
        cls: "is-buff",
        title: `${buff.label}${buff.duration !== null ? ` · ${buff.duration} 次行动` : ""}`,
      });
    }
    return out;
  }

  function effectBarsOf(unit) {
    const out = [];
    for (const layer of unit.effects || []) {
      const def = s.registry.getEffect(layer.id);
      if (!def || !def.bar) continue;
      const max = Math.max(1, Math.floor(Number(def.maxStacks) || 1));
      const cur = clamp(Math.floor(Number(layer.stacks) || 0), 0, max);
      const inverted = Boolean(def.barInvert);
      const shown = inverted ? max - cur : cur;
      out.push({
        key: `e:${layer.id}`,
        glyph: firstChar(def.name || layer.id),
        current: cur,
        shown,
        max,
        ratio: shown / max,
        inverted,
        color: effectColorOf(def),
        title: `${def.name || layer.id} ${shown}/${max}${inverted ? ` · 反转（当前 ${cur}/${max}）` : ""}`,
      });
    }
    return out;
  }

  /* ---------------- 布局 / 同步 ---------------- */
  const layoutZone = (side) => {
    const grid = side === "ally" ? refs.redGrid : refs.blueGrid;
    if (!grid) return;
    const n = grid.children.length;
    if (!n) return;
    const W = grid.clientWidth;
    const H = grid.clientHeight;
    if (!W || !H) return;
    const gap = 20;
    const extra = 18;
    const sizeFor = (count) => {
      let best = { cols: 1, w: 60 };
      for (let cols = 1; cols <= count; cols += 1) {
        const rows = Math.ceil(count / cols);
        const cellW = (W - gap * (cols - 1)) / cols;
        const cardH = (H - gap * (rows - 1)) / rows;
        const w = Math.min(cellW - extra, cardH * 0.75, 168);
        if (w > best.w) best = { cols, w };
      }
      return best;
    };
    const layout = sizeFor(n);
    const cap = sizeFor(4);
    const cardW = Math.min(layout.w, cap.w);
    grid.style.setProperty("--cols", String(layout.cols));
    grid.style.setProperty("--card-w", `${Math.max(46, Math.floor(cardW))}px`);
  };

  const createDeploySlot = (side) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lbt-slot";
    btn.dataset.deploySide = side;
    btn.innerHTML = `<span class="lbt-slot-plus" aria-hidden="true">＋</span><span>补上场</span>`;
    btn.title = `${sideName(side)}：从手牌上场`;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const pb = s.battle.publicBattle();
      openHand(side, { required: pb.localDeploy?.side === side && pb.phase === "deploy" });
    });
    return btn;
  };

  function syncUnits() {
    if (s.destroyed || !s.battle) return;
    const pb = s.battle.publicBattle();
    const alive = pb.units.filter((u) => u.state === "alive" || s.deathPending.has(u.uid));
    for (const side of ["ally", "enemy"]) {
      const grid = side === "ally" ? refs.redGrid : refs.blueGrid;
      if (!grid) continue;
      const list = alive
        .filter((u) => u.side === side)
        .sort((a, b) => Math.abs(a.slot) - Math.abs(b.slot) || (a.uid < b.uid ? -1 : 1));
      const wanted = new Set(list.map((u) => u.uid));
      for (const [uid, wrap] of [...s.cardEls]) {
        if (wanted.has(uid)) continue;
        if (wrap.parentElement === grid) {
          wrap.remove();
          s.cardEls.delete(uid);
          s.statusSig.delete(uid);
          s.effectBarSig.delete(uid);
        }
      }
      for (const pub of list) {
        let wrap = s.cardEls.get(pub.uid);
        if (!wrap) {
          wrap = createCard(pub);
          grid.append(wrap);
          s.cardEls.set(pub.uid, wrap);
          wrap.classList.add("is-enter");
          setTimeout(() => wrap.classList.remove("is-enter"), 420);
        }
        // 待播退场的卡保持最后一次可见状态，等伤害事件再更新血条
        if (s.deathPending.has(pub.uid) && pub.state !== "alive") continue;
        updateCard(wrap, pub);
      }
      for (const slot of grid.querySelectorAll(".lbt-slot")) slot.remove();
      if (list.length < s.config.maxUnits) grid.append(createDeploySlot(side));
      layoutZone(side);
    }
    updateHeader();
  }

  const refreshAll = () => {
    syncUnits();
    renderActions();
    updateHeader();
    renderHandButtons();
    if (refs.handOverlay && !refs.handOverlay.hidden) renderHand();
  };

  const setDisplayHp = (uid, value) => {
    const unit = unitOf(uid);
    if (!unit) return;
    const max = s.battle.statsOf(unit).hp;
    s.displayHp.set(uid, clamp(Number(value) || 0, 0, max));
    const pub = pubOf(uid);
    const wrap = s.cardEls.get(uid);
    if (pub && wrap) updateCard(wrap, pub);
  };

  const flashHit = (uid) => {
    const wrap = s.cardEls.get(uid);
    if (!wrap) return;
    wrap.classList.remove("is-hit");
    void wrap.offsetWidth;
    wrap.classList.add("is-hit");
    setTimeout(() => wrap.classList.remove("is-hit"), 300);
  };

  /* ---------------- 顶栏 / 行动栏 ---------------- */
  function badgeHtml(side) {
    return isHumanSide(side) ? `<span class="chip">玩家</span>` : `<span class="chip is-on">人机</span>`;
  }

  function updateHeader() {
    if (!s.battle) return;
    const pb = s.battle.publicBattle();
    if (refs.round) refs.round.textContent = String(pb.turn);
    const handA = pb.hand?.ally?.length || 0;
    const handB = pb.hand?.enemy?.length || 0;
    if (refs.redDeck) refs.redDeck.textContent = `牌组余 ${pb.decks.ally} · 手牌 ${handA}`;
    if (refs.blueDeck) refs.blueDeck.textContent = `牌组余 ${pb.decks.enemy} · 手牌 ${handB}`;
    if (refs.redBadge) refs.redBadge.innerHTML = badgeHtml("ally");
    if (refs.blueBadge) refs.blueBadge.innerHTML = badgeHtml("enemy");

    let statusText = "战斗结束";
    let side = pb.sideTurn;
    if (pb.status === "running") {
      if (pb.phase === "deploy" && pb.localDeploy) {
        side = pb.localDeploy.side;
        statusText = `${sideName(side)}布阵`;
      } else if (pb.phase === "select") {
        const active = activeUnit();
        statusText = active ? `${active.name} 行动中` : `${sideName(side)}行动`;
      } else if (pb.phase === "act") {
        const active = activeUnit();
        statusText = active ? `${active.name} 行动中` : `${sideName(side)}行动中`;
      }
    }
    if (refs.status) {
      refs.status.textContent = statusText;
      refs.status.dataset.side = sideKey(side);
    }
    if (refs.turn) refs.turn.dataset.side = sideKey(side);
    // 中间的行动标题只写「哪一方行动」，不写单位名 / 额外提示
    if (refs.turnSide) {
      refs.turnSide.textContent =
        pb.status === "running" ? (pb.phase === "deploy" ? `${sideName(side)}布阵` : `${sideName(side)}行动`) : "战斗结束";
    }
    // 行动区标题只表示「哪一方行动」，不再追加额外提示
    if (refs.turnHint) {
      refs.turnHint.textContent = "";
      refs.turnHint.hidden = true;
    }
  }

  function renderActions() {
    if (!refs.actions || !s.battle) return;
    const pb = s.battle.publicBattle();
    const el = refs.actions;
    if (pb.status !== "running" || pb.phase === "finished") {
      el.innerHTML = `<span class="tbt-act-hint"><b>战斗结束</b> · 可以返回配置再来一局。</span>`;
      return;
    }
    if (s.busy) {
      el.innerHTML = `<div class="tbt-wait"><span class="tbt-spinner"></span>行动结算中…</div>`;
      return;
    }
    if (pb.phase === "deploy" && pb.localDeploy) {
      const side = pb.localDeploy.side;
      el.innerHTML = `
        <span class="tbt-act-hint"><b>${sideName(side)}布阵</b> · ${
          pb.localDeploy.initial ? "至少上场 1 个单位，最多 " + s.config.maxUnits + " 个" : "场上全灭，请从手牌补上场"
        }</span>
        ${
          isHumanSide(side)
            ? `<button class="tbt-skill" type="button" data-open-hand="${side}"><b>打开手牌</b><span>选择上场单位</span></button>`
            : `<div class="tbt-wait"><span class="tbt-spinner"></span>人机布阵中…</div>`
        }`;
      return;
    }
    const side = pb.sideTurn;
    if (pb.phase === "select") {
      if (!isHumanSide(side)) {
        el.innerHTML = `<div class="tbt-wait"><span class="tbt-spinner"></span>人机思考中…</div>`;
        return;
      }
      const units = pb.units.filter((u) => u.side === side && u.state === "alive" && !u.acted);
      el.innerHTML = `
        <div class="tbt-act-hint"><b>${sideName(side)}行动</b></div>
        <div class="tbt-skills">
          ${units
            .map(
              (u) => `<button class="tbt-skill" type="button" data-pick="${escapeHtml(u.uid)}">
                <b>${escapeHtml(u.name)}</b>
                <span>ATK ${fmt(u.atk)} · HP ${fmt(u.hp)}</span>
              </button>`
            )
            .join("")}
        </div>`;
      return;
    }

    /* act */
    const active = activeUnit();
    if (!active) {
      el.innerHTML = `<span class="tbt-act-hint">单位已不在场，正在切换行动方…</span>`;
      return;
    }
    const skills = s.battle.allSkillsOf(active);
    const skillButtons = skills
      .map((sk, i) => {
        if (sk.type !== "active") return "";
        const icon = resolveCardIcon(sk);
        const needsTarget = skillNeedsPlayerTarget(sk);
        return `<button class="tbt-skill ${s.pending?.index === i ? "is-targeting" : ""}" type="button" data-skill="${i}">
               <div class="tbt-skill-main">${
                 icon ? `<img class="tbt-skill-icon" src="${escapeHtml(icon)}" alt="" draggable="false" />` : ""
               }<b>${escapeHtml(sk.name)}</b></div>
               <span>${needsTarget ? "手动选择目标" : "直接施放"}</span>
             </button>`;
      })
      .join("");
    const cancelSkillButton = s.pending
      ? `<button class="tbt-skill is-cancel" type="button" data-cancel><b>取消技能</b><span>返回选择技能</span></button>`
      : "";
    // 选中技能：在行动选择区展示这个技能的描述
    const pendingSkill = s.pending ? skills[s.pending.index] : null;
    const skillDesc = pendingSkill
      ? `<div class="tbt-skill-desc" role="note">
           <b>${escapeHtml(pendingSkill.name)}</b>
           <span>${escapeHtml(pendingSkill.description || "这个技能还没有填写描述。")}</span>
         </div>`
      : "";
    const targetTip = s.pending
      ? `<div class="tbt-act-hint"><b>选择目标</b> · 点击${sideName(active.side === "ally" ? "enemy" : "ally")}单位</div>`
      : `<div class="tbt-act-hint">选择一个技能，或结束行动</div>`;
    el.innerHTML = `
      <div class="tbt-act-head">
        <img class="tbt-act-portrait" src="${resolveCardImage(active.card)}" alt="" draggable="false"
             onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
        <span class="tbt-act-name">
          <b>${escapeHtml(active.name)}</b>
          <span>HP ${Math.ceil(active.hp)} / ${Math.ceil(s.battle.statsOf(active).hp)}</span>
        </span>
        <button class="btn tiny" type="button" data-info="${escapeHtml(active.uid)}">详情</button>
      </div>
      ${targetTip}
      ${skillDesc}
      <div class="tbt-skills">${skillButtons || `<span class="tbt-act-hint">没有主动技能</span>`}${cancelSkillButton}</div>
      <button class="tbt-end" type="button" data-end>结束行动</button>`;
  }

  function renderHandButtons() {
    const pb = s.battle?.publicBattle();
    if (!pb) return;
    const map = [
      [refs.redHand, "ally"],
      [refs.blueHand, "enemy"],
    ];
    for (const [btn, side] of map) {
      if (!btn) continue;
      btn.dataset.side = side;
      btn.querySelector("b").textContent = String(pb.hand?.[side]?.length || 0);
    }
  }

  /* ---------------- 手牌 / 布阵 ---------------- */
  const fieldCount = (side) => s.battle.publicBattle().units.filter((u) => u.side === side && u.state === "alive" && u.countsAsUnit).length;

  function handCardDisabled(side, index, pub) {
    if (!pub) return true;
    if (pub.phase === "finished") return true;
    if (pub.localDeploy && pub.localDeploy.side !== side) return true;
    if (!s.battle.canDeploy(side)) return true;
    if (fieldCount(side) >= s.config.maxUnits) return true;
    const cardId = pub.hand?.[side]?.[index];
    const card = cardId ? s.registry.getUnit(cardId) : null;
    if (!card) return true;
    if (!s.config.allowSameName) {
      const name = card.name || card.id;
      if (pub.units.some((u) => u.side === side && u.state === "alive" && u.name === name)) return true;
    }
    return false;
  }

  function handCardHtml(cardId, index, pub, side) {
    const card = s.registry.getUnit(cardId);
    if (!card) return "";
    const disabled = handCardDisabled(side, index, pub);
    const q = QUALITY_LABEL[card.quality] || card.quality;
    const dup =
      !s.config.allowSameName &&
      pub.units.some((u) => u.side === side && u.state === "alive" && u.name === (card.name || card.id));
    // 放大镜只在布阵时出现；卡牌上场后就不在手牌里了，自然不再显示
    const showMagnifier = pub.phase === "deploy";
    return `
      <div class="lbt-hand-card-wrap">
        <button class="lbt-hand-card" type="button" data-hand-index="${index}" ${disabled ? "disabled" : ""}
                title="${escapeHtml(card.name || card.id)}${dup ? " · 同名角色已在场" : ""}">
          <span class="lbt-hc-art">
            <img src="${escapeHtml(resolveCardImage(card))}" alt="" draggable="false"
                 onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
          </span>
          <span class="lbt-hc-name">${escapeHtml(card.name || card.id)}</span>
          <span class="lbt-hc-meta"><span class="q-tag q-${escapeHtml(card.quality)}">${escapeHtml(q)}</span> HP ${fmt(card.baseHp)} · ATK ${fmt(card.baseAtk)}</span>
          ${dup ? `<span class="lbt-hc-ban">同名</span>` : ""}
        </button>
        ${
          showMagnifier
            ? `<button class="lbt-hc-mag" type="button" data-mag-index="${index}"
                 aria-label="查看 ${escapeHtml(card.name || card.id)} 的详情和技能" title="查看详情和技能">🔍</button>`
            : ""
        }
      </div>`;
  }

  function renderHand() {
    if (!refs.handCards || !s.battle || !s.handSide) return;
    const side = s.handSide;
    const pb = s.battle.publicBattle();
    const hand = pb.hand?.[side] || [];
    if (refs.handTitle) refs.handTitle.textContent = `${sideName(side)}手牌`;
    const fc = fieldCount(side);
    const required = pb.localDeploy?.side === side && pb.phase === "deploy";
    if (refs.handHint) {
      refs.handHint.textContent = required
        ? pb.localDeploy.initial
          ? `布阵：至少上场 1 个，最多 ${s.config.maxUnits} 个（当前 ${fc}/${s.config.maxUnits}）`
          : `场上全灭：请补上场（当前 ${fc}/${s.config.maxUnits}）`
        : `场上 ${fc}/${s.config.maxUnits} · 点击卡牌从手牌上场`;
    }
    if (refs.handClose) refs.handClose.hidden = required;
    if (refs.handDone) {
      refs.handDone.hidden = !required;
      refs.handDone.disabled = fc < 1;
      refs.handDone.textContent = pb.localDeploy?.initial ? "完成布阵" : "完成上场";
    }
    if (!hand.length) {
      refs.handCards.innerHTML = `<p class="lbt-hand-empty">手牌是空的。</p>`;
      return;
    }
    refs.handCards.innerHTML = hand.map((id, i) => handCardHtml(id, i, pb, side)).join("");
  }

  function openHand(side, opts = {}) {
    if (s.destroyed || !refs.handOverlay) return;
    s.handSide = side;
    s.handRequired = Boolean(opts.required);
    refs.handOverlay.hidden = false;
    updateHandButtonsVisible();
    renderHand();
  }

  function closeHand() {
    if (s.destroyed) return;
    if (s.handRequired) {
      toast("请先完成布阵");
      return;
    }
    s.handSide = null;
    s.handRequired = false;
    if (refs.handOverlay) refs.handOverlay.hidden = true;
    updateHandButtonsVisible();
  }

  async function deployHandCard(index) {
    if (s.busy || s.destroyed || !s.handSide) return;
    const side = s.handSide;
    const pb = s.battle.publicBattle();
    if (handCardDisabled(side, index, pb)) {
      toast("这张牌现在不能上场");
      return;
    }
    const events = take(() => s.battle.deployFromHand(side, index));
    if (!events.length) {
      toast("上场失败");
      return;
    }
    s.busy = true;
    renderActions();
    await playEvents(events);
    s.busy = false;
    if (s.destroyed) return;
    refreshAll();
    if (refs.handOverlay && !refs.handOverlay.hidden) renderHand();
  }

  async function finishHandDeploy() {
    if (s.busy || s.destroyed || !s.handSide) return;
    const side = s.handSide;
    const pb = s.battle.publicBattle();
    if (pb.localDeploy?.side !== side) {
      closeHand();
      return;
    }
    const events = take(() => s.battle.finishDeploy(side));
    if (!events.length) {
      toast("至少要上场 1 个单位");
      return;
    }
    s.busy = true;
    closeForced();
    renderActions();
    await playEvents(events);
    s.busy = false;
    if (s.destroyed) return;
    finishStep();
  }

  function closeForced() {
    s.handSide = null;
    s.handRequired = false;
    if (refs.handOverlay) refs.handOverlay.hidden = true;
    updateHandButtonsVisible();
  }

  /* ---------------- 日志 / 特效 ---------------- */
  function addLog(text, kind = "") {
    s.log.push({ text, kind });
    if (s.log.length > 30) s.log.shift();
    if (!refs.log) return;
    refs.log.innerHTML = s.log
      .slice(-6)
      .map((line) => `<div class="tbt-log-line ${line.kind}">${escapeHtml(line.text)}</div>`)
      .join("");
  }

  const attrName = (attr) => ATTRIBUTE_INFO[attr]?.label || "物理";

  function logDamage(ev, attacker, target) {
    if (!target) return;
    const cls = sideKey(target.side) === "red" ? "is-red" : "is-blue";
    const amount = ev.finalDamage > 0 ? fmt(ev.finalDamage) : "免疫";
    const from = attacker ? `[${attacker.side === "ally" ? "红" : "蓝"}]${attacker.name}` : "?";
    addLog(
      `${from} → [${target.side === "ally" ? "红" : "蓝"}]${target.name}  ${amount}${ev.crit ? "（暴击）" : ""}${
        ev.isAdditionalDamage ? " · 附加" : ev.isTrueDamage ? " · 本源" : ` · ${attrName(ev.attribute)}`
      }`,
      cls
    );
  }

  function impactDamage(ev, hitRect, additional) {
    if (!hitRect) return;
    const immune = ev.finalDamage <= 0 || ev.targetInvincible || ev.immune;
    if (additional) s.fx.impact(hitRect, { attribute: ev.attribute });
    else s.fx.explode(hitRect, { attribute: ev.attribute });
    s.fx.floatText(hitRect, immune ? "免疫" : fmt(ev.finalDamage), {
      attribute: ev.attribute,
      crit: Boolean(ev.crit),
      kind: immune ? "mute" : "damage",
      size: additional ? 20 : undefined,
      tag: additional && !immune ? "附加" : "",
    });
    flashHit(ev.target);
  }

  async function playDamage(ev) {
    const attacker = unitOf(ev.attacker);
    const target = unitOf(ev.target);
    if (!target) {
      await sleep(60);
      return;
    }
    const aRect = rectOf(ev.attacker);
    const tRect = rectOf(ev.target);
    const additional = Boolean(ev.isAdditionalDamage);
    if (!additional && aRect && tRect && !s.destroyed) {
      await s.fx.launch(aRect, tRect, { attribute: ev.attribute });
    } else {
      await sleep(additional ? 90 : 160);
    }
    if (s.destroyed) return;
    const hitRect = rectOf(ev.target) || tRect;
    impactDamage(ev, hitRect, additional);
    setDisplayHp(ev.target, ev.hpAfter);
    logDamage(ev, attacker, target);
    await sleep(additional ? 220 : ev.finalDamage > 0 ? 150 : 120);
  }

  async function playDamageGroup(list) {
    const entries = list.map((ev) => ({
      ev,
      attacker: unitOf(ev.attacker),
      target: unitOf(ev.target),
      aRect: rectOf(ev.attacker),
      tRect: rectOf(ev.target),
      additional: Boolean(ev.isAdditionalDamage),
    }));
    const launches = [];
    for (const e of entries) {
      if (!e.target || e.additional || !e.aRect || !e.tRect || s.destroyed) continue;
      launches.push(s.fx.launch(e.aRect, e.tRect, { attribute: e.ev.attribute, arriveIn: 0.32 }));
    }
    if (launches.length) await Promise.all(launches);
    else await sleep(entries.some((e) => e.additional) ? 90 : 160);
    if (s.destroyed) return;
    let anyAdditional = false;
    let anyPositive = false;
    for (const e of entries) {
      if (!e.target) continue;
      const ev = e.ev;
      const hitRect = rectOf(ev.target) || e.tRect;
      impactDamage(ev, hitRect, e.additional);
      setDisplayHp(ev.target, ev.hpAfter);
      logDamage(ev, e.attacker, e.target);
      if (e.additional) anyAdditional = true;
      if (ev.finalDamage > 0) anyPositive = true;
    }
    await sleep(anyAdditional ? 220 : anyPositive ? 150 : 120);
  }

  async function playHeal(ev) {
    const unit = unitOf(ev.unit);
    if (!unit) return;
    const rect = rectOf(ev.unit);
    if (rect) {
      s.fx.aura(rect, { kind: "heal" });
      s.fx.floatText(rect, `+${fmt(ev.amount)}`, { kind: "heal" });
    }
    setDisplayHp(ev.unit, ev.hpAfter);
    addLog(`${unit.name} 回复 ${fmt(ev.amount)} 生命`, sideKey(unit.side) === "red" ? "is-red" : "is-blue");
    await sleep(240);
  }

  /** 抽牌光束颜色：跟品质一致；彩卡用多色渐变，金卡走「先光束 / 剪影 / 再立绘」的完整演出 */
  const QUALITY_BEAM = {
    white: "#cfdcdd",
    blue: "#3aa5f0",
    gold: "#ffb020",
    rainbow: "#ff6b8b",
  };

  async function playRefill(ev) {
    const side = ev.side;
    const card = s.registry.getUnit(ev.cardId);
    if (!refs.refillLayer || !card || s.destroyed) return;
    s.refillBusy = true;
    const quality = card.quality || "white";
    const special = quality === "gold" || quality === "rainbow";
    const color = QUALITY_BEAM[quality] || QUALITY_BEAM.white;

    const rayColor = (i) =>
      quality === "rainbow" ? `hsl(${i * 36}, 92%, 62%)` : "var(--q-color)";
    const el = document.createElement("div");
    el.className = "lbt-draw";
    el.dataset.quality = quality;
    el.style.setProperty("--q-color", color);
    el.innerHTML = `
      <div class="lbt-draw-beams" aria-hidden="true">
        <div class="lbt-draw-rays">
          ${Array.from({ length: 10 }, (_, i) => `<i style="--i:${i};--ray-color:${rayColor(i)}"></i>`).join("")}
        </div>
      </div>
      <div class="lbt-draw-halo" aria-hidden="true"></div>
      <div class="lbt-draw-card">
        <div class="lbt-draw-inner">
          <div class="lbt-draw-face lbt-draw-back"></div>
          <div class="lbt-draw-face lbt-draw-front">
            <img src="${escapeHtml(resolveCardImage(card))}" alt="" draggable="false"
                 onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
            <span class="lbt-draw-shine" aria-hidden="true"></span>
          </div>
        </div>
      </div>
      <div class="lbt-draw-intro">
        <b>${escapeHtml(card.name || card.id)}</b>
        <p>${escapeHtml(card.description || "来自牌库的相遇。")}</p>
      </div>`;
    refs.refillLayer.append(el);

    // 1) 先看卡背
    await sleep(160);
    if (s.destroyed) return;

    // 2) 翻面。金 / 彩卡在翻面时就先变成黑色剪影，避免翻到正面时闪一下原图
    if (special) el.classList.add("is-silhouette");
    el.classList.add("is-flipped");
    await sleep(special ? 520 : 360);
    if (s.destroyed) return;

    // 3) 翻转后出现品质光束
    el.classList.add("is-beaming");
    if (special) {
      // 金 / 彩：翻面后展示角色介绍（不显示名字）
      el.classList.add("is-intro");
      await sleep(1000);
      if (s.destroyed) return;
      // 4) 恢复原图 + 扩散金色光环 + 显示角色名
      el.classList.remove("is-silhouette");
      el.classList.add("is-revealed");
      await sleep(1000);
      if (s.destroyed) return;
    } else {
      await sleep(420);
    }

    // 5) 飞进手牌按钮
    const btn = side === "ally" ? refs.redHand : refs.blueHand;
    if (btn) {
      const sp = s.stage.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      const k = s.scaler?.scale || 1;
      const dx = (br.left + br.width / 2 - (sp.left + sp.width / 2)) / k;
      const dy = (br.top + br.height / 2 - (sp.top + sp.height / 2)) / k;
      el.style.setProperty("--fly-x", `${dx}px`);
      el.style.setProperty("--fly-y", `${dy}px`);
    }
    el.classList.add("is-flying");
    await sleep(420);
    el.remove();
    s.refillBusy = false;
    if (refs.handOverlay && !refs.handOverlay.hidden) renderHand();
  }

  async function playEvents(events) {
    if (!events || !events.length) return;
    // 引擎已经同步结算完，但 UI 还没播到退场事件：先别在刷新时把卡删掉，
    // 否则附加伤害（DOT）击杀会看起来「角色莫名其妙地消失」，跳字也无处可落。
    for (const ev of events) {
      if (ev && ev.type === "death" && ev.unit) s.deathPending.add(ev.unit);
    }
    const attackGroups = new Map();
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      if (ev.type !== "damage" || ev.attackGroup === undefined || ev.attackGroup === null) continue;
      const list = attackGroups.get(ev.attackGroup) || [];
      list.push({ index: i, ev });
      attackGroups.set(ev.attackGroup, list);
    }
    const playedDamage = new Set();
    for (let i = 0; i < events.length; i += 1) {
      if (playedDamage.has(i)) continue;
      const ev = events[i];
      if (s.destroyed) return;
      switch (ev.type) {
        case "round:start": {
          addLog(`—— 第 ${ev.turn} 回合 ——`, "is-sys");
          updateHeader();
          await sleep(160);
          break;
        }
        case "side:turn": {
          updateHeader();
          refreshAll();
          await sleep(90);
          break;
        }
        case "summon": {
          syncUnits();
          const unit = unitOf(ev.unit);
          const rect = rectOf(ev.unit);
          if (rect) s.fx.aura(rect, { kind: "enter" });
          if (unit) addLog(`${unit.name} 上场（${sideName(unit.side)}）`, sideKey(unit.side) === "red" ? "is-red" : "is-blue");
          await sleep(180);
          break;
        }
        case "hand:draw": {
          renderHandButtons();
          if (!ev.refill) {
            /* 初始抽牌不逐张播动画 */
          }
          break;
        }
        case "hand:play": {
          renderHandButtons();
          await sleep(60);
          break;
        }
        case "refill": {
          await playRefill(ev);
          renderHandButtons();
          break;
        }
        case "refill:done": {
          renderHandButtons();
          if (refs.handOverlay && !refs.handOverlay.hidden) renderHand();
          await sleep(80);
          break;
        }
        case "deploy:required": {
          addLog(`${sideName(ev.side)}需要布阵`, "is-sys");
          updateHeader();
          await sleep(120);
          break;
        }
        case "deploy:done": {
          syncUnits();
          await sleep(80);
          break;
        }
        case "skill": {
          const caster = unitOf(ev.caster);
          addLog(`${caster ? caster.name : "?"} 使用「${ev.skillName}」`, caster && sideKey(caster.side) === "red" ? "is-red" : "is-blue");
          await sleep(150);
          break;
        }
        case "damage": {
          const group = ev.attackGroup ? attackGroups.get(ev.attackGroup) : null;
          if (group && group.length > 1) {
            for (const item of group) playedDamage.add(item.index);
            await playDamageGroup(group.map((item) => item.ev));
          } else {
            await playDamage(ev);
          }
          break;
        }
        case "heal":
          await playHeal(ev);
          break;
        case "buff:added": {
          const unit = unitOf(ev.unit);
          const rect = rectOf(ev.unit);
          if (rect) s.fx.aura(rect, { kind: "buff" });
          if (unit) addLog(`${unit.name} 获得「${ev.buff?.label || "效果"}」`, "is-sys");
          syncUnits();
          await sleep(110);
          break;
        }
        case "effect:added": {
          const unit = unitOf(ev.unit);
          const def = s.registry.getEffect(ev.effect);
          const rect = rectOf(ev.unit);
          if (rect) s.fx.aura(rect, { kind: "buff" });
          if (unit) addLog(`${unit.name} 获得「${def?.name || ev.effect}」`, "is-sys");
          syncUnits();
          // 效果挂载的技能随效果获得 / 消失，行动栏立刻刷新
          renderActions();
          await sleep(100);
          break;
        }
        case "effect:removed": {
          syncUnits();
          renderActions();
          await sleep(60);
          break;
        }
        case "death": {
          s.deathPending.delete(ev.unit);
          const unit = unitOf(ev.unit);
          const wrap = s.cardEls.get(ev.unit);
          if (wrap) {
            wrap.classList.add("is-dead");
            s.cardEls.delete(ev.unit);
            s.statusSig.delete(ev.unit);
            setTimeout(() => wrap.remove(), 340);
          }
          if (unit) addLog(`${unit.name} 退场`, sideKey(unit.side) === "red" ? "is-red" : "is-blue");
          await sleep(260);
          break;
        }
        case "exit": {
          const unit = unitOf(ev.unit);
          const wrap = s.cardEls.get(ev.unit);
          if (wrap) {
            wrap.classList.add("is-dead");
            s.cardEls.delete(ev.unit);
            setTimeout(() => wrap.remove(), 340);
          }
          if (unit) addLog(`${unit.name} 离场`, "is-sys");
          await sleep(180);
          break;
        }
        case "battle:end": {
          const winner = ev.winner === "ally" ? "红方" : ev.winner === "enemy" ? "蓝方" : "平局";
          addLog(`战斗结束：${winner}`, "is-sys");
          await sleep(220);
          break;
        }
        case "flow:error": {
          const msg = ev.reason || (Array.isArray(ev.errors) ? ev.errors.join("；") : "流程执行出错");
          addLog(`流程提示：${msg}`, "is-sys");
          break;
        }
        case "turn:start":
        case "turn:end":
        case "round:end":
        case "attack":
        case "hp:lost":
        case "immune":
        case "buff:expired":
        case "buff:removed":
        case "action:start":
        case "action:skip":
        case "battle:start":
          break;
        case "skill:granted": {
          syncUnits();
          renderActions();
          break;
        }
        default:
          break;
      }
    }
  }

  /* ---------------- 行动 / 人机 ---------------- */
  async function pickUnit(uid) {
    if (s.busy || s.destroyed) return;
    const events = take(() => s.battle.selectUnit(uid));
    if (!events.length) return;
    s.busy = true;
    refreshAll();
    await playEvents(events);
    s.busy = false;
    if (s.destroyed) return;
    finishStep();
  }

  async function executeSkill(index, targetUid) {
    if (s.busy || s.destroyed) return;
    s.pending = null;
    s.busy = true;
    s.preferredTargets = targetUid ? [targetUid] : [];
    refreshAll();
    let events = [];
    try {
      events = take(() => s.battle.useSkill(index, targetUid ? { targetRef: targetUid } : undefined));
    } catch (err) {
      addLog(`技能使用失败：${String(err.message || err)}`, "is-sys");
      s.preferredTargets = [];
      s.busy = false;
      refreshAll();
      return;
    }
    s.preferredTargets = [];
    await playEvents(events);
    if (s.destroyed) return;
    if (s.battle.state.status === "running") {
      const tail = take(() => s.battle.endTurn());
      await playEvents(tail);
    }
    s.busy = false;
    if (s.destroyed) return;
    finishStep();
  }

  async function endAction() {
    if (s.busy || s.destroyed) return;
    s.pending = null;
    s.busy = true;
    refreshAll();
    const events = take(() => s.battle.endTurn());
    await playEvents(events);
    s.busy = false;
    if (s.destroyed) return;
    finishStep();
  }

  function finishStep() {
    if (s.destroyed) return;
    refreshAll();
    const pb = s.battle.publicBattle();
    if (pb.status !== "running" || pb.phase === "finished") {
      closeForced();
      showResult();
      return;
    }
    if (pb.phase === "deploy") {
      handleDeployState();
      return;
    }
    if (pb.phase === "select" && !isHumanSide(pb.sideTurn)) {
      maybeAI();
    }
  }

  function handleDeployState() {
    const pb = s.battle.publicBattle();
    if (pb.phase !== "deploy" || !pb.localDeploy) return;
    const side = pb.localDeploy.side;
    if (isHumanSide(side)) {
      openHand(side, { required: true });
      renderActions();
      updateHeader();
    } else {
      maybeAI();
    }
  }

  function maybeAI() {
    if (s.busy || s.destroyed || s.aiStalled) return;
    const pb = s.battle.publicBattle();
    if (pb.status !== "running") return;
    if (pb.phase === "deploy") {
      if (pb.localDeploy && !isHumanSide(pb.localDeploy.side)) runAIDeploy();
      return;
    }
    if (pb.phase === "select" && !isHumanSide(pb.sideTurn)) runAIStep();
  }

  /** AI：从手牌里反复挑「当前最有利」的牌，把场上补到上限 */
  async function aiFillField(side) {
    let guard = 0;
    while (!s.destroyed && guard < 12) {
      guard += 1;
      const pb = s.battle.publicBattle();
      if (pb.localDeploy && pb.localDeploy.side !== side) break;
      if (fieldCount(side) >= s.config.maxUnits) break;
      const index = chooseBestDeployCard(s.battle, s.registry, side);
      if (index < 0) break;
      const events = take(() => s.battle.deployFromHand(side, index));
      if (!events.length) break;
      await playEvents(events);
      await sleep(140);
    }
  }

  async function runAIDeploy() {
    if (s.busy || s.destroyed) return;
    const pb0 = s.battle.publicBattle();
    const side = pb0.localDeploy?.side;
    if (!side) return;
    s.busy = true;
    renderActions();
    await sleep(420);
    try {
      await aiFillField(side);
      const events = take(() => s.battle.finishDeploy(side));
      if (events.length) await playEvents(events);
    } finally {
      s.busy = false;
      if (!s.destroyed) finishStep();
    }
  }

  async function runAIStep() {
    if (s.busy || s.destroyed) return;
    const pb = s.battle.publicBattle();
    if (pb.status !== "running" || pb.phase !== "select") return;
    const side = pb.sideTurn;

    s.busy = true;
    renderActions();
    await sleep(420);
    try {
      // 场上不足上限时，先从手牌补齐；再挑一个单位行动
      await aiFillField(side);
      const pbAfter = s.battle.publicBattle();
      if (pbAfter.status !== "running") return;
      const candidates = pbAfter.units.filter((u) => u.side === side && u.state === "alive" && !u.acted);
      if (!candidates.length) return;
      candidates.sort((a, b) => b.atk - a.atk);
      const pick = Math.random() < 0.7 ? candidates[0] : candidates[Math.floor(Math.random() * candidates.length)];
      const selectEvents = take(() => s.battle.selectUnit(pick.uid));
      await playEvents(selectEvents);
      if (s.destroyed) return;
      if (s.battle.publicBattle().phase !== "act") return;

      const active = activeUnit();
      if (!active) return;
      const choice = chooseAISkill(s.battle, active, s.registry);
      if (choice) {
        // 「选择单位」积木优先使用这个目标；用完立刻清掉，避免影响下一次行动
        s.preferredTargets = choice.targetUid ? [choice.targetUid] : [];
        let events = [];
        try {
          events = take(() =>
            s.battle.useSkill(choice.index, choice.targetUid ? { targetRef: choice.targetUid } : undefined)
          );
        } finally {
          s.preferredTargets = [];
        }
        await playEvents(events);
      }
      if (s.destroyed) return;
      if (s.battle.state.status === "running") {
        const tail = take(() => s.battle.endTurn());
        await playEvents(tail);
      }
    } finally {
      s.busy = false;
      if (!s.destroyed) finishStep();
    }
  }

  /* ---------------- 结果 ---------------- */
  function showResult() {
    if (s.resultShown || s.destroyed || !refs.result) return;
    s.resultShown = true;
    detail.close();
    closeForced();
    const pb = s.battle.publicBattle();
    const title = pb.winner === "ally" ? "红方胜利" : pb.winner === "enemy" ? "蓝方胜利" : "平局";
    const cls = pb.winner === "ally" ? "is-red" : pb.winner === "enemy" ? "is-blue" : "is-draw";
    const aliveRed = pb.units.filter((u) => u.side === "ally" && u.state === "alive").length;
    const aliveBlue = pb.units.filter((u) => u.side === "enemy" && u.state === "alive").length;
    const reason =
      pb.endReason === "max-cycles"
        ? `达到回合上限（第 ${pb.turn} 回合）`
        : pb.endReason === "draw"
          ? "双方同时全灭"
          : "一方场上单位全部退场且没有手牌";
    refs.result.innerHTML = `
      <div class="tbt-sheet" role="dialog" aria-modal="true" aria-label="战斗结果">
        <div class="tbt-result-body">
          <div class="tbt-result-title ${cls}">${title}</div>
          <p class="tbt-result-sub">${reason}</p>
          <div class="tbt-result-stats">
            <span>回合<b>${pb.turn}</b></span>
            <span>红方场上<b>${aliveRed}</b></span>
            <span>蓝方场上<b>${aliveBlue}</b></span>
          </div>
          <div class="tbt-result-actions">
            <button class="btn" type="button" data-again>再来一局</button>
            <button class="btn primary" type="button" data-back-config>返回配置</button>
          </div>
        </div>
      </div>`;
    refs.result.hidden = false;
    updateHandButtonsVisible();
    refs.result.querySelector("[data-again]")?.addEventListener("click", restart);
    refs.result.querySelector("[data-back-config]")?.addEventListener("click", closeToConfig);
  }

  /* ---------------- 事件绑定 ---------------- */
  refs.redGrid.innerHTML = "";
  refs.blueGrid.innerHTML = "";
  const onBoardClick = (event) => {
    const wrap = event.target.closest(".tbt-unit");
    if (!wrap) return;
    const uid = wrap.dataset.uid;
    if (!uid) return;
    const pb = s.battle.publicBattle();
    const pub = pb.units.find((u) => u.uid === uid);
    if (s.pending && !s.busy) {
      const active = activeUnit();
      if (pub && active && pub.side !== active.side && pub.state === "alive") {
        executeSkill(s.pending.index, uid);
      } else {
        // 不在本次行动可选范围（例如友方 / 已行动）→ 点开详情
        detail.openUnit(uid);
      }
      return;
    }
    if (canPickUnit(pub || {})) {
      pickUnit(uid);
      return;
    }
    // 不是当前可选单位也能查看详情（只读，不打断行动）
    detail.openUnit(uid);
  };
  if (refs.redGrid) refs.redGrid.onclick = onBoardClick;
  if (refs.blueGrid) refs.blueGrid.onclick = onBoardClick;

  if (refs.actions) {
    refs.actions.onclick = (event) => {
      const pick = event.target.closest("[data-pick]");
      if (pick) return pickUnit(pick.dataset.pick);
      const skill = event.target.closest("[data-skill]");
      if (skill) return chooseSkill(Number(skill.dataset.skill));
      const end = event.target.closest("[data-end]");
      if (end) return endAction();
      const cancel = event.target.closest("[data-cancel]");
      if (cancel) {
        s.pending = null;
        refreshAll();
        return;
      }
      const info = event.target.closest("[data-info]");
      if (info) return detail.openUnit(info.dataset.info);
      const open = event.target.closest("[data-open-hand]");
      if (open) openHand(open.dataset.openHand, { required: true });
    };
  }

  if (refs.detail) {
    refs.detail.onclick = (event) => detail.handleClick(event);
  }

  function chooseSkill(index) {
    if (s.busy) return;
    const active = activeUnit();
    if (!active) return;
    const skill = s.battle.allSkillsOf(active)[index];
    if (!skill) return;
    if (s.pending && s.pending.index === index) {
      s.pending = null;
      refreshAll();
      return;
    }
    if (!skillNeedsPlayerTarget(skill)) {
      executeSkill(index, null);
      return;
    }
    const enemies = s.battle.publicBattle().units.filter((u) => u.side !== active.side && u.state === "alive");
    if (!enemies.length) {
      executeSkill(index, null);
      return;
    }
    s.pending = { index };
    refreshAll();
  }

  if (refs.redHand) {
    refs.redHand.onclick = () => {
      if (s.busy) return;
      openHand("ally", { required: s.battle.publicBattle().localDeploy?.side === "ally" });
    };
  }
  if (refs.blueHand) {
    refs.blueHand.onclick = () => {
      if (s.busy) return;
      openHand("enemy", { required: s.battle.publicBattle().localDeploy?.side === "enemy" });
    };
  }

  if (refs.handOverlay) {
    refs.handOverlay.onclick = (event) => {
      if (event.target === refs.handOverlay) closeHand();
    };
    if (refs.handCards) {
      refs.handCards.onclick = (event) => {
        const mag = event.target.closest("[data-mag-index]");
        if (mag) {
          event.preventDefault();
          event.stopPropagation();
          const side = s.handSide;
          if (!side) return;
          const index = Number(mag.dataset.magIndex);
          const pb = s.battle.publicBattle();
          const cardId = pb.hand?.[side]?.[index];
          const card = cardId ? s.registry.getUnit(cardId) : null;
          if (card) detail.openCard(card, { sideText: sideName(side), subtitle: "手牌" });
          return;
        }
        const card = event.target.closest("[data-hand-index]");
        if (!card || card.disabled) return;
        deployHandCard(Number(card.dataset.handIndex));
      };
    }
    if (refs.handClose) refs.handClose.onclick = closeHand;
    if (refs.handDone) refs.handDone.onclick = finishHandDeploy;
  }

  function toast(text) {
    const el = refs.toast;
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.remove("is-in");
    void el.offsetWidth;
    el.classList.add("is-in");
    clearTimeout(s.toastTimer);
    s.toastTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove("is-in");
    }, 2000);
  }

  /* ---------------- 启动 ---------------- */
  syncUnits();
  renderActions();
  updateHeader();
  renderHandButtons();
  updateHandButtonsVisible();
  s.busy = true;
  (async () => {
    await sleep(120);
    await playEvents(initialEvents);
    s.busy = false;
    if (s.destroyed) return;
    finishStep();
  })();

  return session;
}
