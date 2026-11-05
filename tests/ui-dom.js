/**
 * ui-dom.js —— 极简 DOM 桩 + 「模块导入」不抛错的检查（无浏览器环境）
 *
 * 不是真正的渲染测试：只保证 js/*.js 能作为 ES Module 被解析、导入时不因
 * 顶层代码报错；编辑器的交互逻辑在 README 的手动检查里覆盖。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createHarness, assert } from "./_harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const t = createHarness("ui");

/* ---------------------------- DOM 桩 ---------------------------- */
class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...c) {
    c.forEach((x) => this.set.add(x));
  }
  remove(...c) {
    c.forEach((x) => this.set.delete(x));
  }
  toggle(c, on) {
    if (on === undefined) on = !this.set.has(c);
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
  contains(c) {
    return this.set.has(c);
  }
}

class El {
  constructor(tag = "div", doc = null) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.classList = new ClassList();
    this.attributes = {};
    this._html = "";
    this._text = "";
    this.hidden = false;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.files = [];
    this.ownerDocument = doc;
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
  }
  get innerHTML() {
    return this._html;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get textContent() {
    return this._text;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "class") String(v).split(/\s+/).forEach((c) => c && this.classList.add(c));
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
  appendChild(c) {
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  append(...cs) {
    cs.forEach((c) => this.appendChild(c));
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
  }
  addEventListener() {}
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
  }
  get offsetWidth() {
    return 100;
  }
  focus() {}
  click() {}
}

class Doc extends El {
  constructor() {
    super("#document", null);
    this.documentElement = new El("html", this);
    this.body = new El("body", this);
    this.children = [this.documentElement, this.body];
    this.title = "";
    this.activeElement = null;
    this.elements = new Map();
  }
  createElement(tag) {
    return new El(tag, this);
  }
  createElementNS(ns, tag) {
    return new El(tag, this);
  }
  getElementById(id) {
    return this.elements.get(id) || null;
  }
  querySelector(sel) {
    if (sel.startsWith("#")) return this.getElementById(sel.slice(1));
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function installDom() {
  const doc = new Doc();
  const store = new Map();
  globalThis.document = doc;
  globalThis.window = {
    location: { search: "", hash: "", pathname: "/" },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.Image = class {
    constructor() {
      setTimeout(() => this.onload && this.onload(), 0);
    }
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "测试条目\n", json: async () => ({}) });
  globalThis.URLSearchParams = URLSearchParams;
  globalThis.Blob = class {};
  globalThis.URL = globalThis.URL || {};
  return doc;
}

/* ---------------------------- 检查 ---------------------------- */
t.test("界面模块：tips / menus / pictures / loading 可导入", async () => {
  for (const file of ["tips.js", "menus.js", "pictures.js", "loading.js", "icons.js"]) {
    const mod = await import(pathToFileURL(resolve(here, "..", "js", file)).href);
    assert.ok(mod && Object.keys(mod).length > 0, `${file} 没有导出`);
  }
});

t.test("编辑器模块：引擎入口暴露编辑器所需 API", async () => {
  const mod = await import(pathToFileURL(resolve(here, "..", "engine", "index.js")).href);
  for (const name of [
    "buildFlowCatalog",
    "prepareFlow",
    "runFlow",
    "createProject",
    "createSkill",
    "createEffect",
    "projectToContent",
    "resolveImage",
    "PLACEHOLDER_IMAGE",
    "BLOCK_GROUPS",
    "DATA_TYPE_LABEL",
    "characterToUnit",
  ]) {
    assert.ok(mod[name] !== undefined, `缺少导出 ${name}`);
  }
});

t.test("编辑器页面：index.html 引用了编辑器样式与入口", () => {
  const html = readFileSync(resolve(here, "..", "index.html"), "utf8");
  assert.match(html, /css\/editor\.css/);
  assert.match(html, /id="editor-page"/);
  assert.match(html, /id="blocks-canvas"/);
  assert.match(html, /id="ed-palette"/);
  assert.match(html, /data-tab="character"/);
  assert.match(html, /data-tab="skills"/);
  assert.match(html, /data-tab="effects"/);
});

t.test("编辑器脚本：导入时不抛错（DOM 桩）", async () => {
  installDom();
  const mod = await import(pathToFileURL(resolve(here, "..", "js", "editor-view.js")).href);
  assert.equal(typeof mod.initEditor, "function");
});

t.test("编辑器设置工程不抛错（表单 / 画布渲染走桩 DOM）", async () => {
  installDom();
  const ed = await import(pathToFileURL(resolve(here, "..", "js", "editor-view.js")).href);
  const engine = await import(pathToFileURL(resolve(here, "..", "engine", "index.js")).href);
  const p = engine.createProject();
  p.character.name = "桩测试角色";
  const skill = engine.createSkill("custom_skill_stub", "桩技能");
  skill.flow = {
    nodes: [
      { id: "tr", type: "trigger", options: { event: "skillCast" } },
      { id: "atk", type: "attack", options: { attribute: "physical" } },
      { id: "me", type: "currentTarget" },
    ],
    links: [
      { from: "tr", port: "next", to: "atk", portTo: "in" },
      { from: "me", port: "set", to: "atk", portTo: "targets" },
    ],
  };
  p.skills.push(skill);
  p.character.skillIds.push(skill.id);
  assert.doesNotThrow(() => ed.setProject(p));
  const content = ed.projectToContent(p);
  assert.equal(content.units.units[0].name, "桩测试角色");
  assert.equal(content.skills.skills[0].format, "flow");
});

process.exitCode = await t.done();
