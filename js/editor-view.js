/**
 * editor-view.js —— 编辑器交互层
 *
 *  · 角色 / 技能 / 效果 的填写表单
 *  · 积木画布：拖拽积木、拖拽端口连线、长按空白滑动切断、画布平移缩放
 *  · 实时生成「积木 JSON」与「执行流程 JSON」，并保存到 localStorage
 *
 * 纯前端，不依赖任何第三方库。引擎只负责数据结构与解释执行（engine/）。
 */
import {
  buildFlowCatalog,
  BLOCK_GROUPS,
  DATA_TYPE_LABEL,
  inputPortIds,
  prepareFlow,
  createProject,
  createCharacter,
  createSkill,
  createEffect,
  characterToUnit,
  projectToContent,
  PLACEHOLDER_IMAGE as PLACEHOLDER,
  resolveImage,
} from "../engine/index.js";

const STORAGE_KEY = "caeworld:editor-project";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ================================================================== */
/* 状态                                                                */
/* ================================================================== */
let project = loadProject();

let active = { tab: "character", skillId: null, effectId: null, triggerId: null };

/** 换一个工程（导入用）；页面上的表单与画布一起重绘 */
function setProject(p) {
  project = p;
  active = { tab: "character", skillId: p.skills[0] ? p.skills[0].id : null, effectId: p.effects[0] ? p.effects[0].id : null, triggerId: null };
  renderAll();
  switchTab("character");
}
let dirty = false;
let saveTimer = 0;
const catalog = buildFlowCatalog();

function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.kind === "caeworld-editor-project") return p;
    }
  } catch {
    /* 读不出来就用空白工程 */
  }
  return createProject();
}

function markDirty() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  project.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    dirty = false;
    setStatus("已保存到本地", "ok");
  } catch (err) {
    setStatus("保存失败：" + err.message, "bad");
  }
}

function setStatus(text, kind = "") {
  const el = $("#ed-status");
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

/* ================================================================== */
/* 当前正在编辑的卡                                                    */
/* ================================================================== */
function currentSkill() {
  return (project.skills || []).find((s) => s.id === active.skillId) || null;
}

function currentEffect() {
  return (project.effects || []).find((e) => e.id === active.effectId) || null;
}

/** 当前标签页对应的「牌」（技能或效果） */
function currentCard() {
  if (active.tab === "skills") return currentSkill();
  if (active.tab === "effects") return currentEffect();
  return null;
}

/** 编辑器提供一份精简视图给引擎自测（tests/ui-dom.js 用） */
export function getView() {
  return {
    active: { ...active },
    uiAvailable: Boolean(effectEligible()),
  };
}

/**
 * 效果里放「触发」积木之前的检查：
 * 触发流程的积木 id 必须和效果卡登记的触发规则一致，才可能被引擎执行。
 */
function effectEligible() {
  const card = currentEffect();
  if (!card || !active.triggerId) return false;
  const t = (card.triggers || []).find((x) => x.block.id === active.triggerId);
  if (!t) return false;
  const flow = card.flows && card.flows[active.triggerId];
  return Boolean(flow && flow.nodes.some((n) => n.id === t.block.id && n.type === "trigger"));
}

/** 当前正在编辑的流程：技能只有一条流程；效果按触发积木各有一条 */
function currentFlow() {
  const card = currentCard();
  if (!card) return null;
  if (active.tab === "skills") return card.flow;
  const trigger = (card.triggers || []).find((t) => t.block.id === active.triggerId) || null;
  if (!trigger) return null;
  card.flows = card.flows || {};
  if (!card.flows[trigger.block.id]) card.flows[trigger.block.id] = { schema: 1, kind: "flow", nodes: [], links: [] };
  return card.flows[trigger.block.id];
}

/* ================================================================== */
/* 渲染：标签页                                                         */
/* ================================================================== */
function switchTab(tab) {
  active.tab = tab;
  $$(".ed-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
  // 技能与效果共用「数据 + 流程」面板，左侧表单在技能 / 效果之间切换
  const panel = tab === "character" ? "character" : "skills";
  $$(".ed-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === panel));
  const skillCol = $("#ed-skill-col");
  const effectCol = $("#ed-effect-col");
  if (skillCol) skillCol.hidden = tab !== "skills";
  if (effectCol) effectCol.hidden = tab !== "effects";
  renderAll();
}

function flowTriggerLabel() {
  const card = currentEffect();
  if (!card) return "无效果";
  if (!active.triggerId) return "未选择触发";
  const t = (card.triggers || []).find((x) => x.block.id === active.triggerId);
  return t ? TRIGGER_LABEL[t.block.event] || t.block.event : "未选择触发";
}

function renderAll() {
  renderPalette();
  renderCharacter();
  renderSkillPanel();
  renderEffectPanel();
  renderFlow();
  renderJson();
  renderCardsList();
}

function renderCardsList() {
  // 角色卡预览 & 挂载列表
  const ch = project.character;
  const preview = $("#ed-card-preview");
  if (preview) {
    preview.innerHTML = `
      <img src="${resolveImage(ch.image)}" alt="${escapeHtml(ch.name || "角色")}" onerror="this.src='${PLACEHOLDER}'" />
      <div class="card-meta">
        <strong>${escapeHtml(ch.name || "未命名角色")}</strong>
        <span>${escapeHtml(ch.id)}</span>
        <span class="quality q-${escapeHtml(ch.quality)}">${({ white: "白", blue: "蓝", gold: "金", rainbow: "彩" })[ch.quality] || ch.quality}</span>
      </div>`;
  }
  const skillsBox = $("#ed-mount-skills");
  if (skillsBox) {
    skillsBox.innerHTML = (project.skills || [])
      .map(
        (s) => `<label class="mount-row"><input type="checkbox" data-mount="skill" value="${escapeHtml(s.id)}" ${
          (ch.skillIds || []).includes(s.id) ? "checked" : ""
        } /> <span>${escapeHtml(s.name || s.id)}</span><code>${escapeHtml(s.id)}</code></label>`
      )
      .join("") || `<p class="hint">还没有技能，去「技能」里新建一个。</p>`;
  }
  const effectsBox = $("#ed-mount-effects");
  if (effectsBox) {
    effectsBox.innerHTML =
      (project.effects || [])
        .map(
          (e) => `<label class="mount-row"><input type="checkbox" data-mount="effect" value="${escapeHtml(e.id)}" ${
            (ch.effectIds || []).includes(e.id) ? "checked" : ""
          } /> <span>${escapeHtml(e.name || e.id)}</span><code>${escapeHtml(e.id)}</code></label>`
        )
        .join("") || `<p class="hint">还没有效果，去「效果」里新建一个。</p>`;
  }
  const skillList = $("#ed-skill-list");
  if (skillList) {
    skillList.innerHTML =
      (project.skills || [])
        .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)} · ${escapeHtml(s.id)}</option>`)
        .join("") || `<option value="">（无）</option>`;
    if (active.skillId) skillList.value = active.skillId;
  }
  const effectList = $("#ed-effect-list");
  if (effectList) {
    effectList.innerHTML =
      (project.effects || [])
        .map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name || e.id)} · ${escapeHtml(e.id)}</option>`)
        .join("") || `<option value="">（无）</option>`;
    if (active.effectId) effectList.value = active.effectId;
  }
}

