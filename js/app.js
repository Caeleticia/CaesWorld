/**
 * app.js —— 启动流程与界面编排
 *
 * 流程：载入页（字符库 → 头图 → 装配菜单）→ 主菜单（右侧随机头图）。
 * 本文件只做界面；不含任何玩法逻辑。
 */
import { loadTips, mountTip } from "./tips.js";
import { MENUS, toggleTab } from "./menus.js";
import { icon } from "./icons.js";
import { loadBanners, pickBanner, findBanner } from "./pictures.js";
import { STAGES, createLoader, mountProgress, nextFrame, preloadImage } from "./loading.js";

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* 调试参数（不影响正常使用）：
   ?freeze=1      载入完成后停在载入页（看载入页视觉）
   ?freeze=menu   跳过载入页直接看主菜单
   ?tips=0        「你知道吗」不自动轮换
   ?banner=文件名 指定开屏头图（对应 banner/index.txt 里的一行，如 ?banner=peach.png） */
const params = new URLSearchParams(window.location.search);

/* ------------------------------------------------------------------ */
/* 头图（主菜单右侧）                                                   */
/* ------------------------------------------------------------------ */
/**
 * 头图只出现在主菜单右侧，载入页不显示。
 * 数据来自 assets/banner/index.txt：每行一个文件名，每次进入随机抽一张。
 */
function applyBanner(el, entry) {
  if (!el) return;
  if (!entry) {
    el.hidden = true;
    el.removeAttribute("src");
    return;
  }
  el.hidden = false;
  el.src = entry.src;
  el.alt = "";
  el.dataset.banner = entry.id;
}

/* ------------------------------------------------------------------ */
/* 主菜单：侧栏标签 + 弹出选项                                          */
/* ------------------------------------------------------------------ */
function renderTabs(nav) {
  nav.innerHTML = "";
  MENUS.forEach((tab, i) => {
    const wrap = document.createElement("div");
    wrap.className = "tab";
    wrap.style.setProperty("--i", String(i));
    wrap.style.setProperty("--tab-color", tab.color);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", `pop-${tab.id}`);
    btn.dataset.tab = tab.id;
    btn.innerHTML = `
      <span class="tab-icon">${icon(tab.icon)}</span>
      <span class="tab-name">${tab.label}</span>
      <span class="tab-caret" aria-hidden="true"></span>`;

    const pop = document.createElement("div");
    pop.className = "tab-pop";
    pop.id = `pop-${tab.id}`;
    pop.innerHTML = `
      <div class="pop-inner">
        <div class="pop-list" role="group" aria-label="${tab.label}">${tab.items
          .map(
            (it, j) =>
              `<button type="button" class="pop-item" style="--j:${j}" data-item="${it.id}">` +
              `<span class="pop-label">${it.label}</span></button>`
          )
          .join("")}</div>
      </div>`;

    wrap.append(btn, pop);
    nav.append(wrap);
  });
}

/**
 * 打开/关闭标签（手风琴：同时只开一个）。
 * @param {HTMLElement} nav
 * @param {string|null} openId
 */
function setOpenTab(nav, openId) {
  nav.querySelectorAll(".tab").forEach((wrap) => {
    const btn = wrap.querySelector(".tab-btn");
    const isOpen = btn.dataset.tab === openId;
    wrap.classList.toggle("is-open", isOpen);
    btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });
  nav.dataset.open = openId || "";
}

