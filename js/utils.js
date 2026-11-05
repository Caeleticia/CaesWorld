/*!
 * Cae'sWorld — utils.js
 * DOM / 事件 / 随机 / 设备能力 的通用小工具。
 */
(function (CW) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 创建元素：el('div.cls#id', {attrs}, child...|string) */
  function el(spec, attrs, ...children) {
    const m = /^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/.exec(spec) || [];
    const node = document.createElement(m[1] || 'div');
    (m[2] || '').replace(/([.#])([\w-]+)/g, (_, type, name) => {
      if (type === '.') node.classList.add(name);
      else node.id = name;
      return '';
    });
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className += (node.className ? ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /** 给元素加一次性的缩放入场（配合 CSS .pop） */
  function pop(node, cls = 'pop') {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth; // 强制重排以重启动画
    node.classList.add(cls);
  }

  /** 节流（rAF） */
  function rafThrottle(fn) {
    let queued = false;
    let lastArgs;
    return function (...args) {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn.apply(this, lastArgs);
      });
    };
  }

  /**
   * 站点根相对路径。
   * 页面被放在子目录运行（如本地服务器挂在外层目录）时，'vendor/...' 这类相对地址会解析错误；
   * 统一用 URL 以“当前文档所在目录”为基准，再拼上相对于本项目的资源路径即可稳健定位。
   * 注：若项目不是部署在服务器根目录，请在页面里设置 <base href>，或把 CW.route 的 base 改成项目前缀。
   */
  function route(path, base) {
    const b = base || document.baseURI || location.href;
    try {
      return new URL(String(path).replace(/^\/+/, ''), b).href;
    } catch (_) {
      return String(path);
    }
  }

  /** 设备能力探测：用于“显存不足/无 WebGL”时的降级判断 */
  /**
   * 设备能力探测（只读）。
   * 关键细节：同一个 canvas 上重复 getContext 同类型会返回 null —— 这里每次探测都用新 canvas，
   * 且探测结束后立刻 loseContext 释放，绝不把“已占用的上下文”带进渲染阶段。
   */
  function probeWebGL() {
    const tryType = (type) => {
      try {
        const c = document.createElement('canvas');
        c.width = 4;
        c.height = 4;
        const gl = c.getContext(type, { failIfMajorPerformanceCaveat: false });
        return gl || null;
      } catch (_) {
        return null;
      }
    };
    const gl2 = tryType('webgl2');
    const gl = gl2 || tryType('webgl') || tryType('experimental-webgl');
    if (!gl) return { ok: false, reason: 'no-webgl' };
    try {
      // 关键能力自检：Device 上 getProgramParameter 不可用（部分模拟器 / 显存紧张的内核）
      // 时，任何 WebGL 渲染都无法正确绘制失败 → 提前判定，直接走降级而不是黑屏。
      const canRunPrograms = typeof gl.getProgramParameter === 'function';
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
      const lost = typeof gl.isContextLost === 'function' && gl.isContextLost();
      if (lost) return { ok: false, reason: 'context-lost' };
      if (maxTex < 2048) return { ok: false, reason: 'max-texture-' + maxTex };
      if (!canRunPrograms) return { ok: false, reason: 'no-program-api', webgl2: !!gl2 };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      return {
        ok: true,
        webgl2: !!gl2,
        renderer: String(renderer),
        vendor: String(vendor),
        maxTex,
      };
    } catch (e) {
      return { ok: false, reason: 'probe-error:' + (e && e.message) };
    } finally {
      // 释放探测用的上下文（浏览器能同时持有的 WebGL 上下文很少）
      try {
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (_) { /* ignore */ }
    }
  }

  const isCoarse = () => window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** 当前阶段的“环境提示”：Android WebView 是触屏 → 桌宠拖拽可用 */
  const device = {
    coarse: isCoarse(),
    reduceMotion: reduceMotion(),
  };

  CW.util = { $, $$, el, esc, sleep, clamp, lerp, rand, randInt, pick, pop, rafThrottle, probeWebGL, device, route };
  CW.route = route;
})((window.CW = window.CW || {}));