/* ---------------------------- 角色表单 ---------------------------- */
function renderCharacter() {
  const ch = project.character;
  const map = {
    "f-name": ch.name,
    "f-id": ch.id,
    "f-quality": ch.quality,
    "f-level": ch.level,
    "f-hp": ch.baseHp,
    "f-atk": ch.baseAtk,
    "f-def": ch.baseDef,
    "f-crit": ch.critRate,
    "f-critdmg": ch.critDamage,
    "f-speed": ch.speed,
    "f-label": ch.label,
    "f-image": ch.image,
  };
  for (const [id, value] of Object.entries(map)) {
    const el = $("#" + id);
    if (el && document.activeElement !== el) el.value = value === undefined || value === null ? "" : value;
  }
  for (const attr of ["physical", "magic", "spirit", "origin"]) {
    const el = $(`#f-res-${attr}`);
    if (el && document.activeElement !== el) el.value = ch.resistances[attr];
  }
  for (const key of ["occupiesSlot", "countsAsUnit", "invincible"]) {
    const el = $("#f-" + (key === "occupiesSlot" ? "occupy" : key === "countsAsUnit" ? "count" : "invincible"));
    if (el) el.checked = Boolean(ch[key]);
  }
  const unit = characterToUnit(ch);
  const stats = $("#ed-unit-stats");
  if (stats) {
    stats.textContent = `Lv.${unit.level} · HP ${unit.baseHp} · ATK ${unit.baseAtk} · DEF ${unit.baseDef} · 暴击 ${(
      unit.critRate * 100
    ).toFixed(0)}% / ${(unit.critDamage * 100).toFixed(0)}%`;
  }
  const img = $("#ed-card-image");
  if (img) img.src = resolveImage(ch.image);
}

/* ---------------------------- 技能 / 效果 ---------------------------- */
function renderSkillPanel() {
  const s = currentSkill();
  const box = $("#ed-skill-form");
  if (!box) return;
  if (!s) {
    box.innerHTML = `<p class="hint">还没有技能。点「新建技能」开始。</p>`;
    return;
  }
  box.innerHTML = `
    ${field("技能名", `<input data-skill="name" value="${escapeHtml(s.name)}" />`)}
    ${field("技能 id", `<input data-skill="id" value="${escapeHtml(s.id)}" />`, "扩展包_类型_标识，类型必须是 skill")}
    ${field("类型", select("data-skill=\"type\"", [
      ["active", "主动"],
      ["passive", "被动"],
    ], s.type))}
    ${field("属性", select("data-skill=\"attribute\"", [
      ["physical", "物理"],
      ["magic", "魔法"],
      ["spirit", "精神"],
      ["origin", "本源"],
    ], s.attribute))}
    ${field("倍率", `<input type="number" step="0.1" data-skill="multiplier" value="${s.multiplier}" />`, "攻击/回复积木里接「数值」时，可选择是否乘倍率")}
    ${field("说明", `<textarea data-skill="description" rows="2">${escapeHtml(s.description || "")}</textarea>`)}
    <div class="form-actions"><button class="btn danger" data-action="delete-skill">删除技能</button></div>`;
}

