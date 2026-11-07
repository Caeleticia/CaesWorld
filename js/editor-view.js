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
  loadPack,
  PACK_FILES,
  DEFAULT_PACK,
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
  RESISTANCE_ATTRIBUTES,
} from "../engine/index.js";

/** 卡组：工程与内容包都按卡组存在 data/pack/<卡组>/ 里 */
const PACK = localStorage.getItem("caeworld:editor-pack") || DEFAULT_PACK;
const STORAGE_KEY = `caeworld:editor-project:${PACK}`;
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
  project = stripLegacyFields(p);
  active = { tab: "character", skillId: p.skills[0] ? p.skills[0].id : null, effectId: p.effects[0] ? p.effects[0].id : null, triggerId: null };
  renderAll();
  switchTab("character");
}
let dirty = false;
let saveTimer = 0;
const catalog = buildFlowCatalog();

/** 旧工程兼容：技能卡曾带 attribute / multiplier；本源曾带抗性字段。读入时清掉。 */
function stripLegacyFields(p) {
  for (const s of (p && p.skills) || []) {
    delete s.attribute;
    delete s.multiplier;
  }
  if (p && p.character && p.character.resistances) delete p.character.resistances.origin;
  return p;
}

function loadProject() {
  try {
    // 新格式：按卡组存；旧版本只有不带卡组后缀的 key，读一次当迁移
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("caeworld:editor-project");
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.kind === "caeworld-editor-project") {
        p.pack = PACK;
        return stripLegacyFields(p);
      }
    }
  } catch {
    /* 读不出来就用空白工程 */
  }
  return createProject();
}

/** 从 data/pack/<卡组>/ 读入内置卡组（首次打开编辑器时调用） */
async function hydrateFromPack() {
  try {
    const pack = await loadPack(PACK);
    const hasAny = pack.units.length || pack.skills.length || pack.effects.length;
    if (!hasAny) return false;
    if (pack.units[0]) project.character = unitCardToCharacter(pack.units[0]);
    for (const card of pack.skills) {
      if (project.skills.some((x) => x.id === card.id)) continue;
      const s = createSkill(card.id, card.name);
      Object.assign(s, { type: card.type, description: card.description || "" });
      s.flow = flowFromContent(card.flow);
      project.skills.push(s);
    }
    for (const def of pack.effects) {
      if (project.effects.some((x) => x.id === def.id)) continue;
      const e = createEffect(def.id, def.name);
      e.flags = (def.flags || []).slice();
      e.triggers = (def.triggers || []).map((t) => ({ block: { id: t.id, event: t.event, unitScope: t.unitScope || "self" } }));
      e.flows = {};
      for (const t of e.triggers) e.flows[t.block.id] = flowFromContent((def.flows || {})[t.block.id]);
      project.effects.push(e);
    }
    // 角色的挂载列表以卡组里的单位卡为准
    const skillIds = (project.character.skillIds || []).filter((id) => project.skills.some((s) => s.id === id));
    const effectIds = (project.character.effectIds || []).filter((id) => project.effects.some((e) => e.id === id));
    project.character.skillIds = skillIds;
    project.character.effectIds = effectIds;
    active.skillId = active.skillId || (project.skills[0] ? project.skills[0].id : null);
    active.effectId = active.effectId || (project.effects[0] ? project.effects[0].id : null);
    setStatus(`已载入卡组「${PACK}」：角色 ${pack.units.length} · 技能 ${pack.skills.length} · 效果 ${pack.effects.length}`, "ok");
    return true;
  } catch (err) {
    setStatus("卡组读取失败：" + err.message, "bad");
    return false;
  }
}

