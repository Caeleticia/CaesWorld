/**
 * training-battle.js —— 训练场：战斗界面
 *
 * 战斗逻辑全部在 engine/battle.js 的 side 模式里：
 *   每回合双方入场新单位 → 回合开始效果 → 红方先手、双方交替各行动 1 次
 *   → 回合结束效果 → 下一回合
 * 这里只负责「表现」：
 *   · 卡牌（3:4 正面、血条、卡面外侧状态图标、点开数据面板；效果 / 技能可点开介绍）
 *   · 行动栏（选单位 / 选技能 / 选目标 / 结束行动）
 *   · 人机自动行动
 *   · canvas 特效（飞弹 / 爆炸 / 光环 / 命中跳字）——坐标用舞台设计坐标，
 *     卡牌位置变了也不会错位（见 battle-fx.js）
 *
 * 事件播放采用「先让引擎同步跑完、再把事件排队演出来」：
 * 引擎是同步的，onEvent 把事件收进 buffer，UI 按节奏逐个播放，
 * 命中时才更新血条 / 跳字 / 爆炸，保证特效和数字对得上。
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
import { chooseAISkill } from "./battle-ai.js";

const $ = (sel, root = document) => root.querySelector(sel);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};
const pct = (v) => {
  const n = (Number(v) || 0) * 100;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
};
const firstChar = (s) => {
  const chars = [...String(s || "?")];
  return chars[0] || "?";
};
/** 自定义效果色上的文字颜色 */
const contrastOn = (hex) => {
  const raw = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return "#fff";
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.62 ? "#17393c" : "#fff";
};
const sideName = (side) => (side === "ally" ? "红方" : "蓝方");
const sideKey = (side) => (side === "ally" ? "red" : "blue");

/** 当前打开的战斗会话（同一时间只有一个） */
let current = null;


/**
 * 打开训练对战。
 * @param {object} opts
 * @param {object} opts.registry 已载入的内容注册表
 * @param {{maxUnits:number, red:string[], blue:string[], redInvincible:boolean, blueInvincible:boolean, redAI:boolean, blueAI:boolean}} opts.config
 * @param {function} [opts.onExit] 返回配置界面
 */