function renderEffectPanel() {
  const e = currentEffect();
  const box = $("#ed-effect-form");
  if (!box) return;
  if (!e) {
    box.innerHTML = `<p class="hint">还没有效果。点「新建效果」开始。</p>`;
    return;
  }
  e.triggers = e.triggers || [];
  if (!e.triggers.some((t) => t.block.id === active.triggerId)) {
    active.triggerId = e.triggers[0] ? e.triggers[0].block.id : null;
  }
  box.innerHTML = `
    ${field("效果名", `<input data-effect="name" value="${escapeHtml(e.name)}" />`)}
    ${field("效果 id", `<input data-effect="id" value="${escapeHtml(e.id)}" />`, "扩展包_类型_标识，类型必须是 effect")}
    <div class="chips">
      <span>标记：</span>
      <label><input type="checkbox" data-effect-flag="negative" ${(e.flags || []).includes("negative") ? "checked" : ""} /> 负面（可被「移除一个负面效果」移除）</label>
      <label><input type="checkbox" data-effect-flag="unremovable" ${(e.flags || []).includes("unremovable") ? "checked" : ""} /> 不可解除（需勾选「强制移除」）</label>
    </div>
    ${field("说明", `<textarea data-effect="description" rows="2">${escapeHtml(e.description || "")}</textarea>`)}
    <div class="trigger-head">
      <span>触发流程</span>
      <button class="btn small" data-action="add-trigger">+ 新触发</button>
    </div>
    <div class="trigger-list">
      ${e.triggers.map((t) => {
        const info = TRIGGER_LABEL[t.block.event] || t.block.event;
        return `<button class="trigger-chip ${t.block.id === active.triggerId ? "is-active" : ""}" data-trigger="${escapeHtml(t.block.id)}">
          <span>${escapeHtml(info)}</span><em>${escapeHtml(t.block.id)}</em></button>`;
      }).join("") || `<p class="hint">还没有触发。效果只有存在时才会触发，先加一个触发。</p>`}
    </div>
    ${active.triggerId ? `<button class="btn small danger" data-action="delete-trigger">删除当前触发</button>` : ""}`;
}

const TRIGGER_LABEL = {
  turnStart: "回合开始时",
  turnEnd: "回合结束时",
  unitTurnStart: "单位行动开始时",
  unitTurnEnd: "单位行动结束时",
  skillCast: "单位释放技能",
  attack: "单位攻击时",
  attacked: "单位受击时",
  lethalDamage: "单位受致命伤害时",
  unitEnter: "单位入场时",
  unitExit: "单位退场时",
  heal: "单位回复生命时",
  loseHp: "单位损失生命时",
  always: "始终",
};

function field(label, control, hint) {
  return `<label class="form-field"><span>${escapeHtml(label)}</span>${control}${hint ? `<em>${escapeHtml(hint)}</em>` : ""}</label>`;
}