function markDirty() {
  dirty = true;
  setStatus("编辑中…", "");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  project.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    dirty = false;
    const skills = (project.skills || []).length;
    const effects = (project.effects || []).length;
    const ch = project.character || {};
    const flowOk = currentFlow() ? validateFlow() : true;
    setStatus(
      `已自动保存 · 角色「${ch.name || "未命名"}」· 技能 ${skills} · 效果 ${effects}` +
        (currentFlow() && !flowOk ? " · 流程有问题" : ""),
      "ok"
    );
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

/** 编辑器当前状态的精简视图（控制台调试用） */
export function getView() {
  return {
    pack: PACK,
    active: { ...active },
    character: project.character.name || "",
    skills: project.skills.map((s) => s.id),
    effects: project.effects.map((e) => e.id),
  };
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
      </div>
      <p class="muted card-source">数据来源：${escapeHtml(project.pack || PACK)} 卡组</p>`;
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
  for (const attr of RESISTANCE_ATTRIBUTES) {
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
  skillCastSelf: "单位释放该技能",
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
  if (!node.pos || !Number.isFinite(node.pos.x) || !Number.isFinite(node.pos.y)) node.pos = { x: 60, y: 60 };
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

/**
 * 端口中心点，返回「world 本地坐标」（SVG path 使用的坐标系）。
 *
 * 注意：getBoundingClientRect() 拿到的是**经过 scale 缩放后的屏幕像素**，
 * 而 svg.links 是 #blocks-world 的子元素、会跟着一起缩放，path 的 d 必须是
 * 未缩放的本地坐标。所以两矩形相减后要再除以 zoom，否则缩放后线条整体错位
 * （zoom=1 时恰好相等，只在缩放后暴露）。
 */
function portCenter(el) {
  const world = worldEl().getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const zoom = canvasState.view.zoom || 1;
  return {
    x: (r.left + r.width / 2 - world.left) / zoom,
    y: (r.top + r.height / 2 - world.top) / zoom,
  };
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
  // 刚放下的「数值」积木给一个非 0 的默认值，免得连上去后伤害为 0 让人以为是 bug
  if (type === "number" && options.mode === "const" && !Number(options.value)) options.value = 10;
  if (type === "number" && options.mode === "range") {
    if (options.max <= options.min) options.max = Math.max(10, options.min + 10);
  }
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
  const xs = flow.nodes.map((n) => (n.pos ? n.pos.x : 0));
  const ys = flow.nodes.map((n) => (n.pos ? n.pos.y : 0));
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

/**
 * 按视口坐标找落点元素。
 * 指针被捕获时 e.target 不可信，必须用 elementsFromPoint 取真实堆叠顺序。
 * 端口只有 12px，手指很难精确命中，因此在坐标没直接命中端口时，
 * 再在若干像素内做一次「最近端口」兜底（只考虑输入端口，避免连到相邻输出口）。
 */
function elementAtPoint(clientX, clientY, selector) {
  const direct = document.elementsFromPoint(clientX, clientY).find((n) => n.closest && n.closest(selector));
  if (direct) return direct.closest(selector);

  // 兜底：在落点附近找最近的可见元素
  let best = null;
  let bestDist = Infinity;
  const SLOP = 24;
  for (const el of $$(selector)) {
    if (el.dataset.dir !== "in") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const dist = Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
    if (dist <= SLOP && dist < bestDist) {
      best = el;
      bestDist = dist;
    }
  }
  return best;
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
    // 拖动连线时画布做了 setPointerCapture，pointerup 的 e.target 会被重定向成
    // 画布本身，直接读 e.target 永远命中不到端口。这里按下真实坐标取落点，
    // 与「长按切断连线」的做法保持一致。
    const drop = elementAtPoint(e.clientX, e.clientY, ".port");
    const dropBlock = drop && drop.closest(".block");
    if (drop && dropBlock && drop.dataset.dir === "in") {
      addLink(canvasState.link.from, canvasState.link.port, dropBlock.dataset.id, drop.dataset.port);
    }
    canvasState.link = null;
    $("#drag-line")?.remove();
    try {
      if (canvasEl().hasPointerCapture?.(e.pointerId)) canvasEl().releasePointerCapture(e.pointerId);
    } catch {
      /* 某些浏览器在指针已释放时会抛错，忽略 */
    }
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

/** 技能字段的写入（表单与编程接口共用） */
function applySkillField(card, key, value) {
  if (key === "id") {
    const old = card.id;
    card.id = String(value || "").trim();
    project.character.skillIds = (project.character.skillIds || []).map((x) => (x === old ? card.id : x));
    active.skillId = card.id;
  } else card[key] = String(value ?? "");
}

function onSkillFormInput(e) {
  const s = currentSkill();
  if (!s) return;
  const key = e.target.dataset.skill;
  if (!key) return;
  applySkillField(s, key, e.target.value);
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
  a.download = `cae-pack-${PACK}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus("已导出工程 JSON", "ok");
}

function importProject(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  // 工程文件和内容包都走同一个识别器：工程 → 整套替换；内容包 → 合并
  readJsonFile(file, importContent);
  e.target.value = "";
}

/* ================================================================== */
/* 启动                                                                */
/* ================================================================== */
/**
 * 真实的「设计」动作接口：表单子表、选下拉、连端口都走它。
 * 单元测试 / 控制台调试也用它，保证和界面上点按钮是同一条路径。
 */
const edit = {
  get project() {
    return project;
  },
  setProject,
  setActive(patch) {
    Object.assign(active, patch);
    switchTab(active.tab);
  },
  /** 修改角色字段 */
  setCharacter(key, value) {
    if (key === "image") project.character.image = String(value || "");
    else if (["level", "baseHp", "baseAtk", "baseDef", "critRate", "critDamage", "speed"].includes(key)) {
      project.character[key] = Number(value) || 0;
    } else if (["occupiesSlot", "countsAsUnit", "invincible"].includes(key)) project.character[key] = Boolean(value);
    else if (["name", "id", "quality", "label"].includes(key)) project.character[key] = String(value ?? "");
    else throw new Error(`未知角色字段：${key}`);
    markDirty();
    renderCharacter();
    renderCardsList();
    renderJson();
  },
  setResistance(attr, value) {
    if (!RESISTANCE_ATTRIBUTES.includes(attr)) return;
    project.character.resistances[attr] = Number(value) || 0;
    markDirty();
    renderJson();
  },
  newSkill(id, name) {
    const sid = id || uniqueId(project.skills.map((x) => x.id), "custom_skill_new");
    const card = createSkill(sid, name || "新技能");
    project.skills.push(card);
    active.skillId = sid;
    markDirty();
    switchTab("skills");
    return card;
  },
  newEffect(id, name) {
    const eid = id || uniqueId(project.effects.map((x) => x.id), "custom_effect_new");
    const card = createEffect(eid, name || "新效果");
    project.effects.push(card);
    active.effectId = eid;
    active.triggerId = null;
    markDirty();
    switchTab("effects");
    return card;
  },
  /** 修改技能字段（走和表单一样的入口） */
  setSkillField(key, value) {
    const card = currentSkill();
    if (!card) throw new Error("当前没有技能");
    // 和表单输入走同一条路径：真实 DOM 事件改成直接调用处理逻辑
    applySkillField(card, key, value);
    markDirty();
    renderSkillPanel();
    renderCardsList();
    renderJson();
    return card;
  },
  setEffectField(key, value) {
    const card = currentEffect();
    if (!card) throw new Error("当前没有效果");
    if (key === "flags") card.flags = Array.isArray(value) ? value.slice() : [];
    else if (key === "id") card.id = String(value || "").trim();
    else card[key] = String(value ?? "");
    markDirty();
    renderEffectPanel();
    renderCardsList();
    renderJson();
    return card;
  },
  /** 给效果加一个触发流程（和「+ 新触发」按钮一致） */
  addTrigger(event = "unitTurnStart") {
    const card = currentEffect();
    if (!card) throw new Error("当前没有效果");
    card.triggers = card.triggers || [];
    card.flows = card.flows || {};
    const id = uniqueId(card.triggers.map((t) => t.block.id), "trg", "");
    const flow = { schema: 1, kind: "flow", nodes: [], links: [] };
    const def = blockDef("trigger");
    const options = {};
    for (const o of def.options || []) options[o.key] = o.default;
    options.event = event;
    flow.nodes.push({ id, type: "trigger", options, pos: { x: 80, y: 80 } });
    card.triggers.push({ block: { id, event, unitScope: "self" } });
    card.flows[id] = flow;
    active.triggerId = id;
    markDirty();
    renderEffectPanel();
    renderFlow();
    renderJson();
    return id;
  },
  /** 往当前流程放一块积木（和点积木盒一致） */
  addBlock(type) {
    const flow = currentFlow();
    if (!flow) return null;
    const before = new Set(flow.nodes.map((n) => n.id));
    addBlock(type);
    return flow.nodes.find((n) => !before.has(n.id)) || null;
  },
  /** 连端口（和拖线一致；非法连接返回 false 并提示） */
  connect(from, port, to, portTo) {
    addLink(from, port, to, portTo);
    const flow = currentFlow();
    return Boolean((flow.links || []).some((l) => l.from === from && l.port === port && l.to === to && l.portTo === portTo));
  },
  deleteBlock(id) {
    canvasState.selectedId = id;
    deleteSelected();
  },
  /** 立即保存 + 返回当前流程 JSON / 完整工程 */
  saveNow() {
    clearTimeout(saveTimer);
    flushSave();
    return exportSnapshot();
  },
  exportSnapshot,
  currentFlow: () => buildFlowJson(),
  validate: () => validateProject(project),
  triggerLabel: flowTriggerLabel,
  /** 导入内容（内容包 / 单张卡 / 工程） */
  importContent,
  /** 导出内容包（units / skills / effects 三份） */
  exportContent() {
    const content = projectToContent(project);
    // 文件名与卡组目录一致：data/pack/<卡组>/单位.json 技能.json 效果.json
    saveTextFile(PACK_FILES.units, content.units);
    saveTextFile(PACK_FILES.skills, content.skills);
    saveTextFile(PACK_FILES.effects, content.effects);
    return content;
  },
};

function saveTextFile(name, data) {
  try {
    localStorage.setItem("caeworld:export:" + name, JSON.stringify(data));
  } catch {
    /* 文件太大就只弹下载 */
  }
  downloadJson(name, data);
}

/** 导出：工程 + 内容包 + 当前流程 */
function exportSnapshot() {
  return {
    project: JSON.parse(JSON.stringify(project)),
    content: JSON.parse(JSON.stringify(projectToContent(project))),
    flow: currentFlow() ? buildFlowJson() : null,
  };
}

export { setProject, projectToContent, edit, importContent, flowFromContent, unitCardToCharacter };

export async function initEditor() {
  if (!project.character) project.character = createCharacter();
  if (!project.pack) project.pack = PACK;
  active.skillId = active.skillId || (project.skills[0] ? project.skills[0].id : null);
  active.effectId = active.effectId || (project.effects[0] ? project.effects[0].id : null);
  setupForms();
  setupCanvas();
  document.querySelector("#btn-back")?.addEventListener("click", () => {
    if (!dirty) return;
    flushSaveSync();
  });
  switchTab("character");
  renderCharacter();
  // 本地没有存过工程时，用 data/pack/<卡组>/ 里的内置卡起手
  const fresh = !(project.skills.length || project.effects.length || project.character.name);
  if (fresh) {
    const ok = await hydrateFromPack();
    if (ok) {
      renderAll();
      markDirty();
    }
  }
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
        <div class="palette-items">
          ${groups[g]
            .map(
              (b) =>
                `<button class="palette-item" type="button" data-block="${escapeHtml(b.kind)}" draggable="true" style="--g:${b.color}" title="${escapeHtml(
                  b.note || b.subtitle || b.title
                )}">${escapeHtml(b.title)}</button>`
            )
            .join("")}
        </div>
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
/* 导入内容包（把 data/*.json 或别的工程弄进来继续改）                    */
/* ================================================================== */
function acceptDropOnCharacter(e) {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) readJsonFile(file, importContent);
  else if (e.dataTransfer) {
    // 也可以直接拖一段 JSON 文本进来
    const text = e.dataTransfer.getData("text/plain");
    if (text) {
      try {
        importContent(JSON.parse(text));
      } catch (err) {
        setStatus("导入失败：" + err.message, "bad");
      }
    }
  }
}

function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 把注册表里的单位卡转回角色表单需要的形状 */
function unitCardToCharacter(card) {
  const ch = createCharacter();
  Object.assign(ch, {
    id: card.id,
    name: card.name,
    quality: card.quality,
    level: card.level,
    baseHp: card.baseHp,
    baseAtk: card.baseAtk,
    baseDef: card.baseDef,
    critRate: card.critRate,
    critDamage: card.critDamage,
    speed: card.speed,
    label: card.label || "",
    occupiesSlot: card.occupiesSlot,
    countsAsUnit: card.countsAsUnit,
    invincible: card.invincible,
    image: card.image || "",
    skillIds: (card.skills || []).slice(),
    effectIds: (card.effects || []).slice(),
    resistances: Object.fromEntries(
      RESISTANCE_ATTRIBUTES.map((a) => [a, Number(card.resistances?.[a] ?? createCharacter().resistances[a]) || 0])
    ),
  });
  return ch;
}

/**
 * 导入一份内容：
 *  - 编辑器工程（kind = caeworld-editor-project）→ 直接替换工程
 *  - 内容包 { units:[], skills:[], effects:[] } / 单张技能卡 / 单张效果卡 → 合并进来
 * 单位卡、技能卡里的流程会转成编辑器画布上的积木（位置按节点顺序自动排）。
 */
function importContent(doc) {
  if (doc && doc.kind === "caeworld-editor-project") {
    setProject(doc);
    markDirty();
    setStatus("已导入编辑器工程", "ok");
    return;
  }
  const units = doc.units || (doc.kind === "units" ? [doc] : []);
  const skills = doc.skills || (doc.kind === "skills" ? [doc] : []);
  const effects = doc.effects || (doc.kind === "effects" ? [doc] : []);
  if (!units.length && !skills.length && !effects.length && doc.id) {
    if (String(doc.id).includes("_skill_")) skills.push(doc);
    else if (String(doc.id).includes("_effect_")) effects.push(doc);
    else if (String(doc.id).includes("_unit_")) units.push(doc);
  }
  if (!units.length && !skills.length && !effects.length) {
    setStatus("没识别出单位/技能/效果内容", "bad");
    return;
  }
  let n = 0;
  if (units.length) {
    project.character = unitCardToCharacter(units[0]);
    n += 1;
  }
  for (const s of skills) {
    const card = createSkill(s.id, s.name);
    card.type = s.type || "active";
    card.description = s.description || "";
    card.flow = flowFromContent(s.flow);
    const idx = (project.skills || []).findIndex((x) => x.id === card.id);
    if (idx >= 0) project.skills[idx] = card;
    else project.skills.push(card);
    n += 1;
  }
  for (const e of effects) {
    const def = createEffect(e.id, e.name);
    def.flags = (e.flags || []).slice();
    def.description = e.description || "";
    def.triggers = (e.triggers || []).map((t) => ({ block: { id: t.id, event: t.event, unitScope: t.unitScope || "self" } }));
    def.flows = {};
    for (const t of def.triggers) def.flows[t.block.id] = flowFromContent((e.flows || {})[t.block.id]);
    const idx = (project.effects || []).findIndex((x) => x.id === def.id);
    if (idx >= 0) project.effects[idx] = def;
    else project.effects.push(def);
    n += 1;
  }
  // 导入完就能直接进战斗：把新技能/效果挂到当前角色上
  if (skills.length) project.character.skillIds = [...new Set([...(project.character.skillIds || []), ...skills.map((x) => x.id)])];
  if (effects.length) project.character.effectIds = [...new Set([...(project.character.effectIds || []), ...effects.map((x) => x.id)])];
  active.skillId = project.skills[0] ? project.skills[0].id : null;
  active.effectId = project.effects[0] ? project.effects[0].id : null;
  active.triggerId = null;
  markDirty();
  switchTab(units.length ? "character" : skills.length ? "skills" : "effects");
  setStatus(`已导入 ${n} 项内容（技能/效果已挂到当前角色）`, "ok");
}

/** 引擎流程 → 画布流程（补上位置；没有位置的按网格排开） */
function flowFromContent(flow) {
  if (!flow) return { schema: 1, kind: "flow", nodes: [], links: [] };
  const nodes = (flow.nodes || []).map((n, i) => ({
    id: n.id,
    type: n.type,
    options: { ...(n.options || {}) },
    pos: {
      x: Number.isFinite(n.pos && n.pos.x) ? n.pos.x : 60 + (i % 3) * 260,
      y: Number.isFinite(n.pos && n.pos.y) ? n.pos.y : 60 + Math.floor(i / 3) * 220,
    },
  }));
  const links = (flow.links || []).map((l) => ({ id: l.id, from: l.from, port: l.port, to: l.to, portTo: l.portTo }));
  return { schema: 1, kind: "flow", nodes, links };
}

function readJsonFile(file, done) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      done(JSON.parse(String(reader.result)));
    } catch (err) {
      setStatus("读取失败：" + err.message, "bad");
    }
  };
  reader.readAsText(file);
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
      pos: { x: Math.round((n.pos && n.pos.x) || 0), y: Math.round((n.pos && n.pos.y) || 0) },
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

