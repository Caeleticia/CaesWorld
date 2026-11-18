/**
 * battle-log.js —— 战斗记录（训练场 / 同屏共用）
 *
 * 目标：
 *   · 整局对战持续累积，不再只保留最近几条；
 *   · 战斗面板内可以滚动查看全部，顶栏「战报」打开完整查看器；
 *   · 战斗结算时提供「导出战报」，下载成 UTF-8 文本；下载被拦截时自动复制；
 *   · 对局过程中节流写入 localStorage，并保留「上一场」，避免刷新 / 重开一局后丢失。
 *
 * 本模块只负责记录的保存、展示与导出，不参与战斗结算。
 */

const STORAGE_PREFIX = "caeworld:battle-log:v1:";
const PERSIST_DELAY = 260;

const pad2 = (n) => String(n).padStart(2, "0");

function clockOf(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function stampOf(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clockOf(ms)}`;
}

function fileStampOf(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 只允许战斗面板已有的行样式，避免脏 class */
function safeKind(kind) {
  const value = String(kind || "");
  return value === "is-red" || value === "is-blue" || value === "is-sys" || value === "is-trigger"
    ? value
    : "";
}

function safeFileName(text) {
  return String(text || "战斗记录").replace(/[\\/:*?"<>|\s]+/g, "-");
}

function readSnapshot(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.entries) || !data.entries.length) return null;
    return data;
  } catch {
    return null;
  }
}

/** 触发浏览器下载一个文本文件；返回是否已发起下载 */
function downloadText(name, text) {
  let url = null;
  try {
    url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 移动端浏览器要在点击后稍等再读取 blob，太早 revoke 会得到空文件
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 4000);
    return false;
  }
}

/** 下载失败时的兜底：把战报复制到剪贴板 */
function copyText(text) {
  if (!text) return false;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand && document.execCommand("copy");
    area.remove();
    if (ok) return true;
  } catch {
    /* 走下面的异步剪贴板 */
  }
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
  } catch {
    /* 忽略 */
  }
  return false;
}

/**
 * 创建一份战斗记录。
 *
 * @param {object} opts
 * @param {string} opts.mode 存储区分（training / local）
 * @param {string} opts.modeLabel 显示用模式名
 * @param {string} [opts.title] 对局说明（双方张数等）
 * @param {HTMLElement} opts.container 战斗面板里的日志容器（#tb-log / #pb-log）
 * @param {HTMLElement} [opts.stage] 战斗舞台，用于挂完整查看器
 * @param {() => number} [opts.getTurn] 读取当前回合数
 */
export function createBattleLog({
  mode = "battle",
  modeLabel = "战斗",
  title = "",
  container = null,
  stage = null,
  getTurn = () => 0,
} = {}) {
  const storeKey = STORAGE_PREFIX + String(mode || "battle");
  const battleId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  /** 打开本场时，上一条被保存的记录（上一场战报） */
  const previous = readSnapshot(storeKey);
  const entries = [];
  let seq = 0;
  let endedAt = null;
  let result = null;
  let exportedAt = null;
  let persistTimer = null;
  let destroyed = false;
  let jump = null;
  let viewer = null;
  let viewerBody = null;
  let viewerTitle = null;
  let viewerSub = null;
  let viewerNote = null;
  let viewerPrev = null;
  let viewerExport = null;
  let viewing = "current";

  const currentTurn = () => {
    const value = Number(getTurn());
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };

  const snapshot = () => ({
    v: 1,
    battleId,
    mode,
    modeLabel,
    title,
    startedAt,
    updatedAt: Date.now(),
    endedAt,
    result,
    exportedAt,
    entries: entries.slice(),
  });

  function persistNow() {
    if (!entries.length) return; // 空记录不覆盖上一场
    try {
      localStorage.setItem(storeKey, JSON.stringify(snapshot()));
    } catch {
      /* localStorage 不可用 / 超限时忽略，内存里的记录仍然完整 */
    }
  }

  function schedulePersist() {
    if (!entries.length) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_DELAY);
  }

  /* ---------------- 面板内滚动 ---------------- */
  function nearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 26;
  }

  function scrollBottom(el) {
    if (el) el.scrollTop = el.scrollHeight;
  }

  function refreshJump() {
    if (!jump || !container) return;
    jump.hidden = nearBottom(container);
  }

  function makeLine(entry, view = false) {
    const kind = safeKind(entry.kind);
    if (view) {
      const row = document.createElement("div");
      row.className = `tbt-log-line tbt-log-view-line ${kind}`.trim();
      const time = document.createElement("time");
      time.className = "tbt-log-view-time";
      time.textContent = clockOf(entry.at);
      const text = document.createElement("span");
      text.className = "tbt-log-view-text";
      text.textContent = entry.text;
      row.append(time, text);
      return row;
    }
    const el = document.createElement("div");
    el.className = `tbt-log-line ${kind}`.trim();
    el.textContent = entry.text;
    return el;
  }

  function appendInline(entry) {
    if (!container) return;
    const stick = nearBottom(container);
    container.insertBefore(makeLine(entry), jump);
    if (stick) scrollBottom(container);
    refreshJump();
  }

  function onPanelScroll() {
    refreshJump();
  }

  if (container) {
    container.textContent = "";
    container.classList.add("is-scrollable");
    jump = document.createElement("button");
    jump.type = "button";
    jump.className = "tbt-log-jump";
    jump.textContent = "↓ 最新";
    jump.hidden = true;
    jump.setAttribute("aria-hidden", "true");
    jump.addEventListener("click", () => {
      scrollBottom(container);
      jump.hidden = true;
    });
    container.appendChild(jump);
    container.addEventListener("scroll", onPanelScroll, { passive: true });
  }

  /* ---------------- 完整查看器 ---------------- */
  function ensureViewer() {
    if (viewer || !stage) return viewer;
    viewer = document.createElement("div");
    viewer.className = "tbt-modal tbt-log-modal";
    viewer.hidden = true;
    viewer.innerHTML = `
      <div class="tbt-sheet tbt-log-sheet" role="dialog" aria-modal="true" aria-label="战斗记录">
        <header class="tbt-sheet-head">
          <div class="tbt-sheet-title">
            <h3 data-log-title>战斗记录</h3>
            <p data-log-sub></p>
          </div>
          <button class="tbt-close" type="button" data-log-close aria-label="关闭">×</button>
        </header>
        <div class="tbt-log-view-body" data-log-body></div>
        <footer class="tbt-log-view-foot">
          <span class="tbt-log-note" data-log-note></span>
          <button class="btn tiny" type="button" data-log-prev hidden>上一场</button>
          <button class="btn tiny" type="button" data-log-export>导出战报</button>
        </footer>
      </div>`;
    stage.appendChild(viewer);
    viewerBody = viewer.querySelector("[data-log-body]");
    viewerTitle = viewer.querySelector("[data-log-title]");
    viewerSub = viewer.querySelector("[data-log-sub]");
    viewerNote = viewer.querySelector("[data-log-note]");
    viewerPrev = viewer.querySelector("[data-log-prev]");
    viewerExport = viewer.querySelector("[data-log-export]");
    viewer.querySelector("[data-log-close]")?.addEventListener("click", closeViewer);
    viewer.addEventListener("click", (event) => {
      if (event.target === viewer) closeViewer();
    });
    viewerPrev?.addEventListener("click", () => {
      viewing = viewing === "previous" ? "current" : "previous";
      renderViewer();
      requestAnimationFrame(() => scrollBottom(viewerBody));
    });
    viewerExport?.addEventListener("click", () => {
      const data = viewing === "previous" ? previous : snapshot();
      const out = exportSnapshot(data);
      if (out.empty) setNote("本场还没有可导出的记录");
      else if (out.ok) setNote("战报已导出");
      else setNote(out.copied ? "下载被拦截，战报已复制到剪贴板" : "导出失败，请稍后重试");
    });
  }

  function setNote(text) {
    if (viewerNote) viewerNote.textContent = text || "";
  }

  function updateViewerHead(data) {
    if (!viewerTitle || !viewerSub) return;
    const count = Array.isArray(data?.entries) ? data.entries.length : 0;
    const turn = Number(data?.result?.turn) || (count ? Number(data.entries[count - 1].turn) || 0 : 0);
    viewerTitle.textContent = viewing === "previous" ? "上一场战报" : "战斗记录";
    viewerSub.textContent = [
      data?.modeLabel || modeLabel,
      `${count} 条`,
      turn ? `第 ${turn} 回合` : "",
      data?.endedAt ? "已结算" : "进行中",
    ]
      .filter(Boolean)
      .join(" · ");
    if (viewerPrev) {
      viewerPrev.hidden = !previous;
      viewerPrev.textContent = viewing === "previous" ? "返回本场" : "上一场";
    }
    if (viewerExport) viewerExport.disabled = count === 0;
  }

  function renderViewer() {
    if (!viewer || viewer.hidden) return;
    const data = viewing === "previous" ? previous : snapshot();
    updateViewerHead(data);
    if (!viewerBody) return;
    const keepScroll = viewerBody.scrollTop;
    viewerBody.textContent = "";
    const list = Array.isArray(data?.entries) ? data.entries : [];
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "tbt-log-empty";
      empty.textContent = "本场还没有战斗记录。";
      viewerBody.appendChild(empty);
    } else {
      for (const entry of list) viewerBody.appendChild(makeLine(entry, true));
    }
    viewerBody.scrollTop = keepScroll;
    setNote(data?.exportedAt ? "已导出" : "");
  }

  function openViewer() {
    if (destroyed) return;
    ensureViewer();
    if (!viewer) return;
    viewing = "current";
    viewer.hidden = false;
    renderViewer();
    requestAnimationFrame(() => scrollBottom(viewerBody));
  }

  function closeViewer() {
    if (!viewer || viewer.hidden) return;
    viewer.hidden = true;
  }

  function appendViewer(entry) {
    if (!viewer || viewer.hidden || viewing !== "current") return;
    const empty = viewerBody?.querySelector(".tbt-log-empty");
    if (empty) empty.remove();
    const stick = nearBottom(viewerBody);
    viewerBody?.appendChild(makeLine(entry, true));
    if (stick) scrollBottom(viewerBody);
    updateViewerHead(snapshot());
  }

  function onKey(event) {
    if (!viewer || viewer.hidden) return;
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeViewer();
  }
  window.addEventListener("keydown", onKey, true);

  /* ---------------- 文本 / 导出 ---------------- */
  function buildText(data) {
    const list = Array.isArray(data?.entries) ? data.entries : [];
    const info = data?.result || {};
    const begin = data?.startedAt || list[0]?.at || startedAt;
    const lines = [
      "Cae'sWorld · 战斗记录",
      "====================",
      `模式：${data?.modeLabel || modeLabel}`,
      ...(data?.title ? [`对局：${data.title}`] : []),
      `开始：${stampOf(begin)}`,
      `结束：${data?.endedAt ? stampOf(data.endedAt) : "（未结算）"}`,
    ];
    if (info.winnerText) {
      lines.push(`结果：${info.winnerText}${info.reason ? `（${info.reason}）` : ""}`);
    }
    if (info.turn) lines.push(`回合：${info.turn}`);
    if (info.aliveRed !== undefined && info.aliveBlue !== undefined) {
      lines.push(`剩余单位：红方 ${info.aliveRed} · 蓝方 ${info.aliveBlue}`);
    }
    lines.push(`记录：${list.length} 条`, "");
    for (const entry of list) {
      // 回合分隔行本身已经写明回合数，不再重复加前缀
      const turn = entry.turn && !String(entry.text).startsWith("——") ? `【第${entry.turn}回合】` : "";
      lines.push(`[${clockOf(entry.at)}] ${turn}${entry.text}`);
    }
    lines.push("", "—— 由 Cae'sWorld 战斗记录导出 ——", "");
    return lines.join("\r\n");
  }

  function exportSnapshot(data) {
    const list = Array.isArray(data?.entries) ? data.entries : [];
    if (!list.length) return { ok: false, copied: false, empty: true };
    const begin = data?.startedAt || list[0]?.at;
    const name = `${safeFileName(`战斗记录-${data.modeLabel || modeLabel}`)}-${fileStampOf(begin)}.txt`;
    const text = buildText(data);
    const ok = downloadText(name, text);
    const copied = ok ? false : copyText(text);
    if (ok || copied) {
      if (data && data.battleId === battleId) {
        exportedAt = Date.now();
        persistNow();
        if (viewer && !viewer.hidden && viewing === "current") updateViewerHead(snapshot());
      }
    }
    return { ok, copied, empty: false };
  }

  /* ---------------- 对外接口 ---------------- */
  function add(text, kind = "", turn = null) {
    if (destroyed || text === undefined || text === null || text === "") return;
    const rawTurn = Number(turn);
    const entryTurn = Number.isFinite(rawTurn) && rawTurn > 0 ? Math.floor(rawTurn) : currentTurn();
    const entry = {
      seq: ++seq,
      at: Date.now(),
      turn: entryTurn,
      text: String(text),
      kind: safeKind(kind),
    };
    entries.push(entry);
    appendInline(entry);
    appendViewer(entry);
    schedulePersist();
  }

  function finish(info = {}) {
    if (destroyed || endedAt) return;
    endedAt = Date.now();
    result = { ...info };
    persistNow();
    if (viewer && !viewer.hidden) renderViewer();
  }

  function destroy() {
    if (destroyed) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistNow();
    if (container) container.removeEventListener("scroll", onPanelScroll);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("beforeunload", persistNow);
    if (viewer) viewer.remove();
    if (jump) jump.remove();
    viewer = null;
    viewerBody = null;
    jump = null;
    destroyed = true;
  }

  window.addEventListener("beforeunload", persistNow);

  return {
    add,
    finish,
    destroy,
    openViewer,
    closeViewer,
    exportCurrent: () => exportSnapshot(snapshot()),
    get entries() {
      return entries;
    },
    get count() {
      return entries.length;
    },
    get previousCount() {
      return Array.isArray(previous?.entries) ? previous.entries.length : 0;
    },
  };
}