function select(attrs, options, value) {
  return `<select ${attrs}>${options
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(v) === String(value) ? "selected" : ""}>${escapeHtml(l)}</option>`)
    .join("")}</select>`;
}

/* ================================================================== */
/* 画布                                                                */
/* ================================================================== */
const canvasState = {
  view: { x: 40, y: 40, zoom: 1 },
  drag: null,
  pan: null,
  link: null,
  selectedId: null,
  pendingCut: null,
  erasing: false,
  nodeEls: new Map(),
};

const canvasEl = () => $("#blocks-canvas");
const worldEl = () => $("#blocks-world");

function toWorld(clientX, clientY) {
  const box = canvasEl().getBoundingClientRect();
  return {
    x: (clientX - box.left - canvasState.view.x) / canvasState.view.zoom,
    y: (clientY - box.top - canvasState.view.y) / canvasState.view.zoom,
  };
}

function syncWorld() {
  const world = worldEl();
  if (!world) return;
  world.style.transform = `translate(${canvasState.view.x}px, ${canvasState.view.y}px) scale(${canvasState.view.zoom})`;
  const label = $("#zoom-label");
  if (label) label.textContent = `${Math.round(canvasState.view.zoom * 100)}%`;
}

function blockDef(type) {
  return catalog.blocks[type];
}

function renderFlow() {
  const title = $("#flow-title");
  if (title) {
    const card = currentCard();
    title.textContent =
      active.tab === "effects"
        ? `效果流程 · ${flowTriggerLabel()}`
        : card
          ? `技能流程 · ${card.name || card.id}`
          : "流程";
  }
  const world = worldEl();
  if (!world) return;
  const flow = currentFlow();
  canvasState.nodeEls.clear();
  world.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "links");
  svg.setAttribute("width", "6000");
  svg.setAttribute("height", "6000");
  world.appendChild(svg);

  const empty = $("#flow-empty");
  if (empty) {
    if (!flow) {
      empty.hidden = false;
      empty.textContent =
        active.tab === "effects"
          ? "先在左边选一个效果，并添加一个「触发流程」，再往画布拖积木。"
          : "先在左边新建/选择一个技能，再从积木盒拖积木进来。";
    } else if (!flow.nodes.length) {
      empty.hidden = false;
      empty.textContent = "把左边积木盒里的积木拖进来，或点一下积木名直接放到画布中央。";
    } else {
      empty.hidden = true;
    }
  }
  if (!flow) {
    syncWorld();
    return;
  }

  for (const node of flow.nodes) world.appendChild(renderBlock(node, flow));
  for (const link of flow.links || []) {
    const path = makeLinkPath(link);
    if (path) svg.appendChild(path);
  }
  syncWorld();
  validateFlow();
  renderJson();
}

function renderBlock(node, flow) {
  const def = blockDef(node.type);
  const el = document.createElement("div");
  el.className = "block";
  el.dataset.id = node.id;
  el.dataset.group = def.group;
  el.style.left = `${node.pos.x}px`;
  el.style.top = `${node.pos.y}px`;
  el.style.setProperty("--block-color", def.color);
  if (canvasState.selectedId === node.id) el.classList.add("is-selected");

  const inPorts = def.ports.filter((p) => p.direction === "in");
  const outPorts = def.ports.filter((p) => p.direction === "out");
  const flowIn = inPorts.find((p) => !p.type);
  const flowOuts = outPorts.filter((p) => !p.type);
  const leftIn = inPorts.filter((p) => p.type);
  const rightOut = outPorts.filter((p) => p.type);

  const topHtml = `<div class="block-top">
      <div class="block-flow-in">${flowIn ? portHtml(flowIn, "in") : ""}</div>
      <div class="block-flow-out">${flowOuts.map((p) => portHtml(p, "out", p.label)).join("")}</div>
    </div>`;

  const rows = Math.max(leftIn.length, rightOut.length);
  const sidesHtml =
    rows === 0
      ? ""
      : `<div class="block-sides">${Array.from({ length: rows })
          .map((_, i) => {
            const li = leftIn[i];
            const ro = rightOut[i];
            const text = li ? li.label : ro ? ro.label : "";
            return `<div class="side-row">
              <span class="block-side-l">${li ? portHtml(li, "in") + `<span>${escapeHtml(li.label)}</span>` : ""}</span>
              ${text && li && ro ? `<span class="side-empty">/</span>` : ""}
              <span class="block-side-r">${ro ? `<span>${escapeHtml(ro.label || "")}</span>` + portHtml(ro, "out") : ""}</span>
            </div>`;
          })
          .join("")}</div>`;

  el.innerHTML = `${topHtml}
    <div class="block-head"><strong>${escapeHtml(def.title)}</strong><span>${escapeHtml(node.id)}</span></div>
    ${def.subtitle ? `<div class="block-sub">${escapeHtml(def.subtitle)}</div>` : ""}
    <div class="block-options">${optionsHtml(node)}</div>
    ${sidesHtml}`;
  canvasState.nodeEls.set(node.id, el);
  return el;
}

function portHtml(port, dir, label) {
  const type = port.type ? ` data-type="${port.type}"` : "";
  return `<span class="port port-${dir}" data-port="${escapeHtml(port.id)}" data-dir="${dir}"${type}${
    label ? ` data-label="${escapeHtml(label)}"` : ""
  } title="${escapeHtml(label || DATA_TYPE_LABEL[port.type] || port.id)}"></span>`;
}

function optionsHtml(node) {
  const def = blockDef(node.type);
  const opts = node.options || {};
  let html = "";
  for (const o of def.options || []) {
    if (o.showIf && !Object.entries(o.showIf).every(([k, v]) => String(opts[k]) === String(v))) continue;
    if (o.control === "select") {
      html += `<label class="opt"><span>${escapeHtml(o.label || o.key)}</span><select data-option="${o.key}">${(o.options || [])
        .map((x) => `<option value="${escapeHtml(x.value)}" ${String(x.value) === String(opts[o.key]) ? "selected" : ""}>${escapeHtml(x.label)}</option>`)
        .join("")}</select></label>`;
    } else if (o.control === "checkbox") {
      html += `<label class="opt opt-check"><input type="checkbox" data-option="${o.key}" ${opts[o.key] ? "checked" : ""}/><span>${escapeHtml(o.label || o.key)}</span></label>`;
    } else if (o.control === "number") {
      html += `<label class="opt"><span>${escapeHtml(o.label || o.key)}</span><input type="number" data-option="${o.key}" value="${escapeHtml(opts[o.key] ?? "")}"/></label>`;
    }
  }
  const constKeys = { summon: ["unitId"], summonChild: ["unitId"], giveSkill: ["skillId"], attachEffect: ["effectId"], removeEffect: ["effectId"] }[node.type] || [];
  for (const key of constKeys) {
    const label = { unitId: "单位 id", skillId: "技能 id", effectId: "效果 id" }[key];
    html += `<label class="opt"><span>${label}</span><input data-constant="${key}" value="${escapeHtml(opts[key] ?? "")}" placeholder="扩展包_类型_标识"/></label>`;
  }
  return html;
}

function portCenter(el) {
  const world = worldEl().getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - world.left, y: r.top + r.height / 2 - world.top };
}

function makeLinkPath(link) {
  const fromEl = canvasState.nodeEls.get(link.from);
  const toEl = canvasState.nodeEls.get(link.to);
  if (!fromEl || !toEl) return null;
  const fromPort = fromEl.querySelector(`.port[data-port="${cssEsc(link.port)}"][data-dir="out"]`);
  const toPort = toEl.querySelector(`.port[data-port="${cssEsc(link.portTo)}"][data-dir="in"]`);
  if (!fromPort || !toPort) return null;
  const a = portCenter(fromPort);
  const b = portCenter(toPort);
  const isFlow = !fromPort.dataset.type && !toPort.dataset.type;
  let d;
  if (isFlow) {
    const midY = Math.min(a.y, b.y) - 30;
    d = `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
  } else {
    const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
    d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("class", `link ${isFlow ? "link-flow" : "link-data"}`);
  if (isFlow) path.dataset.flow = "1";
  if (toPort.dataset.type) path.dataset.type = toPort.dataset.type;
  path.dataset.link = linkId(link);
  return path;
}