export function openBattle({ registry, config, onExit }) {
  if (current) current.stop();
  const page = $("#battle-page");
  const stage = $("#battle-stage");
  if (!page || !stage) throw new Error("战斗页面不存在");
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
    /** 玩家本次技能选中的目标：供「选择单位」积木优先采用 */
    preferredTargets: [],
    timers: new Set(),
    sleepers: new Map(),
    displayHp: new Map(),
    cardEls: new Map(),
    log: [],
    statusSig: new Map(),
    effectBarSig: new Map(),
    resultShown: false,
    aiStall: 0,
    aiStalled: false,
    /** 已结算但还没播完退场动画的单位：刷新时先留在场上 */
    deathPending: new Set(),
  };

  page.hidden = false;
  page.classList.remove("is-opening");
  void page.offsetWidth;
  page.classList.add("is-opening");

  const refs = {
    redGrid: $("#tb-red-zone"),
    blueGrid: $("#tb-blue-zone"),
    redDeck: $("#tb-red-deck"),
    blueDeck: $("#tb-blue-deck"),
    redBadge: $("#tb-red-badge"),
    blueBadge: $("#tb-blue-badge"),
    round: $("#tb-round"),
    status: $("#tb-status"),
    turn: $("#tb-turn"),
    turnSide: $("#tb-turn-side"),
    turnHint: $("#tb-turn-hint"),
    log: $("#tb-log"),
    actions: $("#tb-actions"),
    detail: $("#tb-detail"),
    result: $("#tb-result"),
    canvas: $("#tb-fx"),
  };

  /** 数据面板当前对应的单位；从技能 / 效果介绍返回时用 */
  let detailUnitUid = null;

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
    // 转屏后卡牌可用空间变了，重新算格子与卡宽（否则 --card-w 还是旧方向的）
    if (s.battle && !s.destroyed) syncUnits();
  });
  const design = STAGE_DESIGN[s.scaler.orient];
  s.fx = new BattleFX(refs.canvas);
  s.fx.resize(design.w, design.h, (window.devicePixelRatio || 1) * s.scaler.scale);

  /* ---------------- 建战斗（先收初始事件） ---------------- */
  s.capture = [];
  try {
    s.battle = createBattle({
      registry,
      mode: BATTLE_MODE.SIDE,
      decks: { ally: config.red.slice(), enemy: config.blue.slice() },
      maxUnits: config.maxUnits,
      summonLimit: config.maxUnits,
      slotsPerSide: config.maxUnits,
      firstSide: "ally",
      maxCycles: 60,
      seed: (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0,
      invincibleSides: [
        ...(config.redInvincible ? ["ally"] : []),
        ...(config.blueInvincible ? ["enemy"] : []),
      ],
      chooseTargets: ({ candidates, multiple }) => {
        const list = candidates || [];
        if (!list.length) return null;
        // 玩家手动选过的目标优先；其余情况才回落到第一个候选
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
    s.deathPending.clear();
    s.fx?.destroy();
    s.scaler?.destroy();
    window.removeEventListener("hashchange", onHash);
    window.removeEventListener("keydown", onKey);
    refs.detail.hidden = true;
    refs.result.hidden = true;
    detailUnitUid = null;
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
    openBattle({ registry, config, onExit });
  };
  const onHash = () => {
    if (location.hash !== "#training") {
      stop();
      page.hidden = true;
      page.classList.remove("is-opening");
    }
  };
  window.addEventListener("hashchange", onHash);
  const backBtn = $("#battle-back");
  if (backBtn) backBtn.onclick = closeToConfig;
  window.addEventListener("keydown", onKey);

  function onKey(e) {
    if (e.key === "Escape") {
      if (!refs.detail.hidden) {
        refs.detail.hidden = true;
        detailUnitUid = null;
        return;
      }
      if (!refs.result.hidden) return;
      closeToConfig();
    }
  }

  const session = {
    stop,
    close: closeToConfig,
    get battle() {
      return s.battle;
    },
  };
  current = session;

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
    // act 阶段：还没选技能、也还没用技能时，点另一个未行动单位可以换行动单位
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
    const stats = s.battle.statsOf(unit);
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
      !s.busy &&
      s.pending &&
      active &&
      pub.side !== active.side &&
      pub.state === "alive";
    wrap.classList.toggle("is-targetable", Boolean(targetable));

    // 卡面外状态 / 效果图标
    const statuses = statusesOf(unit);
    // 签名要带上层数 / 剩余次数，否则叠加后图标标题不刷新
    const sig = statuses.map((x) => `${x.key}:${x.title}`).join("|");
    if (s.statusSig.get(pub.uid) !== sig) {
      s.statusSig.set(pub.uid, sig);
      const box = wrap.querySelector(".tbt-statuses");
      if (box) {
        box.innerHTML = statuses
          .slice(0, 5)
          .map((st) => {
            const style = st.color
              ? ` style="background:${escapeHtml(st.color)};border-color:${escapeHtml(
                  st.color
                )};color:${escapeHtml(st.textColor)}"`
              : "";
            return `<button class="tbt-status-ico ${st.cls}" type="button" data-uid="${escapeHtml(
              pub.uid
            )}" title="${escapeHtml(st.title)}"${style}>${escapeHtml(st.glyph)}${
              st.count ? `<span class="tbt-status-count" aria-hidden="true">${escapeHtml(String(st.count))}</span>` : ""
            }</button>`;
          })
          .join("") +
          (statuses.length > 5
            ? `<button class="tbt-status-ico is-more" type="button" data-uid="${escapeHtml(pub.uid)}" title="还有 ${
                statuses.length - 5
              } 个">+${statuses.length - 5}</button>`
            : "");
      }
    }

    // 条式显示的效果：血条上方的进度条
    const bars = effectBarsOf(unit);
    const barSig = bars
      .map((b) => `${b.key}:${b.current}/${b.max}:${b.ratio}:${b.color}:${b.inverted}`)
      .join("|");
    if (s.effectBarSig.get(pub.uid) !== barSig) {
      s.effectBarSig.set(pub.uid, barSig);
      const box = wrap.querySelector(".tbt-card-effectbars");
      if (box) {
        box.hidden = bars.length === 0;
        box.innerHTML = bars
          .map(
            (b) => `<span class="tbt-card-effectbar" title="${escapeHtml(b.title)}" aria-label="${escapeHtml(
              b.title
            )}">
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
    const invincible = unit.invincible || s.battle.state.invincibleSides.includes(unit.side);
    if (invincible) out.push({ key: "inv", glyph: "无", cls: "is-invincible", title: "无敌" });
    for (const layer of unit.effects || []) {
      const def = s.registry.getEffect(layer.id);
      // 条式显示的效果不走左上角图标，改走血条上方的进度条
      if (def && def.bar) continue;
      const polarity = effectPolarityOf(def);
      const custom = parseEffectColor(def?.color);
      out.push({
        key: `e:${layer.id}`,
        glyph: firstChar(def?.name || layer.id),
        cls: polarity === "negative" ? "is-bad" : polarity === "special" ? "is-special" : "is-good",
        color: custom || "",
        textColor: custom ? contrastOn(custom) : "",
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

  /** 条式显示的效果：当前层数 / 上限，反转时进度 = (上限 - 当前) / 上限 */
  function effectBarsOf(unit) {
    const out = [];
    for (const layer of unit.effects || []) {
      const def = s.registry.getEffect(layer.id);
      if (!def || !def.bar) continue;
      const max = Math.max(1, Math.floor(Number(def.maxStacks) || 1));
      const current = clamp(Math.floor(Number(layer.stacks) || 0), 0, max);
      const inverted = Boolean(def.barInvert);
      // 反转条的「显示进度」是 (上限-当前)/上限，文字也按这个分子显示
      const shown = inverted ? max - current : current;
      const ratio = shown / max;
      out.push({
        key: `e:${layer.id}`,
        name: def.name || layer.id,
        glyph: firstChar(def.name || layer.id),
        current,
        shown,
        max,
        ratio,
        inverted,
        color: effectColorOf(def),
        title: `${def.name || layer.id} ${shown}/${max}${
          inverted ? ` · 反转（当前 ${current}/${max}）` : ""
        }`,
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
    const extra = 18; // 卡面外侧状态图标预留
    /** 按 count 个单位计算最优列数与卡宽（只算尺寸，不落 DOM） */
    const sizeFor = (count) => {
      let best = { cols: 1, w: 60 };
      for (let cols = 1; cols <= count; cols += 1) {
        const rows = Math.ceil(count / cols);
        const cellW = (W - gap * (cols - 1)) / cols;
        const cardW = cellW - extra;
        const cardH = (H - gap * (rows - 1)) / rows;
        const w = Math.min(cardW, cardH * 0.75, 168);
        if (w > best.w) best = { cols, w };
      }
      return best;
    };
    const layout = sizeFor(n);
    // 卡牌最大只到「场上 4 个单位」时的尺寸；1~4 个单位都保持这个大小，
    // 超过 4 个才按实际数量继续缩小。
    const cap = sizeFor(4);
    const cardW = Math.min(layout.w, cap.w);
    grid.style.setProperty("--cols", String(layout.cols));
    grid.style.setProperty("--card-w", `${Math.max(46, Math.floor(cardW))}px`);
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
        if (s.deathPending.has(pub.uid) && pub.state !== "alive") continue;
        updateCard(wrap, pub);
      }
      layoutZone(side);
    }
    updateHeader();
  }

  const refreshAll = () => {
    syncUnits();
    renderActions();
    updateHeader();
  };

  /** 血条按「命中时刻」更新，和特效同步 */
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
  function updateHeader() {
    if (!s.battle) return;
    const pb = s.battle.publicBattle();
    if (refs.round) refs.round.textContent = String(pb.turn);
    if (refs.redDeck) refs.redDeck.textContent = `牌组余 ${pb.decks.ally}`;
    if (refs.blueDeck) refs.blueDeck.textContent = `牌组余 ${pb.decks.enemy}`;
    if (refs.redBadge) refs.redBadge.innerHTML = badgeHtml("ally", pb);
    if (refs.blueBadge) refs.blueBadge.innerHTML = badgeHtml("enemy", pb);

    const side = pb.sideTurn;
    const active = activeUnit();
    let statusText = "战斗结束";
    if (pb.status === "running") {
      if (pb.phase === "select") statusText = `${sideName(side)}行动`;
      else if (pb.phase === "act") statusText = `${active ? active.name : sideName(side)} 行动中`;
      else statusText = "战斗结束";
    }
    if (refs.status) {
      refs.status.textContent = statusText;
      refs.status.dataset.side = sideKey(side);
    }
    if (refs.turn) {
      refs.turn.dataset.side = sideKey(side);
      if (refs.turnSide) {
        refs.turnSide.textContent = pb.status === "running" ? `${sideName(side)}行动` : "战斗结束";
      }
    }
  }

  function badgeHtml(side, pb) {
    const chips = [];
    if ((side === "ally" ? s.config.redInvincible : s.config.blueInvincible) || pb.invincibleSides.includes(side)) {
      chips.push(`<span class="chip is-on">无敌</span>`);
    }
    if (!isHumanSide(side)) chips.push(`<span class="chip">人机</span>`);
    return chips.join("");
  }

  function renderActions() {
    if (!refs.actions || !s.battle) return;
    const pb = s.battle.publicBattle();
    const el = refs.actions;
    if (pb.status !== "running" || pb.phase === "finished") {
      el.innerHTML = `<span class="tbt-act-hint"><b>战斗结束</b> · 可以查看单位数据，或返回配置再来一局。</span>`;
      return;
    }
    if (s.busy) {
      el.innerHTML = `<div class="tbt-wait"><span class="tbt-spinner"></span>${
        pb.phase === "act" ? "行动结算中…" : "准备中…"
      }</div>`;
      return;
    }
    const side = pb.sideTurn;
    if (pb.phase === "select") {
      if (!isHumanSide(side)) {
        el.innerHTML = `<div class="tbt-wait"><span class="tbt-spinner"></span>${sideName(side)}（人机）正在选择行动单位…</div>`;
        return;
      }
      const units = pb.units
        .filter((u) => u.side === side && u.state === "alive" && !u.acted)
        .sort((a, b) => Math.abs(a.slot) - Math.abs(b.slot));
      el.innerHTML = `
        <div class="tbt-act-hint"><b>${sideName(side)}行动</b></div>
        <div class="tbt-skills">
          ${units
            .map(
              (u) =>
                `<button class="tbt-skill" type="button" data-pick="${escapeHtml(u.uid)}">
                  <b>${escapeHtml(u.name)}</b>
                  <span>ATK ${fmt(u.atk)} · HP ${fmt(u.hp)}</span>
                </button>`
            )
            .join("")}
        </div>`;
      return;
    }
    // phase = act
    const active = activeUnit();
    if (!active) {
      el.innerHTML = `<span class="tbt-act-hint">单位已不在场，正在切换行动方…</span>`;
      return;
    }
    const card = active.card || {};
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
      ? `<button class="tbt-skill is-cancel" type="button" data-cancel>
           <b>取消技能</b><span>返回选择技能</span>
         </button>`
      : "";
    // 选中技能时在行动选择区展示技能描述
    const pendingSkill = s.pending ? skills[s.pending.index] : null;
    const skillDesc = pendingSkill
      ? `<div class="tbt-skill-desc" role="note">
           <b>${escapeHtml(pendingSkill.name)}</b>
           <span>${escapeHtml(pendingSkill.description || "这个技能还没有填写描述。")}</span>
         </div>`
      : "";
    const targetTip = s.pending
      ? `<div class="tbt-act-hint"><b>选择目标</b> · 点击${sideName(
          active.side === "ally" ? "enemy" : "ally"
        )}单位</div>`
      : `<div class="tbt-act-hint">选择一个技能，或结束行动；点其他未行动单位可换人</div>`;
    el.innerHTML = `
      <div class="tbt-act-head">
        <img class="tbt-act-portrait" src="${resolveCardImage(card)}" alt="" draggable="false"
             onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
        <span class="tbt-act-name">
          <b>${escapeHtml(active.name)}</b>
          <span>HP ${Math.ceil(active.hp)} / ${Math.ceil(s.battle.statsOf(active).hp)}</span>
        </span>
        <button class="btn tiny" type="button" data-info="${escapeHtml(active.uid)}">数据</button>
      </div>
      ${targetTip}
      ${skillDesc}
      <div class="tbt-skills">${skillButtons || `<span class="tbt-act-hint">没有主动技能</span>`}${cancelSkillButton}</div>
      <button class="tbt-end" type="button" data-end>结束行动</button>`;
  }

  /* ---------------- 数据面板 ---------------- */
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
        parts.push(percentKey.test(key) || key.endsWith("Mul") ? `${name} ${v > 0 ? "+" : ""}${pct(v)}` : `${name} ${v > 0 ? "+" : ""}${fmt(v)}`);
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

  /** 数据面板里的效果列表：单位效果 + 运行时增益（技能 / 效果介绍按同一索引取） */
  function collectEffects(unit) {
    const effects = [];
    for (const layer of unit.effects || []) {
      const def = s.registry.getEffect(layer.id);
      effects.push({
        key: `e:${layer.id}`,
        name: def?.name || layer.id,
        stacks: def?.stackable ? layer.stacks : null,
        desc: effectDesc(def),
        icon: resolveCardIcon(def),
        polarity: effectPolarityOf(def),
        tag: layer.inheritedFrom ? "继承" : "",
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

  function openDetail(uid) {
    const unit = unitOf(uid);
    if (!unit || !refs.detail) return;
    detailUnitUid = uid;
    const card = unit.card || {};
    const stats = s.battle.statsOf(unit);
    const pub = pubOf(uid);
    const quality = QUALITY_LABEL[card.quality] || card.quality || "白";
    const status = pub?.acted ? "本回合已行动" : "本回合未行动";
    const invincible = unit.invincible || s.battle.state.invincibleSides.includes(unit.side);
    const effects = collectEffects(unit);
    const resist = stats.resistances || {};
    const skills = s.battle.allSkillsOf(unit);

    refs.detail.innerHTML = `
      <div class="tbt-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(unit.name)} 的数据">
        <header class="tbt-sheet-head">
          <img src="${resolveCardImage(card)}" alt="" draggable="false"
               onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'" />
          <div class="tbt-sheet-title">
            <h3>${escapeHtml(unit.name)}</h3>
            <p>${escapeHtml(sideName(unit.side))} · ${escapeHtml(quality)} · Lv.${card.level ?? 1} · ${status}${
              invincible ? " · 无敌" : ""
            }</p>
          </div>
          <button class="tbt-close" type="button" data-close-detail aria-label="关闭">×</button>
        </header>
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
          <section class="tbd-section">
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
          </section>
        </div>
      </div>`;
    refs.detail.hidden = false;
  }

  /** 技能 / 效果介绍的小面板：保留「返回角色」和关闭 */
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

  function openSkillIntro(uid, skillId) {
    const unit = unitOf(uid);
    const skill = unit ? s.battle.allSkillsOf(unit).find((sk) => sk.id === skillId) : null;
    if (!skill || !refs.detail) return;
    detailUnitUid = uid;
    const type = skill.type === "active" ? "主动技能" : "被动技能";
    const nodes = Array.isArray(skill.flow?.nodes) ? skill.flow.nodes.length : 0;
    refs.detail.innerHTML = entrySheet({
      glyph: "技",
      icon: resolveCardIcon(skill),
      title: skill.name,
      subtitle: [type, nodes ? `流程 ${nodes} 块` : "", unit.name].filter(Boolean).join(" · "),
      body: `<section class="tbd-section">
        <h4>技能介绍</h4>
        <p class="tbd-entry-desc">${escapeHtml(skill.description || "这个技能还没有填写介绍。")}</p>
      </section>`,
    });
    refs.detail.hidden = false;
    refs.detail.querySelector("[data-back-detail]")?.focus();
  }

  function openEffectIntro(uid, effectKey) {
    const unit = unitOf(uid);
    const eff = unit ? collectEffects(unit).find((item) => item.key === effectKey) : null;
    if (!eff || !refs.detail) return;
    detailUnitUid = uid;
    const meta = [
      eff.polarity ? EFFECT_POLARITY_LABEL[eff.polarity] : "",
      eff.tag || "",
      eff.stacks ? `${eff.stacks} 层` : "",
    ].filter(Boolean);
    refs.detail.innerHTML = entrySheet({
      glyph: "效",
      icon: eff.icon,
      title: eff.name,
      subtitle: [...meta, unit.name].join(" · "),
      body: `<section class="tbd-section">
        <h4>效果介绍</h4>
        <p class="tbd-entry-desc">${escapeHtml(eff.desc)}</p>
      </section>`,
    });
    refs.detail.hidden = false;
    refs.detail.querySelector("[data-back-detail]")?.focus();
  }

  /* ---------------- 日志 ---------------- */
  function addLog(text, kind = "") {
    s.log.push({ text, kind });
    if (s.log.length > 30) s.log.shift();
    if (!refs.log) return;
    const items = s.log.slice(-6);
    refs.log.innerHTML = items
      .map((line) => `<div class="tbt-log-line ${line.kind}">${escapeHtml(line.text)}</div>`)
      .join("");
  }

  /* ---------------- 特效播放 ---------------- */
  const attrName = (attr) => ATTRIBUTE_INFO[attr]?.label || "物理";

  /** 伤害日志：单体与群攻共用 */
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

  /** 命中表现：爆炸 / 冲击、跳字、受击闪烁 */
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
    // 附加伤害不视为攻击：没有飞弹，直接在目标身上收拢一下就结算
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
    // 附加伤害的跳字要留够时间让人看清「附加」标签
    await sleep(additional ? 220 : ev.finalDamage > 0 ? 150 : 120);
  }

  /**
   * 一次群攻的多个命中同时播放：所有飞弹一起出发，命中后一起爆炸 / 跳字 / 扣血。
   * 循环体里的每次攻击是独立的批次，仍会按顺序逐个播放（见 playEvents）。
   */
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
      // 统一命中时间：群攻的飞弹一起出发、一起到达
      launches.push(s.fx.launch(e.aRect, e.tRect, { attribute: e.ev.attribute, arriveIn: 0.32 }));
    }
    // 没有飞弹（附加伤害 / 没拿到卡牌位置）时也给一个统一的蓄力节拍
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
    await sleep(260);
  }

  async function playEvents(events) {
    if (!events || !events.length) return;
    // 引擎同步结算时已经把人打死了，但 UI 还没播到退场：先别让刷新把卡删掉，
    // 附加伤害（DOT）击杀时才会正常显示冲击、跳字和退场动画。
    for (const ev of events) {
      if (ev && ev.type === "death" && ev.unit) s.deathPending.add(ev.unit);
    }
    // 同一次「攻击」积木产生的多目标命中共享 attackGroup：整组同时播放。
    // 循环体里的每轮攻击是不同批次，所以仍会一轮一轮依次播放。
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
        case "battle:start":
          break;
        case "round:start": {
          addLog(`—— 第 ${ev.turn} 回合 ——`, "is-sys");
          if (refs.turn) {
            refs.turn.classList.remove("is-flash");
            void refs.turn.offsetWidth;
            refs.turn.classList.add("is-flash");
          }
          updateHeader();
          await sleep(220);
          break;
        }
        case "side:turn": {
          updateHeader();
          refreshAll();
          await sleep(110);
          break;
        }
        case "summon": {
          syncUnits();
          const unit = unitOf(ev.unit);
          const rect = rectOf(ev.unit);
          if (rect) s.fx.aura(rect, { kind: "enter" });
          if (unit) {
            addLog(
              `${unit.name} 入场（${sideName(unit.side)}${ev.cause === "deploy" ? " · 本回合新入场" : ""}）`,
              sideKey(unit.side) === "red" ? "is-red" : "is-blue"
            );
          }
          await sleep(ev.cause === "deploy" ? 150 : 220);
          break;
        }
        case "skill": {
          const caster = unitOf(ev.caster);
          addLog(
            `${caster ? caster.name : "?"} 使用「${ev.skillName}」`,
            caster && sideKey(caster.side) === "red" ? "is-red" : "is-blue"
          );
          await sleep(180);
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
          if (rect) {
            s.fx.aura(rect, { kind: "buff" });
            s.fx.floatText(rect, ev.buff?.label || "效果", { kind: "mute", size: 14, life: 0.7 });
          }
          if (unit) addLog(`${unit.name} 获得「${ev.buff?.label || "效果"}」`, sideKey(unit.side) === "red" ? "is-red" : "is-blue");
          syncUnits();
          await sleep(140);
          break;
        }
        case "effect:added": {
          const unit = unitOf(ev.unit);
          const def = s.registry.getEffect(ev.effect);
          const rect = rectOf(ev.unit);
          if (rect) s.fx.aura(rect, { kind: "buff" });
          if (unit) {
            const label = def?.name || ev.effect;
            addLog(def?.stackable ? `${unit.name} 叠加「${label}」×${ev.stacks}` : `${unit.name} 获得「${label}」`, "is-sys");
          }
          syncUnits();
          // 效果可能挂载了技能：持有者若正在行动，行动栏的技能列表要立刻跟着变
          renderActions();
          await sleep(120);
          break;
        }
        case "effect:removed": {
          // 层数变化 / 移除后立刻刷新进度条，避免已失效的效果还挂在血条上方；
          // 效果挂载的技能也会随效果消失，行动栏一起刷新
          syncUnits();
          renderActions();
          await sleep(80);
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
          await sleep(300);
          break;
        }
        case "exit": {
          const unit = unitOf(ev.unit);
          const wrap = s.cardEls.get(ev.unit);
          if (wrap) {
            wrap.classList.add("is-dead");
            s.cardEls.delete(ev.unit);
            s.statusSig.delete(ev.unit);
            setTimeout(() => wrap.remove(), 340);
          }
          if (unit) addLog(`${unit.name} 离场`, "is-sys");
          await sleep(220);
          break;
        }
        case "battle:end": {
          const winner = ev.winner === "ally" ? "红方" : ev.winner === "enemy" ? "蓝方" : "平局";
          addLog(`战斗结束：${winner}`, "is-sys");
          await sleep(300);
          break;
        }
        case "flow:error": {
          const msg = ev.reason || (Array.isArray(ev.errors) ? ev.errors.join("；") : "流程执行出错");
          addLog(`流程提示：${msg}`, "is-sys");
          break;
        }
        case "turn:start": {
          updateHeader();
          refreshAll();
          break;
        }
        case "turn:end":
        case "round:end":
        case "attack":
        case "hp:lost":
        case "immune":
        case "buff:expired":
        case "buff:removed":
        case "action:start":
        case "action:skip":
          break;
        case "skill:granted": {
          // 通过积木「给予技能」临时获得的技能：立刻出现在行动栏里
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
    refreshAll();
    if (s.battle.state.phase !== "act") finishStep();
  }

  async function executeSkill(index, targetUid) {
    if (s.busy || s.destroyed) return;
    s.pending = null;
    s.busy = true;
    // 玩家点选的目标同时交给「选择单位」积木优先采用
    s.preferredTargets = targetUid ? [targetUid] : [];
    refreshAll();
    let events = [];
    try {
      events = take(() =>
        s.battle.useSkill(index, targetUid ? { targetRef: targetUid } : undefined)
      );
    } catch (err) {
      console.warn("[训练场] 使用技能失败", err);
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
    syncUnits();
    renderActions();
    updateHeader();
    const pb = s.battle.publicBattle();
    if (pb.status !== "running" || pb.phase === "finished") {
      showResult();
      return;
    }
    if (pb.phase === "select" && !isHumanSide(pb.sideTurn)) maybeAI();
  }

  function maybeAI() {
    if (s.busy || s.destroyed || s.aiStalled) return;
    const pb = s.battle.publicBattle();
    if (pb.status !== "running" || pb.phase !== "select") return;
    if (isHumanSide(pb.sideTurn)) return;
    s.busy = true;
    renderActions();
    const before = s.battle.state.actionSeq;
    (async () => {
      await sleep(620);
      try {
        if (s.destroyed) return;
        await runAIStep();
        if (s.battle.state.actionSeq === before && s.battle.state.status === "running" && s.battle.state.phase === "select") {
          s.aiStall += 1;
          if (s.aiStall > 3) {
            s.aiStalled = true;
            addLog("人机无法继续行动（没有可用单位或技能）", "is-sys");
            renderActions();
            return;
          }
        } else {
          s.aiStall = 0;
        }
      } catch (err) {
        console.error("[训练场] 人机行动出错", err);
        addLog(`人机行动出错：${String(err.message || err)}`, "is-sys");
      } finally {
        s.busy = false;
        if (!s.destroyed && !s.aiStalled) finishStep();
      }
    })();
  }

  async function runAIStep() {
    const pb = s.battle.publicBattle();
    if (pb.status !== "running" || pb.phase !== "select") return;
    const candidates = pb.units.filter((u) => u.side === pb.sideTurn && u.state === "alive" && !u.acted);
    if (!candidates.length) return;
    candidates.sort((a, b) => b.atk - a.atk);
    const pick = Math.random() < 0.72 ? candidates[0] : candidates[Math.floor(Math.random() * candidates.length)];

    const selectEvents = take(() => s.battle.selectUnit(pick.uid));
    await playEvents(selectEvents);
    if (s.destroyed) return;
    if (s.battle.state.phase !== "act") return;

    const active = activeUnit();
    if (!active) return;
    const choice = chooseAISkill(s.battle, active, s.registry);
    if (choice) {
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
  }

  /* ---------------- 结果 ---------------- */
  function showResult() {
    if (s.resultShown || s.destroyed || !refs.result) return;
    s.resultShown = true;
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
          : "一方场上单位全部退场";
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
    refs.result.querySelector("[data-again]")?.addEventListener("click", restart);
    refs.result.querySelector("[data-back-config]")?.addEventListener("click", closeToConfig);
  }

  /* ---------------- 事件绑定 ---------------- */
  refs.redGrid.innerHTML = "";
  refs.blueGrid.innerHTML = "";
  const onBoardClick = (event) => {
    const statusBtn = event.target.closest("[data-status-uid], .tbt-status-ico");
    if (statusBtn) {
      const uid = statusBtn.dataset.uid || statusBtn.closest(".tbt-unit")?.dataset.uid;
      if (uid) openDetail(uid);
      return;
    }
    const wrap = event.target.closest(".tbt-unit");
    if (!wrap) return;
    const uid = wrap.dataset.uid;
    if (!uid) return;
    const pb = s.battle.publicBattle();
    const pub = pb.units.find((u) => u.uid === uid);
    if (s.pending) {
      const active = activeUnit();
      if (pub && active && pub.side !== active.side && pub.state === "alive") {
        executeSkill(s.pending.index, uid);
      } else {
        // 不在当前可选目标范围 → 打开详情
        openDetail(uid);
      }
      return;
    }
    if (s.busy) {
      openDetail(uid);
      return;
    }
    if (canPickUnit(pub || {})) {
      pickUnit(uid);
      return;
    }
    openDetail(uid);
  };
  if (refs.redGrid) refs.redGrid.onclick = onBoardClick;
  if (refs.blueGrid) refs.blueGrid.onclick = onBoardClick;

  if (refs.actions) refs.actions.onclick = (event) => {
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
    if (info) return openDetail(info.dataset.info);
  };

  function chooseSkill(index) {
    if (s.busy) return;
    const active = activeUnit();
    if (!active) return;
    const skill = s.battle.allSkillsOf(active)[index];
    if (!skill) return;
    // 再次点同一个技能 = 取消选择，回到技能列表
    if (s.pending && s.pending.index === index) {
      s.pending = null;
      refreshAll();
      return;
    }
    // 全体 / 固定目标 / 纯自身等技能不需要选目标：直接施放，不进入选目标状态
    if (!skillNeedsPlayerTarget(skill)) {
      executeSkill(index, null);
      return;
    }
    // 需要选目标的技能：即使只有一个敌人，也由玩家手动点选目标
    const enemies = s.battle.publicBattle().units.filter((u) => u.side !== active.side && u.state === "alive");
    if (!enemies.length) {
      executeSkill(index, null);
      return;
    }
    s.pending = { index };
    refreshAll();
  }

  if (refs.detail) {
    refs.detail.onclick = (event) => {
      if (event.target === refs.detail || event.target.closest("[data-close-detail]")) {
        refs.detail.hidden = true;
        detailUnitUid = null;
        return;
      }
      const back = event.target.closest("[data-back-detail]");
      if (back && detailUnitUid) {
        openDetail(detailUnitUid);
        return;
      }
      const skill = event.target.closest("[data-skill-id]");
      if (skill && detailUnitUid) {
        openSkillIntro(detailUnitUid, skill.dataset.skillId);
        return;
      }
      const eff = event.target.closest("[data-effect-key]");
      if (eff && detailUnitUid) {
        openEffectIntro(detailUnitUid, eff.dataset.effectKey);
      }
    };
    // 效果条目是 div + role=button，原生不会把 Enter / 空格转成 click，这里补上
    refs.detail.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const eff = event.target.closest("[data-effect-key]");
      if (!eff || !detailUnitUid) return;
      event.preventDefault();
      openEffectIntro(detailUnitUid, eff.dataset.effectKey);
    };
  }

  /* ---------------- 启动 ---------------- */
  syncUnits();
  renderActions();
  updateHeader();
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
