/**
 * app.js —— 启动流程与界面编排
 *
 * 流程：载入页（字符库 → 图片 → 装配菜单）→ 主菜单。
 * 本文件只做界面；不含任何玩法逻辑。
 */
import { loadTips, mountTip } from "./tips.js";
import { MENUS, findItem, toggleTab } from "./menus.js";
import { icon } from "./icons.js";
import { PICTURES, mountPicture } from "./pictures.js";
import { STAGES, createLoader, mountProgress, nextFrame, preloadImage } from "./loading.js";

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* 调试参数（不影响正常使用）：
   ?freeze=1      载入完成后停在载入页（看载入页视觉）
   ?freeze=menu   跳过载入页直接看主菜单
   ?tips=0        「你知道吗」不自动轮换 */
const params = new URLSearchParams(window.location.search);

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
              `<span class="pop-label">${it.label}</span>` +
              `<span class="pop-note">待实现</span></button>`
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
    if (item) {
      const found = findItem(item.dataset.item);
      if (found) onPick(found);
    }
  });

  // 键盘：Esc 收起当前展开的标签
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.dataset.open) setOpenTab(nav, null);
  });
}

/* ------------------------------------------------------------------ */
/* 右上/中央的提示气泡（无玩法，只告诉用户点了什么）                    */
/* ------------------------------------------------------------------ */
function initToast(el) {
  let timer = 0;
  function show(text) {
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("is-show"));
    clearTimeout(timer);
    timer = setTimeout(() => {
      el.classList.remove("is-show");
      setTimeout(() => {
        el.hidden = true;
      }, 260);
    }, 1800);
  }
  return { show };
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

  /* —— 阶段 2：图片资源 —— */
  stage(2);
  await nextFrame();
  const results = await Promise.all(PICTURES.map((p) => preloadImage(p.src)));
  const loadedPictures = PICTURES.filter((_, i) => results[i]);
  finish(2);

  /* —— 阶段 3：装配界面（先做，再播最后一小段进度） —— */
  stage(3);
  await nextFrame();

  const nav = $("#tab-nav");
  renderTabs(nav);

  const tipEl = $("#menu-tip");
  const tip = mountTip(tipEl, tips, { interval: params.get("tips") === "0" ? 0 : 9000 });
  $("#loading-tip").textContent = tips[Math.floor(Math.random() * tips.length)] || "";

  const toast = initToast($("#stage-toast"));
  initTabs(nav, ({ tab, item }) => {
    toast.show(`${tab.label} · ${item.label} —— 界面占位，玩法待开发`);
  });

  $(".cw-tip-refresh")?.addEventListener("click", () => tip.refresh());

  mountPicture(
    $("#stage-picture"),
    $("#stage-picture-tag"),
    { pool: loadedPictures.length ? loadedPictures : PICTURES }
  );

  finish(3);

  if (source !== "file") {
    // 只在 file:// 或读取失败时提示，不打断观感
    console.info("[Cae'sWorld] 字符库未能从 data/tips.txt 读取，已使用内置兜底。");
  }

  /* —— 进入主菜单 —— */
  if (params.get("freeze") === "1") return;

  const hold = params.get("freeze") === "menu" || reduceMotion ? 0 : 520;
  setTimeout(() => {
    loadingScreen.classList.add("is-leaving");
    setTimeout(() => {
      loadingScreen.classList.add("is-gone");
      loadingScreen.setAttribute("aria-hidden", "true");
      mainMenu.hidden = false;
      document.body.classList.remove("is-loading");
      document.title = "Cae'sWorld · 主菜单";
    }, reduceMotion ? 0 : 480);
  }, hold);

  // 暴露给调试/测试：?debug=title 把状态写进标题
  window.__cw = { tips, source, loadedPictures, loader };
}

boot().catch((err) => {
  console.error(err);
  const status = $("#loading-status");
  if (status) status.textContent = "界面初始化失败，请刷新重试";
});