function cssEsc(s) {
  return String(s).replace(/(["\\])/g, "\\$1");
}

function linkId(l) {
  return l.id || `${l.from}.${l.port}->${l.to}.${l.portTo}`;
}

function redrawLinks() {
  const flow = currentFlow();
  const svg = worldEl() && worldEl().querySelector("svg.links");
  if (!flow || !svg) return;
  svg.innerHTML = "";
  for (const link of flow.links || []) {
    const path = makeLinkPath(link);
    if (path) svg.appendChild(path);
  }
}

/* ---------------------------- 积木操作 ---------------------------- */
function addBlock(type) {
  const flow = currentFlow();
  if (!flow) {
    setStatus(active.tab === "effects" ? "先选一个效果和触发流程" : "先选一个技能", "bad");
    return;
  }
  if (type === "trigger" && flow.nodes.some((n) => n.type === "trigger")) {
    setStatus("一个流程只能有一个「触发」", "bad");
    return;
  }
  const base = { trigger: "trg", attack: "atk", heal: "heal", number: "num" }[type] || type;
  let i = 1;
  const used = new Set(flow.nodes.map((n) => n.id));
  while (used.has(`${base}${i}`)) i += 1;
  const id = `${base}${i}`;
  const def = blockDef(type);
  const options = {};
  for (const o of def.options || []) options[o.key] = o.default;
  const box = canvasEl().getBoundingClientRect();
  const center = toWorld(box.left + box.width / 2 + (Math.random() - 0.5) * 60, box.top + box.height / 2 + (Math.random() - 0.5) * 60);
  flow.nodes.push({ id, type, options, pos: { x: Math.round(center.x - 110), y: Math.round(center.y - 60) } });
  if (type === "trigger" && active.tab === "effects") {
    const card = currentEffect();
    card.triggers = card.triggers || [];
    card.triggers.push({ block: { id, event: options.event, unitScope: "self" } });
    card.flows = card.flows || {};
    card.flows[id] = flow;
    active.triggerId = id;
    renderEffectPanel();
    renderCardsList();
  }
  selectNode(id);
  markDirty();
  refreshFlowView();
}

function selectNode(id) {
  canvasState.selectedId = id;
  $$(".block").forEach((el) => el.classList.toggle("is-selected", el.dataset.id === id));
  const del = $("#btn-delete-block");
  if (del) del.disabled = !id;
}

function deleteSelected() {
  const flow = currentFlow();
  const id = canvasState.selectedId;
  if (!flow || !id) return;
  flow.nodes = flow.nodes.filter((n) => n.id !== id);
  flow.links = (flow.links || []).filter((l) => l.from !== id && l.to !== id);
  if (active.tab === "effects") {
    const card = currentEffect();
    card.triggers = (card.triggers || []).filter((t) => t.block.id !== id);
    if (card.flows) delete card.flows[id];
    if (active.triggerId === id) active.triggerId = card.triggers[0] ? card.triggers[0].block.id : null;
    renderEffectPanel();
  }
  selectNode(null);
  markDirty();
  refreshFlowView();
}

function removeLink(id) {
  const flow = currentFlow();
  if (!flow) return;
  flow.links = (flow.links || []).filter((l) => linkId(l) !== id);
  markDirty();
  redrawLinks();
  renderJson();
}

function addLink(from, port, to, portTo) {
  const flow = currentFlow();
  if (!flow || from === to) return;
  const fromNode = flow.nodes.find((n) => n.id === from);
  const toNode = flow.nodes.find((n) => n.id === to);
  if (!fromNode || !toNode) return;
  const def = blockDef(fromNode.type);
  const outPort = def.ports.find((p) => p.id === port && p.direction === "out");
  const targetDef = blockDef(toNode.type);
  const inPort = targetDef.ports.find((p) => p.id === portTo && p.direction === "in");
  if (!outPort || !inPort) return;
  const fType = outPort.type || null;
  const tType = inPort.type || null;
  flow.links = flow.links || [];
  if (!fType || !tType) {
    if (Boolean(fType) !== Boolean(tType)) {
      setStatus("执行流只能接执行流的端口", "bad");
      return;
    }
    // 执行流：出 1 进 1
    flow.links = flow.links.filter((l) => !(l.from === from && l.port === port) && !(l.to === to && l.portTo === portTo));
  } else {
    const ok = fType === tType || fType === "any" || tType === "any" || (fType === "target" && tType === "targetset");
    if (!ok) {
      setStatus(`类型不匹配：${DATA_TYPE_LABEL[fType] || fType} → ${DATA_TYPE_LABEL[tType] || tType}`, "bad");
      return;
    }
    flow.links = flow.links.filter((l) => !(l.to === to && l.portTo === portTo));
  }
  flow.links.push({ id: `${from}.${port}->${to}.${portTo}`, from, port, to, portTo });
  markDirty();
  redrawLinks();
  renderJson();
}

function refreshFlowView() {
  renderFlow();
}

/* ---------------------------- 指针事件 ---------------------------- */
function setupCanvas() {
  const el = canvasEl();
  if (!el) return;
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("text/block");
    if (type) addBlock(type);
  });
  el.addEventListener("change", onBlockOptionChange);
  el.addEventListener("input", onBlockOptionChange);
  window.addEventListener("resize", () => redrawLinks());

  const bind = (sel, fn) => {
    const el = $(sel);
    if (!el) return;
    el.onclick = fn;
  };
  bind("#btn-delete-block", deleteSelected);
  bind("#btn-fit", fitView);
  bind("#btn-zoom-in", () => zoomBy(1.15));
  bind("#btn-zoom-out", () => zoomBy(1 / 1.15));
  bind("#btn-clear-flow", () => {
    const flow = currentFlow();
    if (!flow) return;
    if (!confirm("清空当前流程的积木？")) return;
    flow.nodes = [];
    flow.links = [];
    if (active.tab === "effects") {
      const card = currentEffect();
      card.triggers = [];
      card.flows = {};
      active.triggerId = null;
      renderEffectPanel();
    }
    markDirty();
    refreshFlowView();
  });
}

function zoomBy(k) {
  const box = canvasEl().getBoundingClientRect();
  const cx = box.width / 2;
  const cy = box.height / 2;
  const z = Math.min(1.8, Math.max(0.35, canvasState.view.zoom * k));
  canvasState.view.x = cx - ((cx - canvasState.view.x) * z) / canvasState.view.zoom;
  canvasState.view.y = cy - ((cy - canvasState.view.y) * z) / canvasState.view.zoom;
  canvasState.view.zoom = z;
  syncWorld();
  redrawLinks();
}

function fitView() {
  const flow = currentFlow();
  if (!flow || !flow.nodes.length) {
    canvasState.view = { x: 40, y: 40, zoom: 1 };
    syncWorld();
    redrawLinks();
    return;
  }
  const xs = flow.nodes.map((n) => n.pos.x);
  const ys = flow.nodes.map((n) => n.pos.y);
  canvasState.view = { x: 40 - Math.min(...xs), y: 40 - Math.min(...ys), zoom: 0.9 };
  syncWorld();
  redrawLinks();
}

function onPointerDown(e) {
  if (e.button === 2) return;
  canvasState.lastXY = { x: e.clientX, y: e.clientY };
  const portEl = e.target.closest(".port");
  const blockEl = e.target.closest(".block");
  const pathEl = e.target.closest("path.link");

  if (portEl && blockEl && portEl.dataset.dir === "out") {
    e.preventDefault();
    canvasState.link = { from: blockEl.dataset.id, port: portEl.dataset.port };
    drawDragLine(e);
    canvasEl().setPointerCapture(e.pointerId);
    return;
  }
  if (pathEl) {
    canvasState.pendingCut = { at: Date.now(), x: e.clientX, y: e.clientY };
    canvasEl().setPointerCapture(e.pointerId);
    return;
  }
  if (blockEl) {
    selectNode(blockEl.dataset.id);
    canvasState.drag = { id: blockEl.dataset.id, x: e.clientX, y: e.clientY, moved: false };
    canvasEl().setPointerCapture(e.pointerId);
    return;
  }
  // 空白：长按后滑动 = 切断；否则拖动平移
  canvasState.pendingCut = { at: Date.now(), x: e.clientX, y: e.clientY };
  canvasState.pan = { x: e.clientX, y: e.clientY, vx: canvasState.view.x, vy: canvasState.view.y, moved: false };
  canvasEl().setPointerCapture(e.pointerId);
}

function drawDragLine(e) {
  const world = worldEl();
  let g = $("#drag-line");
  if (!g) {
    g = document.createElementNS("http://www.w3.org/2000/svg", "path");
    g.id = "drag-line";
    g.setAttribute("class", "drag-line");
    const svg = world.querySelector("svg.links");
    if (svg) svg.appendChild(g);
  }
  const startEl = canvasState.nodeEls.get(canvasState.link.from)?.querySelector(`.port[data-port="${cssEsc(canvasState.link.port)}"]`);
  if (!startEl) return;
  const a = portCenter(startEl);
  const b = toWorld(e.clientX, e.clientY);
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  g.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
}

function onPointerMove(e) {
  const cut = canvasState.pendingCut;
  if (cut && !canvasState.link && !canvasState.erasing) {
    const d = Math.hypot(e.clientX - cut.x, e.clientY - cut.y);
    if (cut.at && Date.now() - cut.at > 420 && d > 10) {
      canvasState.erasing = true;
      canvasState.pan = null;
      canvasState.pendingCut = null;
      const canvas = canvasEl();
      canvas.classList.add("is-erasing");
    }
  }
  if (canvasState.erasing) {
    const box = canvasEl().getBoundingClientRect();
    const marker = $("#cut-marker");
    if (marker) {
      marker.style.display = "block";
      marker.style.left = `${e.clientX - box.left}px`;
      marker.style.top = `${e.clientY - box.top}px`;
    }
    // 切掉指针下方的连线
    const hit = document.elementsFromPoint(e.clientX, e.clientY);
    for (const node of hit) {
      const p = node.closest && node.closest("path.link");
      if (p) removeLink(p.dataset.link);
    }
    return;
  }
  if (cut && Date.now() - cut.at > 420 && !canvasState.link) {
    canvasEl().dataset.longPress = "1";
  }
  if (canvasState.link) {
    drawDragLine(e);
    return;
  }
  if (canvasState.drag) {
    const flow = currentFlow();
    const node = flow && flow.nodes.find((n) => n.id === canvasState.drag.id);
    const dx = (e.clientX - canvasState.drag.x) / canvasState.view.zoom;
    const dy = (e.clientY - canvasState.drag.y) / canvasState.view.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) canvasState.drag.moved = true;
    if (node) {
      node.pos.x += dx;
      node.pos.y += dy;
      const el = canvasState.nodeEls.get(node.id);
      if (el) {
        el.style.left = `${node.pos.x}px`;
        el.style.top = `${node.pos.y}px`;
      }
      redrawLinks();
    }
    canvasState.drag.x = e.clientX;
    canvasState.drag.y = e.clientY;
    return;
  }
  if (canvasState.pan) {
    const dx = e.clientX - canvasState.pan.x;
    const dy = e.clientY - canvasState.pan.y;
    if (Math.hypot(dx, dy) > 4) canvasState.pan.moved = true;
    canvasState.view.x = canvasState.pan.vx + dx;
    canvasState.view.y = canvasState.pan.vy + dy;
    syncWorld();
    redrawLinks();
  }
}