/* ================================================================== */
/* 表单事件（角色 / 挂载 / 技能 / 效果 / 导入导出）                       */
/* ================================================================== */
function flushSaveSync() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch {
    /* 忽略 */
  }
}

function setupForms() {
  const ch = () => project.character;
  const bind = (id, fn) => {
    const el = $("#" + id);
    if (!el) return;
    const handler = () => {
      fn(el);
      markDirty();
      renderCardsList();
      renderJson();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  };
  bind("f-name", (el) => (ch().name = el.value));
  bind("f-id", (el) => (ch().id = el.value.trim()));
  bind("f-quality", (el) => (ch().quality = el.value));
  bind("f-level", (el) => (ch().level = Number(el.value) || 1));
  bind("f-hp", (el) => (ch().baseHp = Number(el.value) || 0));
  bind("f-atk", (el) => (ch().baseAtk = Number(el.value) || 0));
  bind("f-def", (el) => (ch().baseDef = Number(el.value) || 0));
  bind("f-crit", (el) => (ch().critRate = Number(el.value) || 0));
  bind("f-critdmg", (el) => (ch().critDamage = Number(el.value) || 0));
  bind("f-speed", (el) => (ch().speed = Number(el.value) || 0));
  bind("f-label", (el) => (ch().label = el.value));
  bind("f-image", (el) => {
    ch().image = el.value.trim();
    renderCharacter();
  });
  for (const attr of RESISTANCE_ATTRIBUTES) {
    bind(`f-res-${attr}`, (el) => (ch().resistances[attr] = Number(el.value) || 0));
  }
  bind("f-occupy", (el) => (ch().occupiesSlot = el.checked));
  bind("f-count", (el) => (ch().countsAsUnit = el.checked));
  bind("f-invincible", (el) => (ch().invincible = el.checked));

  $("#f-image-file")?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      ch().image = String(reader.result);
      const input = $("#f-image");
      if (input) input.value = ch().image;
      renderCharacter();
      renderCardsList();
      markDirty();
      renderJson();
    };
    reader.readAsDataURL(file);
  });
  $("#btn-placeholder")?.addEventListener("click", () => {
    ch().image = "";
    const input = $("#f-image");
    if (input) input.value = "";
    renderCharacter();
    renderCardsList();
    markDirty();
    renderJson();
  });

  $("#ed-mount-skills")?.addEventListener("change", (e) => {
    const id = e.target.value;
    const list = ch().skillIds || (ch().skillIds = []);
    ch().skillIds = e.target.checked ? [...new Set([...list, id])] : list.filter((x) => x !== id);
    markDirty();
    renderJson();
  });
  $("#ed-mount-effects")?.addEventListener("change", (e) => {
    const id = e.target.value;
    const list = ch().effectIds || (ch().effectIds = []);
    ch().effectIds = e.target.checked ? [...new Set([...list, id])] : list.filter((x) => x !== id);
    markDirty();
    renderJson();
  });

  // 顶部三个标签：角色 / 技能 / 效果。之前只改了 is-active 的样式，没接 switchTab，
  // 结果点「设计技能」「设计效果」页面毫无反应（技能与效果共用一个面板，靠这段切左栏）。
  $$(".ed-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      // 切到技能 / 效果时，若当前没有选中项就落到第一张卡上，避免左栏空白
      if (btn.dataset.tab === "skills" && !currentSkill() && project.skills[0]) active.skillId = project.skills[0].id;
      if (btn.dataset.tab === "effects" && !currentEffect() && project.effects[0]) active.effectId = project.effects[0].id;
      switchTab(btn.dataset.tab);
    });
  });

  $("#btn-new-skill")?.addEventListener("click", () => edit.newSkill());
  $("#btn-new-effect")?.addEventListener("click", () => edit.newEffect());
  $("#ed-skill-list")?.addEventListener("change", (e) => {
    active.skillId = e.target.value;
    renderAll();
  });
  $("#ed-effect-list")?.addEventListener("change", (e) => {
    active.effectId = e.target.value;
    active.triggerId = null;
    renderAll();
  });

  const onSkill = (e) => onSkillFormInput(e);
  $("#ed-skill-form")?.addEventListener("input", onSkill);
  $("#ed-skill-form")?.addEventListener("change", onSkill);
  $("#ed-skill-form")?.addEventListener("click", (e) => {
    if (!e.target.closest('[data-action="delete-skill"]')) return;
    const s = currentSkill();
    if (!s || !confirm(`删除技能「${s.name}」？`)) return;
    project.skills = project.skills.filter((x) => x.id !== s.id);
    project.character.skillIds = (project.character.skillIds || []).filter((x) => x !== s.id);
    active.skillId = project.skills[0] ? project.skills[0].id : null;
    canvasState.selectedId = null;
    markDirty();
    renderAll();
  });

  const onEffect = (e) => onEffectFormInput(e);
  $("#ed-effect-form")?.addEventListener("input", onEffect);
  $("#ed-effect-form")?.addEventListener("change", onEffect);
  $("#ed-effect-form")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-trigger]");
    if (chip) {
      active.triggerId = chip.dataset.trigger;
      renderAll();
      return;
    }
    if (e.target.closest('[data-action="add-trigger"]')) {
      edit.addTrigger("unitTurnStart");
      return;
    }
    if (e.target.closest('[data-action="delete-trigger"]')) {
      const card = currentEffect();
      if (!card || !active.triggerId) return;
      card.triggers = (card.triggers || []).filter((t) => t.block.id !== active.triggerId);
      if (card.flows) delete card.flows[active.triggerId];
      active.triggerId = card.triggers[0] ? card.triggers[0].block.id : null;
      markDirty();
      renderAll();
    }
  });

  $("#btn-export")?.addEventListener("click", exportProject);
  $("#btn-export-content")?.addEventListener("click", () => {
    edit.exportContent();
    setStatus(`已导出卡组文件（${PACK_FILES.units} / ${PACK_FILES.skills} / ${PACK_FILES.effects}）`, "ok");
  });
  $("#btn-import")?.addEventListener("click", () => $("#import-file")?.click());
  const cardCol = $("#ed-card-preview");
  if (cardCol && cardCol.parentElement) {
    const dropZone = cardCol.parentElement;
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("is-drop");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-drop"));
    dropZone.addEventListener("drop", (e) => {
      dropZone.classList.remove("is-drop");
      acceptDropOnCharacter(e);
    });
  }
  $("#import-file")?.addEventListener("change", importProject);
  $("#import-content-file")?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) readJsonFile(file, importContent);
    e.target.value = "";
  });
  $("#btn-save")?.addEventListener("click", () => {
    clearTimeout(saveTimer);
    flushSave();
  });
  $("#btn-copy-save")?.addEventListener("click", () => copyText(JSON.stringify(projectToContent(project), null, 2)));
  $("#btn-copy-flow")?.addEventListener("click", () => copyText($("#json-flow")?.textContent || "{}"));

  setupSaveDock();

  window.addEventListener("beforeunload", () => {
    if (dirty) flushSaveSync();
  });
}

