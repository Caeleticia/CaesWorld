/*!
 * Cae'sWorld — live2d.js
 * Live2D 桌宠（主菜单右侧）：
 *  1) 资源预检：逐个请求模型资源（file:// 直开时用 XHR，避免 CORS 假阴性）；
 *  2) 依赖加载：动态 import pixi v6 子包 + pixi-live2d-display(cubism4)；
 *     import 失败（离线/CDN 不通）时改用 <script> 加载失败脚本之外的本地 vendor 副本；
 *  3) 渲染：透明 PIXI 舞台挂在 stage 上，模型随舞台尺寸自适应；
 *  4) 桌宠：鼠标注视、视线跟随、轻拍反应、空闲随机动作/眨眼、呼吸由模型自带；
 *  5) 任何一步失败 → 明确的降级状态（虚拟屏/手机不得黑屏或卡在加载页）。
 *
 * 只要资源有效，失败只发生在“渲染能力/依赖下载”上，因此降级时保留全部交互逻辑的替代表现。
 */
(function (CW) {
  'use strict';

  /* =========================================================================
   * 桌宠引擎（纯逻辑，不碰 DOM / WebGL）
   * 用状态机描述“看着哪里、接下来做什么”，再由渲染层每帧写进模型参数。
   * 这样即使渲染失败（显存不足），逻辑仍可被完整测试与复用。
   * ========================================================================= */
  const PetEngine = {
    // 视线/头部的目标与当前值（-1..1），带缓动
    state: null,

    reset() {
      this.state = {
        t: 0,
        focus: { x: 0, y: 0 },     // 当前
        target: { x: 0, y: 0 },    // 目标：来自指针
        tilt: 0,                    // 由“甩动”给的额外歪头
        vx: 0,                      // 指针速度（用于判定“甩动”）
        lastPointer: null,
        mode: 'follow',             // follow | lookAway | nod | sleepish
        modeUntil: 0,
        idleAt: 3.5 + Math.random() * 2,
        reactions: 0,
        blink: { next: 2.5, phase: -1 },
        pulse: 0,                   // 被戳后的余韵（0..1）
      };
      return this.state;
    },

    /** 外部输入：指针在舞台内的归一化位置 0..1 */
    pointer(x, y) {
      const st = this.state || this.reset();
      const tx = CW.util.clamp(x, 0, 1) * 2 - 1;
      const ty = CW.util.clamp(y, 0, 1) * 2 - 1;
      if (st.lastPointer) {
        st.vx = st.vx * 0.7 + Math.abs(tx - st.lastPointer.x) * 0.3;
      }
      st.lastPointer = { x: tx, y: ty };
      st.target.x = tx;
      st.target.y = ty;
      if (st.mode === 'lookAway' && st.t > st.modeUntil) st.mode = 'follow';
      return st;
    },

    /** 被戳：进入“余韵”，并随机切一个短动作 */
    poke() {
      const st = this.state || this.reset();
      st.reactions += 1;
      st.pulse = 1;
      st.tilt = (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 6);
      st.mode = Math.random() < 0.5 ? 'lookAway' : 'nod';
      st.modeUntil = st.t + 0.8 + Math.random() * 0.6;
      return st;
    },

    /** 推进 dt 秒 */
    update(dt) {
      const st = this.state || this.reset();
      st.t += dt;
      const damp = 1 - Math.pow(0.0025, dt); // 帧率无关的缓动

      let tx = st.target.x;
      let ty = st.target.y;
      if (st.mode === 'lookAway') { tx = -st.target.x * 0.85; ty = st.target.y * 0.5; }
      else if (st.mode === 'nod') { ty = st.target.y + Math.sin(st.t * 14) * 0.25; }
      else if (st.mode === 'sleepish') { tx *= 0.25; ty = Math.min(ty, -0.3); }

      if (st.t > st.modeUntil && st.mode !== 'follow') {
        if (st.mode !== 'sleepish') st.mode = 'follow';
        else st.mode = 'follow';
        st.idleAt = Math.max(st.idleAt, st.t + 3);
      }

      st.focus.x += (tx - st.focus.x) * damp;
      st.focus.y += (ty - st.focus.y) * damp;
      st.tilt *= 1 - Math.min(1, dt * 6);
      st.pulse *= 1 - Math.min(1, dt * 2.2);
      st.vx *= 1 - Math.min(1, dt * 4);

      // 空闲动作：没被理会时偶尔完全偏离
      if (st.mode === 'follow' && st.t > st.idleAt) {
        st.mode = 'sleepish';
        st.modeUntil = st.t + 2 + Math.random() * 2.5;
        st.idleAt = st.t + 8 + Math.random() * 7;
      }

      // 眨眼节拍
      st.blink.next -= dt;
      if (st.blink.next <= 0 && st.blink.phase < 0) {
        st.blink.phase = 0;
        st.blink.next = 2 + Math.random() * 4.5;
      }
      if (st.blink.phase >= 0) {
        st.blink.phase += dt / 0.16;
        if (st.blink.phase >= 1) st.blink.phase = -1;
      }
      return st;
    },

    /** 眨眼开合度（0=闭，1=开） */
    eyeOpen() {
      const p = this.state ? this.state.blink.phase : -1;
      if (p < 0) return 1;
      // 闭合-保持-睁开，用三角形
      return p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2;
    },

    /**
     * 写入 SDK 的 focusController（-1..1）：SDK 在每帧内部据此驱动视线/头身，
     * 这样与它自带的呼吸、物理同管线，不会互相覆盖。
     */
    applyFocus(model) {
      const st = this.state || this.reset();
      const im = model && model.internalModel;
      if (!im || !im.focusController) return;
      try { im.focusController.focus(st.focus.x, -st.focus.y); } catch (_) { /* ignore */ }
    },

    /** 供渲染层写入的参数集合（不含模型自带的呼吸/物理） */
    params() {
      const st = this.state || this.reset();
      const fx = st.focus.x;
      const fy = st.focus.y;
      return {
        ParamAngleX: fx * 32,
        ParamAngleY: -fy * 24,
        ParamAngleZ: -fx * 12 + st.tilt,
        ParamBodyAngleX: fx * 10,
        ParamEyeBallX: fx * 1.2,
        ParamEyeBallY: -fy * 1.2,
        ParamEyeLOpen: this.eyeOpen(),
        ParamEyeROpen: this.eyeOpen(),
        ParamMouthForm: 0.2 + Math.sin(st.t * 0.7) * 0.15 + st.pulse * 0.5,
        ParamMouthOpenY: Math.max(0, Math.sin(st.t * 2.3) * 0.06 + st.pulse * 0.25),
        ParamCheek: st.pulse,
        ParamHairFront: Math.sin(st.t * 1.3) * 0.4 + fx * 0.3,
        ParamHairSide: Math.sin(st.t * 1.1 + 1) * 0.4,
        ParamHairBack: Math.sin(st.t * 0.9 + 2) * 0.4,
      };
    },
  };

  const { el, clamp, lerp } = CW.util;

  const PIXI_VERSION = '6.5.10';
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const DISPLAY_CDN = CDN + 'pixi-live2d-display@0.4.0/dist/cubism4.min.js';
  const CORE_CDN = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

  /** pixi v6 子包 ESM 入口（官方 dist/esm/<name>.mjs） */
  const PIXI_PACKAGES = ['settings', 'constants', 'utils', 'extensions', 'runner', 'ticker', 'math', 'core', 'display', 'sprite', 'graphics', 'filter-blur'];

  /** CDN 总预算：网络差时不要让人等太久，到点直接转本地 */
  const CDN_BUDGET_MS = 12000;

  /**
   * 本地 vendor：把依赖放进仓库即可离线运行。
   *  pixi.min.js 存在 → 用它（UMD，单文件，无需 importmap）；
   *  否则用 dist/esm 分片（vendor/pixi/<子包>.mjs），由 importmap 统一解析。
   */
  const VENDOR = {
    core: CW.route('vendor/live2d/live2dcubismcore.min.js'),
    display: CW.route('vendor/live2d/cubism4.min.js'),
    pixiUmd: CW.route('vendor/pixi/pixi.min.js'),
    pixiEsmDir: CW.route('vendor/pixi/'), // <pixi 子包名>.mjs
    // ESM 分片所需的第三方裸依赖
    libs: {
      eventemitter3: CW.route('vendor/pixi/lib/eventemitter3.mjs'),
      earcut: CW.route('vendor/pixi/lib/earcut.mjs'),
      url: CW.route('vendor/pixi/lib/url.mjs'),
    },
  };

  /** 探测静态资源是否可用（HEAD 失败则 GET 兜底） */
  const probed = new Map();
  function exists(url) {
    if (!probed.has(url)) {
      probed.set(url, (async () => {
        for (const method of ['HEAD', 'GET']) {
          try {
            const r = await fetch(url, { method, cache: 'no-cache' });
            if (r.ok) return true;
            if (method === 'HEAD' && (r.status === 405 || r.status === 501)) continue;
            return false;
          } catch (_) { /* 继续尝试 GET */ }
        }
        return false;
      })());
    }
    return probed.get(url);
  }

  function buildImportMap() {
    const imports = {};
    for (const p of PIXI_PACKAGES) imports['@pixi/' + p] = CDN + '@pixi/' + p + '@' + PIXI_VERSION + '/dist/esm/' + p + '.mjs';
    // pixi 的 ESM 构建在裸导入 eventemitter3，必须一并映射
    imports.eventemitter3 = CDN + 'eventemitter3@4.0.7/+esm';
    return imports;
  }

  function injectImportMap() {
    if (document.querySelector('script[type="importmap"]')) return;
    const s = document.createElement('script');
    s.type = 'importmap';
    s.textContent = JSON.stringify({ imports: buildImportMap() });
    const first = document.head.querySelector('script, link[rel="modulepreload"]');
    document.head.insertBefore(s, first || null);
  }

  /** 带超时的 fetch 文本（不解析） */
  async function fetchText(url, ms) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), ms);
    try {
      const r = await fetch(url, { cache: 'force-cache', signal: ctrl ? ctrl.signal : undefined });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function rejectAfter(ms, reason) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error(reason)), ms));
  }

  const loadedScripts = new Map();
  const loadedModules = new Map();

  /** <script> 加载 + 超时；ESM 模块不能用 <script src> 加载，会触发 onerror */
  function loadScriptTimed(url, ms) {
    return Promise.race([loadScript(url), rejectAfter(ms || 20000, '脚本超时：' + url)]);
  }

  function loadScript(url, label) {
    if (!loadedScripts.has(url)) {
      loadedScripts.set(url, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = false;
        s.onload = () => resolve(url);
        s.onerror = () => reject(new Error('脚本加载失败：' + url));
        document.head.appendChild(s);
      }).catch((e) => { loadedScripts.delete(url); throw e; }));
    }
    return loadedScripts.get(url);
  }

  function loadModule(url, timeoutMs) {
    if (!loadedModules.has(url)) {
      const p = Promise.race([
        import(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('模块加载超时：' + url)), timeoutMs)),
      ]).catch((e) => { loadedModules.delete(url); throw e; });
      loadedModules.set(url, p);
    }
    return loadedModules.get(url);
  }

  /**
   * Live2DStage：一个 stage 元素 = 一个桌宠实例。
   * opts: { modelUrl, timeoutMs, onState, onAction }
   */
  class Live2DStage {
    constructor(stageEl, opts = {}) {
      this.stageEl = stageEl;
      this.opts = opts;
      this.modelUrl = opts.modelUrl || CW.route('vendor/live2d/hiyori_vts/hiyori.model3.json');
      this.opts = opts;
      this.state = 'idle';
      this.destroyed = false;
      this.app = null;
      this.model = null;
      this.pointer = { x: 0, y: 0 }; // 归一化的舞台内指针（0..1）
      this.reaction = 0; // 被点时的额外摆动
      this.timers = new Set();
      this.lastAction = '';
      this.actionCooldown = 0;
      this.engine = Object.create(CW.PetEngine);
      this.engine.reset();
      this.bindPointer();
    }

    setState(s, detail) {
      this.state = s;
      if (this.opts.onState) {
        try { this.opts.onState(s, detail); } catch (_) { /* 由调用方负责 */ }
      }
    }

    action(name) {
      this.lastAction = name;
      this.reaction = 1;
      if (this.opts.onAction) {
        try { this.opts.onAction(name); } catch (_) { /* ignore */ }
      }
    }

    after(ms, fn) {
      const t = setTimeout(() => { this.timers.delete(t); if (!this.destroyed) fn(); }, ms);
      this.timers.add(t);
      return t;
    }

    bindPointer() {
      const focusFrom = (x, y) => {
        const r = this.stageEl.getBoundingClientRect();
        if (!r.width || !r.height) return;
        this.pointer.x = clamp((x - r.left) / r.width, 0, 1);
        this.pointer.y = clamp((y - r.top) / r.height, 0, 1);
        this.engine.pointer(this.pointer.x, this.pointer.y);
      };
      this.stageEl.addEventListener('pointermove', (e) => focusFrom(e.clientX, e.clientY), { passive: true });
      // 触屏：点按 / 轻扫也算“看这里”
      this.stageEl.addEventListener('pointerdown', (e) => focusFrom(e.clientX, e.clientY), { passive: true });
      this.stageEl.addEventListener('pointerleave', () => { this.pointer.x = 0.5; this.pointer.y = 0.5; }, { passive: true });
      // 整个窗口的指针也用于“视线跟着你走”（页面其余部分由桌宠层决定是否透传）
      window.addEventListener('pointermove', (e) => {
        if (!this.model) return;
        focusFrom(e.clientX, e.clientY);
      }, { passive: true });
    }

    async mount() {
      this.setState('checking');
      const caps = CW.util.probeWebGL();
      this.caps = caps;
      if (!caps.ok) {
        const reasonMap = {
          'no-webgl': '当前环境没有 WebGL',
          'no-program-api': 'WebGL 着色器管线不可用（getProgramParameter 缺失）',
          'context-lost': 'WebGL 上下文已丢失',
        };
        const desc = reasonMap[caps.reason] || caps.reason;
        return this.fail('nogl', desc, true);
      }
      this.rendererKind = null;

      // ---- 1) 资源预检（onerror 的 script 只拿得到笼统错误，先自己判断资源） ----
      const manifest = await this.checkAssets();
      if (!this.destroyed) this.setState('assets-ok', manifest);

      // ---- 2) 依赖：默认本地 vendor 优先；CDN 仅在 opt-in 时先试（带总预算） ----
      this.setState('loading-libs');
      let libs = null;
      const order = this.preferCdn() ? ['cdn', 'vendor'] : ['vendor', 'cdn'];
      const errors = [];
      for (const src of order) {
        try {
          libs = src === 'cdn'
            ? await Promise.race([this.loadFromCDN(), rejectAfter(CDN_BUDGET_MS, 'CDN 超时')])
            : await this.loadFromVendor();
          break;
        } catch (e) {
          errors.push(src + ': ' + ((e && e.message) || e));
          console.warn('[live2d] 依赖来源 ' + src + ' 不可用：', (e && e.message) || e);
        }
      }
      if (!libs) {
        return this.fail('libs', '渲染依赖不可用（' + errors.join('；') + '）', false);
      }
      if (this.destroyed) return false;
      this.setState('building');

      // ---- 3) 渲染 ----
      try {
        await this.render(libs);
      } catch (e) {
        console.error('[live2d] 渲染失败：', e);
        const glFail = /webgl|context|lost|gpu|memory/i.test(String(e && e.message));
        return this.fail(glFail ? 'gpu' : 'render', String((e && e.message) || e), false);
      }
      if (this.destroyed) return false;
      this.setState('ready');
      this.startIdle();
      return true;
    }

    /**
     * 依赖来源策略：?libs=cdn 走 CDN 优先（需联网，首屏更快）；默认 vendor 优先
     * （仓库内自带 pixi + cubism4 + Cubism Core 时完全离线可跑）。
     */
    preferCdn() {
      if (this.opts.preferCdn !== undefined) return !!this.opts.preferCdn;
      try {
        return new URLSearchParams(location.search).get('libs') === 'cdn';
      } catch (_) {
        return false;
      }
    }

    /** 校验模型资源可访问 + 贴图尺寸（避免 2048² 超限时才炸） */
    async checkAssets() {
      const base = this.modelUrl.replace(/[^/]+$/, '');
      const json = JSON.parse(await fetchText(this.modelUrl, 20000));
      const refs = json.FileReferences || {};
      const files = [refs.Moc, ...(refs.Textures || []), refs.Physics].filter(Boolean).map((f) => base + f);
      const results = await Promise.all(files.map(async (f) => {
        try {
          const r = await fetch(f, { method: 'GET', cache: 'force-cache' });
          return { file: f, ok: r.ok, size: Number(r.headers.get('content-length') || 0), type: r.headers.get('content-type') || '' };
        } catch (e) {
          return { file: f, ok: false, error: String(e && e.message) };
        }
      }));
      const bad = results.filter((r) => !r.ok);
      // 注意：r.ok 对 file:// 的本地副本通常为 true，但若被拦截会在这层暴露
      if (bad.length) throw new Error('模型资源缺失：' + bad.map((b) => b.file).join(', '));
      return { files: results.length, moc: refs.Moc, textures: refs.Textures, json, base };
    }

    async loadFromCDN() {
      if (!window.Live2DCubismCore) await loadScript(CORE_CDN);
      if (!window.Live2DCubismCore) throw new Error('Cubism Core 未就绪');
      injectImportMap();
      const t0 = performance.now();
      const P = await loadModule(CDN + '@pixi/core@' + PIXI_VERSION + '/dist/esm/core.mjs', 25000);
      const D = await loadModule(CDN + '@pixi/display@' + PIXI_VERSION + '/dist/esm/display.mjs', 25000);
      const ms = Math.round(performance.now() - t0);
      window.PIXI = Object.assign({}, P, D);
      // 该构建是 UMD：挂到 window.PIXI.live2d（依赖同页已有的 window.PIXI）
      await loadScript(DISPLAY_CDN);
      return this.collectLibs('cdn', ms);
    }

    async loadFromVendor() {
      const S = (url, what) => loadScript(url).catch((e) => {
        throw new Error(what + ' 缺失（' + url + '）：' + ((e && e.message) || e));
      });
      if (!window.Live2DCubismCore) {
        if (!(await exists(VENDOR.core))) throw new Error('本地 Cubism Core 不存在：' + VENDOR.core);
        await loadScriptTimed(VENDOR.core, 12000).catch((e) => {
          throw new Error('本地 Cubism Core 加载失败（' + VENDOR.core + '）：' + (e && e.message));
        });
        if (!window.Live2DCubismCore) throw new Error('Cubism Core 未注册全局 Live2DCubismCore');
      }
      if (!window.PIXI || !window.PIXI.Ticker) {
        if (await exists(VENDOR.pixiUmd)) {
          await S(VENDOR.pixiUmd, '本地 pixi.js');
        } else {
          await this.loadVendorPixiEsm();
        }
      }
      if (!(window.PIXI && window.PIXI.live2d)) await S(VENDOR.display, '本地 pixi-live2d-display');
      return this.collectLibs('vendor', 0);
    }

    /** 调试轨迹：dev-preview 的 ?debug=title 会接管 __cwLog */
    trace(msg) {
      if (typeof window.__cwLog === 'function') window.__cwLog(msg);
    }

    /** 分文件 ESM 版 pixi：拼一个 importmap，再动态 import core/display 后挂到 window.PIXI */
    async loadVendorPixiEsm() {
      const dir = new URL(VENDOR.pixiEsmDir, location.href).href;
      // core/display 是入口，必须存在；其他子包由浏览器按匹配前缀（最长优先）解析
      const required = ['core', 'display'];
      const missing = [];
      for (const p of required) {
        if (!(await exists(dir + p + '.mjs'))) missing.push('vendor/pixi/' + p + '.mjs');
      }
      for (const [k, path] of Object.entries(VENDOR.libs)) {
        if (!(await exists(new URL(path, location.href).href))) missing.push(path);
      }
      if (missing.length) throw new Error('本地 pixi 依赖缺失：' + missing.join('、'));
      if (!document.querySelector('script[type="importmap"]')) {
        const imports = {};
        for (const p of PIXI_PACKAGES) imports['@pixi/' + p] = dir + p + '.mjs';
        for (const [k, path] of Object.entries(VENDOR.libs)) {
          imports[k] = new URL(path, location.href).href;
        }
        const s = document.createElement('script');
        s.type = 'importmap';
        s.textContent = JSON.stringify({ imports });
        document.head.insertBefore(s, document.head.firstChild);
      }
      const core = await import(dir + 'core.mjs');
      const display = await import(dir + 'display.mjs');
      // core 只 `export * from '@pixi/extensions'`，Ticker / utils / Matrix 等要从各自子包取
      const [ticker, utils, math] = await Promise.all([
        import(dir + 'ticker.mjs'), import(dir + 'utils.mjs'), import(dir + 'math.mjs'),
      ]);
      const PIXI = Object.assign({}, utils, math, ticker, core, display);
      PIXI.utils = Object.assign({}, utils);
      window.PIXI = PIXI;
      return true;
    }

    collectLibs(source, ms) {
      const PIXI = window.PIXI;
      const live2d = PIXI && PIXI.live2d;
      if (!PIXI || typeof PIXI.Ticker !== 'function') throw new Error('pixi.js 未就绪（Ticker 缺失）');
      if (typeof PIXI.Renderer !== 'function' || typeof PIXI.Container !== 'function') {
        throw new Error('pixi.js 未就绪（Renderer/Container 缺失）');
      }
      if (!live2d || typeof live2d.Live2DModel !== 'function') throw new Error('pixi-live2d-display 未就绪');
      if (typeof window.Live2DCubismCore === 'undefined') throw new Error('Cubism Core 未就绪');
      live2d.startUpCubism4 && live2d.startUpCubism4();
      return { PIXI, Live2DModel: live2d.Live2DModel, source, ms };
    }

    async render({ PIXI, Live2DModel, source, ms }) {
      const stage = this.stageEl;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('舞台尺寸为 0');

      const driver = (this.driver = this.createDriverPlugin(PIXI));
      const app = this.createApp(PIXI, {
        rendererPlugins: driver.plugin ? [driver.plugin] : [],
        onPreRender: (renderer) => driver.draw(renderer),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        backgroundAlpha: 0,
        antialias: true,
        autoStart: false,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        powerPreference: 'high-performance',
        hello: false,
      });
      // pixi v6 的 Application 可能不会自动把 view 塞进 DOM
      const view = app.view;
      view.className = 'cw-live2d-view';
      view.setAttribute('aria-hidden', 'true');
      stage.appendChild(view);
      this.app = app;
      this.view = view;

      // WebGL 上下文丢失（显存不足的典型表现）→ 直接走降级
      view.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        console.warn('[live2d] WebGL 上下文丢失');
        this.fail('context-lost', 'WebGL 上下文丢失（显存不足）', false);
      }, false);

      // 模型加载本身也要有上限：纹理 2048² 在低内存设备上可能卡死
      const model = await Promise.race([
        Live2DModel.from(this.modelUrl, {
          autoInteract: false, // 焦点自己接管，避免和拖动冲突
          autoUpdate: app._compat === 'manual' ? false : true,
          idleMotionGroup: 'Idle',
        }),
        rejectAfter(25000, '模型渲染初始化超时（可能显存不足）'),
      ]);
      if (this.destroyed) {
        model.destroy();
        return;
      }
      this.model = model;
      app.stage.addChild(model);
      model.anchor.set(0.5, 1);
      model.interactive = false; // 拖动交给容器，DOM 层负责桌宠手感

      this.fit();
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(stage);

      // 模型自带呼吸 / 眨眼 / 物理（internalModel.update），这里再叠一层视线与表情。
      // 顺序：先模型更新（含内部 renderer），再写参数覆盖，最后交回给渲染回调。
      if (this.driver && this.driver.attach) this.driver.attach(model);
      // 逻辑更新（引擎推进 + 参数写入）挂在同一渲染循环上，保证与绘制同帧
      this.tickHandler = (dtMs) => {
        this.tick(dtMs);
        // 每帧先把绘制上下文准备好（纹理/GL 状态），再由 prerender 钩子真正画
        if (this.driver && this.driver.prepare) this.driver.prepare(app.renderer);
      };
      app.frameHooks = app.frameHooks || [];
      app.frameHooks.push(this.tickHandler);

      // 资源耗时信息交给 UI
      this.setState('assets-ok', { source, ms });
      app.start();

      // 可视化自检：启动若干帧后回读画布，若一个像素都没画出来，
      // 就当渲染失败降级（避免“状态是 ready、画面却是空白”的假成功）。
      this.verifyVisual(app);
      return true;
    }

    /**
     * pixi v6 的 Application 在 @pixi/app 包里，本项目的 vendor 只带 core/display 分片；
     * 这里按 Application 的语义（renderer + stage + ticker + resizeTo）自己组一个同形对象，
     * 对外仍然只有 app.stage / app.renderer / app.view / app.ticker / app.render / app.start / app.destroy。
     */
    createApp(PIXI, opts) {
      if (typeof PIXI.Application === 'function') return new PIXI.Application(opts);
      const canvas = opts.view || document.createElement('canvas');
      const self = this;
      // 渲染后端：优先 WebGL2（真机上更稳、显存管理更好），不可用时回落 WebGL1。
      // 可用 ?renderer=webgl1 / ?renderer=webgl2 强制指定。
      const forced = (() => {
        try { return new URLSearchParams(location.search).get('renderer'); } catch (_) { return null; }
      })();
      const baseOpts = {
        view: canvas,
        width: opts.width,
        height: opts.height,
        backgroundAlpha: opts.backgroundAlpha,
        antialias: opts.antialias,
        resolution: opts.resolution,
        autoDensity: opts.autoDensity,
        powerPreference: opts.powerPreference,
      };
      let renderer = null;
      const order = forced === 'webgl1' ? ['webgl1'] : forced === 'webgl2' ? ['webgl2'] : ['webgl2', 'webgl1'];
      for (const kind of order) {
        try {
          if (kind === 'webgl2' && typeof PIXI.Renderer2 === 'function') {
            const ctx = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
            if (!ctx) continue;
            renderer = new PIXI.Renderer2(Object.assign({ context: ctx }, baseOpts));
          } else if (kind === 'webgl2') {
            continue; // 没有 WebGL2 渲染器实现
          } else {
            renderer = new PIXI.Renderer(baseOpts);
          }
          if (renderer) {
            this.rendererKind = kind;
            break;
          }
        } catch (e) {
          console.warn('[live2d] ' + kind + ' 渲染器初始化失败：', e && e.message);
          renderer = null;
        }
      }
      if (!renderer) throw new Error('无法创建 WebGL 渲染器（显存或上下文不可用）');
      // 渲染生命周期钩子：挂在 renderer 的 prerender/postrender runner 上（与 pixi 内部一致），
      // 用于在每次真正绘制时同步 Live2D 的纹理/上下文状态。
      try {
        if (renderer.runners && renderer.runners.prerender) {
          renderer.runners.prerender.add(() => {
            if (typeof opts.onPreRender === 'function') opts.onPreRender(renderer);
          });
        }
        if (renderer.runners && renderer.runners.postrender) {
          renderer.runners.postrender.add(() => {
            if (typeof opts.onPostRender === 'function') opts.onPostRender(renderer);
          });
        }
      } catch (e) {
        console.warn('[live2d] 渲染钩子注册失败：', e);
      }
      const ticker = new PIXI.Ticker();
      const stage = new PIXI.Container();
      const app = {
        view: canvas,
        canvas,
        renderer,
        ticker,
        stage,
        render() {
          self._renderFrames = (self._renderFrames || 0) + 1;
          if (typeof opts.onFrame === 'function') opts.onFrame(renderer, ticker.deltaMS);
          renderer.render(stage);
        },
        destroy(removeView, stageOptions) {
          app.stop();
          ticker.stop();
          try { stage.destroy(stageOptions); } catch (_) { /* ignore */ }
          try { renderer.destroy(); } catch (_) { /* ignore */ }
          if (removeView && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        },
      };
      app._compat = 'manual';
      app._autoStart = opts.autoStart === true;
      // 自建渲染循环：不依赖 Ticker 的调度行为（vendor 分片的 Ticker 在不同环境下表现不一致），
      // 用 rAF 直接驱动，暂停/销毁时干净停止。
      let rafId = 0;
      let last = 0;
      const frame = (now) => {
        rafId = 0;
        const dt = last ? now - last : 16.7;
        last = now;
        ticker.deltaMS = dt; // 同步给依赖 deltaMS 的逻辑
        for (const hook of app.frameHooks || []) {
          try { hook(dt); } catch (e) { console.error('[live2d] frame hook 失败：', e); }
        }
        if (app._autoStart === false && app.stage && typeof app.stage.updateTransform === 'function') {
          try { app.stage.updateTransform(); } catch (_) { /* ignore */ }
        }
        app.render();
        if (app._running) rafId = requestAnimationFrame(frame);
      };
      app._running = false;
      app.start = function () {
        if (app._running) return app;
        app._running = true;
        last = 0;
        rafId = requestAnimationFrame(frame);
        return app;
      };
      app.stop = function () {
        app._running = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        return app;
      };
      // 可选：注册自定义 Renderer 插件（在 app 组装之后注入，插件内可拿到 app）
      for (const plugin of opts.rendererPlugins || []) {
        try {
          if (typeof plugin.init === 'function') plugin.init(app);
          renderer.plugins[plugin.name] = plugin;
        } catch (e) {
          console.warn('[live2d] 插件注册失败：', e);
        }
      }
      // 即便插件没渲染，也保证每帧都有一次 render 调用
      app.start();
      ticker.stop();
      return app;
    }

    /**
     * Live2D 驱动插件。
     * Live2DModel.update() 只累积时间；真正的 internalModel.update()（物理/眨眼/呼吸）
     * 与 draw() 都在它的 _render() 里，而 _render 需要 renderer.plugins.interaction /
     * batch / geometry / shader / state / texture 这些系统。完整 pixi 的 Application 自带；
     * 本项目用 core/display 分片手搓 App 时，这里补一个“最小可用的渲染上下文”。
     */
    createDriverPlugin(PIXI) {
      const self = this;
      let model = null;

      /**
       * 把 pixi BaseTexture 的资源上传成一个最小 GL 纹理，并登记到 _glTextures[CONTEXT_UID]。
       * 返回 { texture } 或 null；失败只记日志，不中断整帧。
       */
      const ensureGLTexture = (renderer, baseTexture) => {
        if (!renderer || !baseTexture) return null;
        const gl = renderer.gl;
        const uid = renderer.CONTEXT_UID;
        if (!gl || !uid) return null;
        if (!baseTexture._glTextures) baseTexture._glTextures = new Map();
        const cached = baseTexture._glTextures[uid];
        if (cached && cached.texture) return cached;
        try {
          const res = baseTexture.resource || {};
          const source = res.source || res.data || baseTexture.realWidth && res;
          const w = baseTexture.realWidth || baseTexture.width;
          const h = baseTexture.realHeight || baseTexture.height;
          if (!source || !w || !h) return null;
          const texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // pixi v6 默认翻转 Y
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.bindTexture(gl.TEXTURE_2D, null);
          const info = { texture, width: w, height: h };
          baseTexture._glTextures[uid] = info;
          baseTexture.touched = 1;
          return info;
        } catch (e) {
          console.warn('[live2d] 纹理上传失败：', e);
          return null;
        }
      };

      let app = null;
      const plugin = {
        name: 'cwLive2D',
        init(a) { app = a; },
        guard: () => !!model,
        render() {
          const renderer = (app || self.app) && (app || self.app).renderer;
          if (!renderer) return;
          this.prepare(renderer);
          this.draw(renderer);
        },
        start() {},
        stop() {},
        destroy() { model = null; },
        /** 准备：补齐系统对象 + 上传纹理（每帧幂等） */
        prepare(renderer) {
          if (!model || !renderer) return;
          self._prepared = true;
          renderer.batch = renderer.batch || { reset() {} };
          renderer.geometry = renderer.geometry || { reset() {} };
          renderer.shader = renderer.shader || { reset() {} };
          renderer.state = renderer.state || { reset() {} };
          // 纹理直传：Live2DModel._render 读取的是 baseTexture._glTextures[CONTEXT_UID].texture，
          // 这里把 BaseTexture 的资源自己上传成一份最小的 GL 纹理登记表。
          renderer.texture = {
            reset() {},
            bind() { /* 由 ensureGLTexture 在 render 前完成，绑定由模型内部自己 setActive/Bind */ },
          };
          for (const tex of model.textures || []) {
            const texInfo = ensureGLTexture(renderer, tex && tex.baseTexture);
            if (texInfo) model.internalModel.bindTexture(model.textures.indexOf(tex), texInfo.texture);
          }
          const plugins = renderer.plugins || (renderer.plugins = {});
          if (!plugins.interaction) plugins.interaction = {};
        },

        /** 绘制：由渲染生命周期钩子调用（此时 pixi 的渲染状态已就绪） */
        draw(renderer) {
          if (!model || !model.visible || !renderer) return;
          try {
            model._render(renderer);
          } catch (e) {
            console.error('[live2d] 模型绘制失败：', e);
            self.fail('render', '模型绘制失败：' + (e && e.message), false);
          }
        },
      };

      return {
        plugin,
        attach(m) { model = m; },
        /** 由渲染回调每帧调用：补齐系统 → 调用 Live2DModel._render（内部含 update+draw） */
        prepare(renderer) {
          if (renderer) app = app || { renderer };
          plugin.prepare(renderer);
        },
        draw(renderer) {
          plugin.draw(renderer || (app && app.renderer));
        },
      };
    }

    /** 按舞台尺寸等比缩放并对齐底部 */
    fit() {
      if (!this.model || !this.app) return;
      const w = (this.app.screen ? this.app.screen.width : this.app.renderer.width / this.app.renderer.resolution);
      const h = (this.app.screen ? this.app.screen.height : this.app.renderer.height / this.app.renderer.resolution);
      if (!w || !h) return;
      const nativeW = this.model.internalModel ? this.model.internalModel.originalWidth : this.model.width;
      const nativeH = this.model.internalModel ? this.model.internalModel.originalHeight : this.model.height;
      const margin = 0.94; // 底部留白，避免被裁
      const s = Math.min(w / nativeW, h / nativeH) * margin;
      this.model.scale.set(s);
      // 模型内部坐标：anchor 在底部中心
      this.model.x = w / 2;
      this.model.y = h * 0.995;
      this.baseScale = s;
    }

    /**
     * 首帧可视性自检：等模型至少画过一帧，再回读画布的 alpha。
     * 全 0 说明 GPU 管线没产出（或显存不足），此时应当降级而不是停在空白舞台。
     */
    verifyVisual(app) {
      const attempts = [900, 1600, 2400];
      const check = (i) => {
        if (this.destroyed || this.state !== 'ready' || !this.app) return;
        const gl = this.app.renderer && this.app.renderer.gl;
        if (!gl) return;
        try {
          const w = gl.drawingBufferWidth || 1;
          const h = gl.drawingBufferHeight || 1;
          const px = new Uint8Array(4);
          gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (px[3] > 0) {
            return;
          }
        } catch (_) { /* 读回失败不作为判定依据 */ }
        if (i + 1 < attempts.length) {
          this.after(attempts[i + 1] - attempts[i], () => check(i + 1));
        } else {
          this.fail('blank', '模型已加载，但 GPU 未产出任何像素（显存/着色器管线受限）', false);
        }
      };
      this.after(attempts[0], () => check(0));
    }

    /** 每帧：推进引擎 → 视线交给 focusController → 表情参数写进 coreModel */
    tick(dtMs) {
      const m = this.model;
      if (!m || !this.app) return;
      const core = m.internalModel && m.internalModel.coreModel;
      if (!core) return;
      const now = performance.now();
      const dt = Math.min(0.1, (dtMs || (now - (this._lastTick || now)) || 16.7) / 1000);
      this._lastTick = now;
      this.engine.update(dt);
      this.engine.applyFocus(m);
      const p = this.engine.params();
      // 视线/头部由 focusController 负责，这里只补“表情/细节”，避免两套系统打架
      const EXPRESSION_IDS = ['ParamMouthForm', 'ParamMouthOpenY', 'ParamCheek', 'ParamHairFront', 'ParamHairSide', 'ParamHairBack'];
      for (const id of EXPRESSION_IDS) {
        if (!(id in p)) continue;
        try { core.addParameterValueById(id, p[id]); } catch (_) { /* 参数不存在则跳过 */ }
      }
    }

    /** 空闲动作：给桌宠一点“活着”的感觉 */
    startIdle() {
      const loop = () => {
        this.after(18000 + Math.random() * 10000, loop);
        if (this.destroyed || this.state !== 'ready') return;
        this.action('idle');
        this.say(CW.util.pick(['……', '嗯？', '在这里哦', '要开始了吗']));
      };
      this.after(6000, loop);
    }

    /** 让模型播一段随机动作（动作组 Idle/TapBody 等，模型里有什么用什么） */
    playMotion(group) {
      if (!this.model) return;
      const groups = [];
      try {
        const defs = this.model.internalModel.motionManager.definitions || {};
        groups.push(...Object.keys(defs));
      } catch (_) { /* 忽略 */ }
      const target = group && groups.includes(group) ? group : (groups.includes('Idle') ? 'Idle' : groups[0]);
      if (target) {
        try { this.model.motion(target).catch(() => {}); } catch (_) { /* ignore */ }
      }
    }

    /** 气泡台词（DOM 层，和模型无关，降级时同样有效） */
    say(text, ms = 2600) {
      if (!this.bubble || !text) return;
      this.bubble.textContent = text;
      this.bubble.classList.add('is-show');
      clearTimeout(this._bubbleTimer);
      this._bubbleTimer = setTimeout(() => this.bubble && this.bubble.classList.remove('is-show'), ms);
    }

    /** 桌宠被点：写逻辑，不依赖模型是否渲染成功 */
    poke() {
      const reactions = ['呀！', '别戳啦~', '摸摸头', '在的哦', '嘿嘿'];
      this.engine.poke();
      this.action('poke');
      this.say(CW.util.pick(reactions));
      this.playMotion('TapBody');
    }

    fail(code, message, fatal) {
      this.errorCode = code;
      this.errorMessage = message;
      // 清理已创建的资源，避免在显存不足时继续持有上下文
      try {
        if (this.app) {
          try { this.app.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
      this.app = null;
      this.model = null;
      if (this.resizeObserver) { try { this.resizeObserver.disconnect(); } catch (_) { /* ignore */ } }
      if (!this.destroyed) this.setState('failed', { code, message, fatal });
      return false;
    }

    destroy() {
      this.destroyed = true;
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      try { if (this.app) this.app.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (_) { /* ignore */ }
    }
  }

  CW.Live2DStage = Live2DStage;
  CW.PetEngine = PetEngine;
})((window.CW = window.CW || {}));