function onPointerUp(e) {
  canvasEl().classList.remove("is-erasing");
  const marker = $("#cut-marker");
  if (marker) marker.style.display = "none";

  if (canvasState.link) {
    const portEl = e.target.closest(".port");
    const blockEl = e.target.closest(".block");
    if (portEl && blockEl && portEl.dataset.dir === "in") {
      addLink(canvasState.link.from, canvasState.link.port, blockEl.dataset.id, portEl.dataset.port);
    }
    canvasState.link = null;
    $("#drag-line")?.remove();
  }
  if (canvasState.drag) {
    if (canvasState.drag.moved) {
      markDirty();
      renderJson();
    }
    canvasState.drag = null;
  }
  if (canvasState.pan && !canvasState.pan.moved && !canvasState.erasing) selectNode(null);
  canvasState.pan = null;
  canvasState.pendingCut = null;
  canvasState.erasing = false;
}

/*
 * 上面的画布实现见下方指针对话；这里做一层指针捕获的兜底。
 */

/* ---------------------------- 积木选项修改 ---------------------------- */
function onBlockOptionChange(e) {
  const nodeEl = e.target.closest(".block");
  if (!nodeEl) return;
  const flow = currentFlow();
  const node = flow && flow.nodes.find((n) => n.id === nodeEl.dataset.id);
  if (!node) return;
  let changed = false;
  if (e.target.dataset.option) {
    const key = e.target.dataset.option;
    node.options = node.options || {};
    node.options[key] = e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? Number(e.target.value) : e.target.value;
    changed = true;
    if (node.type === "trigger" && active.tab === "effects") {
      const card = currentEffect();
      const t = (card.triggers || []).find((x) => x.block.id === node.id);
      if (t && key === "event") {
        t.block.event = node.options.event;
        active.triggerId = t.block.id;
        const flowLabel = $("#flow-title");
        if (flowLabel) flowLabel.textContent = `当前触发：${TRIGGER_LABEL[t.block.event] || t.block.event}`;
      }
    }
  }
  if (e.target.dataset.constant) {
    const key = e.target.dataset.constant;
    node.options = node.options || {};
    if (e.target.value === "") delete node.options[key];
    else node.options[key] = e.target.value;
    changed = true;
  }
  if (changed) {
    markDirty();
    renderJson();
    if (e.target.tagName === "SELECT") renderFlow();
  }
}