function initTabs(nav, onPick) {
  nav.addEventListener("click", (event) => {
    const btn = event.target.closest(".tab-btn");
    if (btn) {
      const next = toggleTab(nav.dataset.open || null, btn.dataset.tab);
      setOpenTab(nav, next);
      return;
    }
    const item = event.target.closest(".pop-item");
    if (item && onPick) onPick(item.dataset.item);
  });

  // 键盘：Esc 收起当前展开的标签
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.dataset.open) setOpenTab(nav, null);
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                            */
/* ------------------------------------------------------------------ */
async function boot() {
  const loader = createLoader(STAGES);
  const progress = mountProgress({
    bar: $("#loading-bar"),
    pct: $("#loading-pct"),
    status: $("#loading-status"),
  });

  const loadingScreen = $("#loading-screen");
  const mainMenu = $("#main-menu");

  const stage = (i) => {
    loader.begin(i);
    progress.render(loader.value, STAGES[i].label);
  };
  const finish = (i) => {
    progress.render(loader.finish(i), STAGES[i].label);
  };

  const skipLoading = params.get("freeze") === "menu";

  /* —— 阶段 0：启动 —— */
  stage(0);
  await nextFrame();
  finish(0);

  /* —— 阶段 1：字符库 —— */
  stage(1);
  await nextFrame();
  const { tips, source } = await loadTips("data/tips.txt");
  document.querySelector('meta[name="cw-tips-source"]')?.setAttribute("content", source);
  finish(1);

  /* —— 阶段 2：头图（随机一张）+ 图片资源 —— */
  stage(2);
  await nextFrame();
  const { banners, source: bannerSource } = await loadBanners();
  // banner/index.txt：每行一个文件名，进入时随机抽一张（只用在主菜单右侧）
  const picked = findBanner(banners, params.get("banner")) || pickBanner(banners, "") || banners[0] || null;
  if (picked) await preloadImage(picked.src);
  finish(2);

  /* —— 阶段 3：装配界面（先做，再播最后一小段进度） —— */
  stage(3);
  await nextFrame();

  const nav = $("#tab-nav");
  renderTabs(nav);

  const tipEl = $("#menu-tip");
  const tip = mountTip(tipEl, tips, { interval: params.get("tips") === "0" ? 0 : 9000 });
  $("#loading-tip").textContent = tips[Math.floor(Math.random() * tips.length)] || "";

  initTabs(nav, (itemId) => {
    if (itemId === "editor") openEditor();
    if (itemId === "training") openTraining();
  });

  $(".cw-tip-refresh")?.addEventListener("click", () => tip.refresh());

  finish(3);

  if (source !== "file") {
    // 只在 file:// 或读取失败时提示，不打断观感
    console.info("[Cae'sWorld] 字符库未能从 data/tips.txt 读取，已使用内置兜底。");
  }

  /* —— 进入主菜单 —— */
  if (params.get("freeze") === "1") return;
  if (params.get("freeze") === "menu") loadingScreen.remove();

  const hold = params.get("freeze") === "menu" || reduceMotion ? 0 : 520;
  setTimeout(() => {
    const leaving = loadingScreen.classList.contains("is-gone") ? 0 : 480;
    loadingScreen.classList.add("is-leaving");
    setTimeout(() => {
      loadingScreen.classList.add("is-gone");
      loadingScreen.setAttribute("aria-hidden", "true");
      mainMenu.hidden = false;
      applyBanner($("#stage-picture"), picked);
      document.body.classList.remove("is-loading");
      document.title = "Cae'sWorld · 主菜单";
      // 直接带 hash 打开（#training / #editor）也能进对应页面
      if (location.hash === "#training") openTraining();
      else if (location.hash === "#editor") openEditor();
    }, leaving);
  }, hold);

  // 调试信息：当前头图与字符库来源
  window.__cw = { tips, source, banner: picked, bannerSource, loader };
}

/* ------------------------------------------------------------------ */
/* 编辑器                                                              */
/* ------------------------------------------------------------------ */
let editorLoaded = false;

async function openEditor() {
  const page = $("#editor-page");
  const menu = $("#main-menu");
  if (!page) return;
  page.hidden = false;
  if (menu) menu.hidden = true;
  location.hash = "#editor";
  if (!editorLoaded) {
    const mod = await import("./editor-view.js");
    await mod.initEditor();
    editorLoaded = true;
  }
}

function closeEditor() {
  const page = $("#editor-page");
  const menu = $("#main-menu");
  if (!page || page.hidden) return;
  page.hidden = true;
  if (menu) menu.hidden = false;
  history.replaceState(null, "", location.pathname + location.search);
}

/* ------------------------------------------------------------------ */
/* 训练场                                                              */
/* ------------------------------------------------------------------ */
async function openTraining() {
  const page = $("#training-page");
  const menu = $("#main-menu");
  if (!page) return;
  page.hidden = false;
  if (menu) menu.hidden = true;
  location.hash = "#training";
  const mod = await import("./training-view.js");
  await mod.initTraining();
}

function closeTraining() {
  const page = $("#training-page");
  if (!page) return;
  const battle = $("#battle-page");
  const battleOpen = battle && !battle.hidden;
  if (page.hidden && !battleOpen) return;
  page.hidden = true;
  if (battle) battle.hidden = true;
  const menu = $("#main-menu");
  if (menu) menu.hidden = false;
  history.replaceState(null, "", location.pathname + location.search);
}

window.addEventListener("hashchange", () => {
  if (location.hash !== "#editor") closeEditor();
  if (location.hash !== "#training") closeTraining();
});

boot().catch((err) => {
  console.error(err);
  const status = $("#loading-status");
  if (status) status.textContent = "界面初始化失败，请刷新重试";
});