/* ------------------------------------------------------------------ */
/* 存档 JSON：移动端固定底部 + 折叠成悬浮球                              */
/* ------------------------------------------------------------------ */
const SAVE_COLLAPSE_KEY = "caeworld:editor-json-collapsed";

function setupSaveDock() {
  const panel = $("#json-save-panel");
  const fab = $("#json-fab");
  const collapseBtn = $("#btn-collapse-save");
  const page = $("#editor-page");
  if (!panel || !fab || !collapseBtn) return;

  /** @param {boolean} collapsed */
  const apply = (collapsed) => {
    panel.classList.toggle("is-collapsed", collapsed);
    fab.hidden = !collapsed;
    // 移动端底部留白跟着折叠态变（.editor-page 上的 --save-bar-h）
    page?.classList.toggle("is-save-collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.title = collapsed ? "展开存档 JSON" : "折叠成悬浮球";
  };

  // 移动端默认折叠，给画布腾出空间；用户手动切换后记住选择
  let collapsed = window.matchMedia("(max-width: 900px)").matches;
  try {
    const saved = localStorage.getItem(SAVE_COLLAPSE_KEY);
    if (saved === "1") collapsed = true;
    else if (saved === "0") collapsed = false;
  } catch {
    /* 隐私模式读不到就按视口默认值 */
  }
  apply(collapsed);

  const toggle = (next) => {
    apply(next);
    try {
      localStorage.setItem(SAVE_COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* 存不住也不影响本次交互 */
    }
  };

  collapseBtn.addEventListener("click", () => toggle(!panel.classList.contains("is-collapsed")));
  fab.addEventListener("click", () => toggle(false));
}