function onSkillFormInput(e) {
  const s = currentSkill();
  if (!s) return;
  const key = e.target.dataset.skill;
  if (!key) return;
  if (key === "multiplier") s.multiplier = Number(e.target.value) || 0;
  else if (key === "id") {
    const old = s.id;
    s.id = e.target.value.trim();
    project.character.skillIds = (project.character.skillIds || []).map((x) => (x === old ? s.id : x));
    active.skillId = s.id;
  } else s[key] = e.target.value;
  markDirty();
  renderCardsList();
  renderJson();
}

function onEffectFormInput(e) {
  const card = currentEffect();
  if (!card) return;
  const flag = e.target.dataset.effectFlag;
  if (flag) {
    card.flags = card.flags || [];
    card.flags = e.target.checked ? [...new Set([...card.flags, flag])] : card.flags.filter((f) => f !== flag);
    markDirty();
    renderJson();
    return;
  }
  const key = e.target.dataset.effect;
  if (!key) return;
  if (key === "id") card.id = e.target.value.trim();
  else card[key] = e.target.value;
  markDirty();
  renderCardsList();
  renderJson();
}

function uniqueId(existing, base) {
  let id = base;
  let i = 2;
  while (existing.includes(id)) {
    id = `${base}_${i}`;
    i += 1;
  }
  return id;
}

function copyText(text) {
  if (!text) return;
  navigator.clipboard
    ?.writeText(text)
    .then(() => setStatus("已复制到剪贴板", "ok"))
    .catch(() => setStatus("复制失败", "bad"));
}

function exportProject() {
  flushSaveSync();
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cae-project-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus("已导出工程 JSON", "ok");
}

function importProject(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const p = JSON.parse(String(reader.result));
      if (!p || p.kind !== "caeworld-editor-project") throw new Error("不是编辑器工程文件");
      setProject(p);
      markDirty();
      setStatus("已导入工程", "ok");
    } catch (err) {
      setStatus("导入失败：" + err.message, "bad");
    }
  };
  reader.readAsText(file);
}

/* ================================================================== */
/* 启动                                                                */
/* ================================================================== */
export { setProject, projectToContent };

export function initEditor() {
  if (!project.character) project.character = createCharacter();
  active.skillId = active.skillId || (project.skills[0] ? project.skills[0].id : null);
  active.effectId = active.effectId || (project.effects[0] ? project.effects[0].id : null);
  setupForms();
  setupCanvas();
  $('#btn-back')?.addEventListener("click", () => {
    if (!dirty) return;
    flushSaveSync();
  });
  switchTab("character");
  renderCharacter();
}

/* ================================================================== */
/* 积木盒                                                              */
/* ================================================================== */
function renderPalette() {
  const groups = {};
  for (const block of Object.values(catalog.blocks)) {
    if (block.group === "trigger" && active.tab === "skills" && block.kind !== "trigger") continue;
    (groups[block.group] = groups[block.group] || []).push(block);
  }
  const order = ["trigger", "action", "structure", "logic", "data"];
  const html = order
    .filter((g) => groups[g])
    .map(
      (g) => `
      <div class="palette-group">
        <div class="palette-title" style="--g:${BLOCK_GROUPS[g].color}">${escapeHtml(BLOCK_GROUPS[g].label)}</div>
        ${groups[g]
          .map(
            (b) =>
              `<button class="palette-item" type="button" data-block="${escapeHtml(b.kind)}" draggable="true" style="--g:${b.color}" title="${escapeHtml(
                b.note || b.subtitle || b.title
              )}">${escapeHtml(b.title)}</button>`
          )
          .join("")}
      </div>`
    )
    .join("");
  for (const id of ["#ed-palette", "#ed-palette-2"]) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }
  // 重新绑定（palette 是重建的）
  $$(".palette-item").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => addBlock(btn.dataset.block));
    btn.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/block", btn.dataset.block));
  });
}

/* ================================================================== */
/* JSON 与校验                                                         */
/* ================================================================== */
/** 当前流程的「执行流程 JSON」：积木、填写、连接、位置 */
function buildFlowJson() {
  const flow = currentFlow();
  if (!flow) return null;
  return {
    schema: 1,
    kind: "flow",
    nodes: (flow.nodes || []).map((n) => ({
      id: n.id,
      type: n.type,
      options: n.options || {},
      pos: { x: Math.round(n.pos.x), y: Math.round(n.pos.y) },
    })),
    links: (flow.links || []).map((l) => ({
      id: linkId(l),
      from: l.from,
      port: l.port,
      to: l.to,
      portTo: l.portTo,
    })),
  };
}

/** 实时校验流程：有问题就显示在画布下方 */
function validateFlow() {
  const box = $("#flow-errors");
  const flow = buildFlowJson();
  if (!box) return true;
  if (!flow) {
    box.hidden = true;
    return true;
  }
  const r = prepareFlow(flow);
  if (r.ok) {
    box.hidden = true;
    box.textContent = "";
  } else {
    box.hidden = false;
    box.textContent = r.errors.join("；");
  }
  return r.ok;
}

/** 下方两个 JSON：执行流程（当前流程）+ 存档（整个工程 + 生成的内容包） */
function renderJson() {
  const flowBox = $("#json-flow");
  if (flowBox) {
    const flow = buildFlowJson();
    flowBox.textContent = flow ? JSON.stringify(flow, null, 2) : "{}";
  }
  const saveBox = $("#json-save");
  if (saveBox) {
    saveBox.textContent = JSON.stringify(
      {
        project: {
          schema: project.schema,
          kind: project.kind,
          updatedAt: project.updatedAt,
          character: project.character,
          skills: project.skills,
          effects: project.effects,
        },
        content: projectToContent(project),
      },
      null,
      2
    );
  }
  validateFlow();
}
