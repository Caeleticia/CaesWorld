/*!
 * Cae'sWorld — pet.js
 * 桌宠（主菜单右侧）：
 *  - 舞台：承载 Live2D 画布（或降级插画），跟随主内容区尺寸；
 *  - 交互：拖动移动、点击戳反应、长按弹出抽屉（收起 / 重置位置 / 重试加载）；
 *  - 气泡：桌宠说话（DOM 层，渲染失败时依旧可用）；
 *  - 降级：任何失败都展示“已检测到资源、渲染未成功”的状态卡 + 逻辑说明，
 *    保证信息不丢、界面不黑屏。
 */
(function (CW) {
  'use strict';

  const { el, clamp } = CW.util;
  const POS_KEY = 'pet.pos';

  const REPLIES = {
    hello: ['嗨，欢迎回来！', '今天想做一张什么样的卡？', '我在这里哦'],
    poke: null, // 交给 Live2DStage.poke 自己挑
    drag: ['呜哇，放我下来~', '要带我去哪儿？'],
    dock: ['我去旁边待着啦'],
  };

  /**
   * 舞台控制器：管理一个 host 容器里的渲染器实例。
   * 优先 Live2D（独占 host），失败时渲染手绘替身（同容器，不影响其它浮动组件）。
   */
  class Stage {
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.mode = 'pending';
      this.model = null;
      this.fallbackEl = null;
      this.statusText = '准备中…';
    }

    get isLive() { return this.mode === 'live2d'; }

    start() {
      if (this.model) this.model.destroy();
      if (this.fallbackEl && this.fallbackEl.parentNode) this.fallbackEl.remove();
      this.fallbackEl = null;
      this.mode = 'pending';
      this.host.classList.add('is-loading');
      this.host.classList.remove('is-fallback');
      this.statusText = '正在加载 Live2D…';

      this.model = new CW.Live2DStage(this.host, {
        onState: (s, d) => this.onState(s, d),
        onAction: (a) => this.onAction(a),
      });
      this.model.bubble = this.opts.bubble;
      this.model.mount().catch((e) => {
        console.error('[pet] 未捕获的 Live2D 异常：', e);
        this.showFallback('unexpected', String((e && e.message) || e));
      });
      return true;
    }

    retry() { return this.start(); }

    onState(state, detail) {
      const map = {
        checking: '检查模型资源…',
        'assets-ok': (d) => `模型资源就绪（${(d && d.files) || 0} 个文件），准备渲染…`,
        'loading-libs': '正在加载渲染依赖…',
        building: '正在创建渲染器…',
        ready: (d) => 'Live2D 运行中' + (d && d.source === 'vendor' ? '（本地依赖）' : ''),
      };
      if (state === 'ready') {
        this.mode = 'live2d';
        this.statusText = 'Live2D 运行中' + (detail && detail.source === 'vendor' ? '（本地依赖）' : '');
        this.host.classList.remove('is-loading');
        if (this.opts.onStatus) this.opts.onStatus(this);
        return;
      }
      if (state === 'failed') {
        this.showFallback(detail.code, detail.message);
        return;
      }
      const m = map[state];
      this.statusText = typeof m === 'function' ? m(detail) : (m || this.statusText);
      if (this.opts.onStatus) this.opts.onStatus(this);
    }

    onAction(a) {
      if (this.opts.onAction) this.opts.onAction(a);
    }

    say(text, ms) {
      if (this.model && this.mode === 'live2d') return this.model.say(text, ms);
      if (this.opts.say) this.opts.say(text, ms);
    }

    poke() {
      if (this.model) this.model.poke();
      if (this.opts.onPoke) this.opts.onPoke();
    }

    showFallback(code, message) {
      this.mode = 'fallback';
      if (this.model) {
        this.model.destroy();
        this.model = null;
      }
      this.host.classList.remove('is-loading');
      this.host.classList.add('is-fallback');

      const kindMap = {
        nogl: '当前环境没有可用的 WebGL',
        'context-lost': 'WebGL 上下文丢失（通常是显存不足）',
        gpu: 'GPU 渲染失败（通常是显存不足）',
        libs: '渲染依赖没能加载',
        render: '渲染器创建失败',
        unexpected: '出现未预期的错误',
      };
      const reason = kindMap[code] || '渲染未成功';
      this.statusText = reason + (message ? '：' + message : '');
      this.opts.say && this.opts.say('先用这个替身陪你一会儿吧', 2600);

      const tips = {
        nogl: '模型文件与桌宠逻辑都已就绪；本机 WebGL 无法执行着色器，换一台支持 WebGL 的设备即可看到 hiyori。',
        'context-lost': '浏览器回收了 3D 舞台的资源。桌宠逻辑（拖动、戳、气泡）仍按原设计工作。',
        gpu: '显存不足以同时容纳两张 2048² 贴图。可点「重试」或关闭其它页面后再来。',
        libs: '网络未连通 CDN。把 pixi 的 dist/esm 子包与 cubism4.min.js 放进 vendor/ 即可离线运行。',
      };

      const f = el('div.cw-pet-fallback.is-show',
        el('div.cw-pet-portrait', { 'aria-hidden': 'true' },
          el('span.cw-pet-portrait-head'),
          el('span.cw-pet-portrait-body'),
          el('span.cw-pet-portrait-mark', 'hiyori'),
        ),
        el('div.cw-pet-fail-card',
          el('div.cw-pet-fail-title', el('span.cw-dot-warn'), ' Live2D 未启用'),
          el('p.cw-pet-fail-reason', this.statusText),
          el('p.cw-pet-fail-tip', tips[code] || '桌宠逻辑不受影响：拖动、戳一下、双击看设置。'),
          el('div.cw-pet-fail-code', el('code', code || 'unknown')),
        ),
      );
      this.fallbackEl = f;
      this.host.append(f);
      if (this.opts.onStatus) this.opts.onStatus(this);
    }

    destroy() {
      if (this.model) this.model.destroy();
      this.model = null;
    }
  }

  class Pet {
    constructor(opts) {
      this.opts = opts || {};
      this.root = null;
      this.stage = null;
      this.pressTimer = null;
      this.moved = false;
      this.build();
    }

    build() {
      this.bubble = el('div.cw-pet-bubble', { role: 'status', 'aria-live': 'polite' });

      this.stageEl = el('div.cw-pet-stage');
      this.hint = el('div.cw-pet-hint', {
        text: '拖动我 · 戳一下 · 双击设置',
        'aria-hidden': 'true',
      });

      this.root = el('div.cw-pet', {
        tabindex: '0',
        role: 'group',
        'aria-label': '桌面角色 hiyori · 拖动移动，回车戳一下',
      }, this.bubble, this.stageEl, this.hint);

      this.statusBox = el('div.cw-pet-status', { 'aria-live': 'polite' },
        el('i.cw-pet-dot'),
        el('span.cw-pet-status-text', '桌宠加载中…'),
        el('button.cw-pet-retry.chip', { type: 'button', 'data-act': 'retry', hidden: true }, '重试'),
      );

      this.stage = new Stage(this.stageEl, {
        bubble: this.bubble,
        say: (t, ms) => this.say(t, ms),
        onPoke: () => this.pokeVisual(),
        onStatus: (st) => this.onStageStatus(st),
      });

      this.restorePos();
      this.bind();
    }

    onStageStatus(st) {
      this.root.dataset.status = st.mode === 'live2d' ? 'live' : st.mode === 'fallback' ? 'fallback' : 'loading';
      const text = this.statusBox && this.statusBox.querySelector('.cw-pet-status-text');
      if (text) text.textContent = this.shortStatus(st);
      const retry = this.statusBox && this.statusBox.querySelector('[data-act="retry"]');
      if (retry) retry.hidden = st.mode !== 'fallback';
      if (this.onStageChange) {
        try { this.onStageChange(st); } catch (e) { console.error(e); }
      }
    }

    /** 常驻状态行只放短句；详细原因进抽屉 */
    shortStatus(st) {
      if (st.mode === 'live2d') return 'hiyori · Live2D';
      if (st.mode === 'fallback') return '替身模式';
      const s = st.statusText || '';
      if (/模型资源就绪/.test(s)) return '资源就绪 · 准备渲染';
      return s.replace(/（.*?）/g, '').slice(0, 14) || '加载中…';
    }

    /** 外部（app）在桌宠出现后调用 */
    activate() {
      this.root.classList.add('is-entering');
      setTimeout(() => this.root && this.root.classList.remove('is-entering'), 900);
      setTimeout(() => this.ring(), 700);
      this.stage.start();
      // 调试：?poke=1 进入后自动戳一下（验证气泡/反应链路）
      const q = new URLSearchParams(location.search);
      if (q.get('poke') === '1') setTimeout(() => this.poke(), Number(q.get('at') || 2500));
    }

    /** 提示环：告诉用户“这里有东西可以拖” */
    ring() {
      this.root.classList.add('is-ring');
      setTimeout(() => this.root && this.root.classList.remove('is-ring'), 2600);
    }

    /** 双击：抽屉（含状态、重试、位置控制） */
    openDrawer() {
      if (!this.drawer) this.drawer = this.buildDrawer();
      const note = this.drawer.querySelector('.cw-pet-note');
      if (note) note.textContent = this.stage.statusText;
      const badge = this.drawer.querySelector('.cw-pet-badge');
      if (badge) badge.textContent = this.stage.mode === 'live2d' ? 'Live2D 运行中' : this.stage.mode === 'fallback' ? '降级替身' : '加载中';
      document.body.append(this.drawer);
      requestAnimationFrame(() => this.drawer && this.drawer.classList.add('is-open'));
    }

    closeDrawer() {
      if (!this.drawer) return;
      this.drawer.classList.remove('is-open');
    }

    buildDrawer() {
      const d = el('div.cw-pet-drawer.sheet', { role: 'dialog', 'aria-label': '桌宠设置' },
        el('div.sheet-handle', { 'aria-hidden': 'true' }),
        el('div.sheet-title',
          el('strong', '桌宠设置'),
          el('span.cw-pet-badge', '由 Live2D 驱动'),
        ),
        el('div.sheet-actions',
          el('button.chip.ink', { type: 'button', 'data-act': 'retry' }, '重试加载'),
          el('button.chip', { type: 'button', 'data-act': 'reset' }, '回到右下角'),
          el('button.chip', { type: 'button', 'data-act': 'poke' }, '逗一下'),
        ),
        el('p.cw-pet-note', { 'aria-live': 'polite' }),
        el('button.chip.cw-pet-close', { type: 'button', 'data-act': 'close' }, '关闭'),
      );
      d.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'retry') { this.stage.retry(); this.closeDrawer(); }
        else if (act === 'reset') { this.resetPos(); this.closeDrawer(); }
        else if (act === 'poke') { this.poke(); }
        else if (act === 'close') this.closeDrawer();
      });
      return d;
    }

    bind() {
      const r = this.root;
      r.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      r.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.openDrawer();
      });
      r.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.poke();
        } else if (e.key === 'ContextMenu' || (e.key === 'F2')) {
          e.preventDefault();
          this.openDrawer();
        }
      });
      this.statusBox.querySelector('[data-act="retry"]').addEventListener('click', (e) => {
        e.stopPropagation();
        this.stage.retry();
      });
      // 点击其它地方关闭抽屉
      document.addEventListener('pointerdown', (e) => {
        if (this.drawer && this.drawer.classList.contains('is-open') && !this.drawer.contains(e.target) && !this.root.contains(e.target)) {
          this.closeDrawer();
        }
      }, true);
    }

    /* ---------------- 位置 ---------------- */

    restorePos() {
      const saved = CW.store.get(POS_KEY, null);
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        this.applyPos(saved.x, saved.y);
      } else {
        this.root.classList.add('is-default-pos');
      }
    }

    applyPos(x, y) {
      const r = this.root.getBoundingClientRect();
      const maxX = Math.max(0, window.innerWidth - r.width - 8);
      const maxY = Math.max(0, window.innerHeight - r.height - 8);
      const px = clamp(x, 8, maxX);
      const py = clamp(y, 8, maxY);
      this.root.classList.remove('is-default-pos');
      this.root.style.left = px + 'px';
      this.root.style.top = py + 'px';
      this.root.style.right = 'auto';
      this.root.style.bottom = 'auto';
    }

    persistPos() {
      const r = this.root.getBoundingClientRect();
      if (!r.width) return;
      CW.store.set(POS_KEY, { x: Math.round(r.left), y: Math.round(r.top) });
    }

    resetPos() {
      this.root.style.left = '';
      this.root.style.top = '';
      this.root.style.right = '';
      this.root.style.bottom = '';
      this.root.classList.add('is-default-pos');
      CW.store.remove(POS_KEY);
      this.say('回到老位置啦');
    }

    /* ---------------- 交互：拖 / 戳 / 双击设置 ---------------- */

    onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('.cw-pet-drawer, .cw-pet-retry')) return;
      this.pressStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.dragStart = this.root.getBoundingClientRect();
      this.moved = false;
      try { this.root.setPointerCapture(e.pointerId); } catch (_) { /* 某些内核不支持 */ }

      const move = (ev) => this.onPointerMove(ev);
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        this.onPointerUp(ev);
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }

    onPointerMove(e) {
      if (!this.pressStart) return;
      const dx = e.clientX - this.pressStart.x;
      const dy = e.clientY - this.pressStart.y;
      if (!this.moved && Math.hypot(dx, dy) < 6) return;
      if (!this.moved) {
        this.moved = true;
        this.root.classList.add('is-dragging');
        this.closeDrawer();
        this.dragToastShown = false;
      }
      if (e.cancelable) e.preventDefault();
      this.applyPos(this.dragStart.left + dx, this.dragStart.top + dy);
      if (!this.dragToastShown && Math.hypot(dx, dy) > 40) {
        this.dragToastShown = true;
        if (Math.random() < 0.45) this.say(CW.util.pick(REPLIES.drag));
      }
    }

    onPointerUp() {
      const wasDrag = this.moved;
      const dt = this.pressStart ? performance.now() - this.pressStart.t : 0;
      this.pressStart = null;
      this.moved = false;
      this.root.classList.remove('is-dragging');
      if (wasDrag) {
        this.persistPos();
        return;
      }
      if (dt < 600) this.poke();
    }

    poke() {
      this.pokeVisual();
      this.stage.poke();
    }

    pokeVisual() {
      this.root.classList.add('is-poked');
      clearTimeout(this._pokeTimer);
      this._pokeTimer = setTimeout(() => this.root && this.root.classList.remove('is-poked'), 520);
    }

    /**
     * 说话：后到优先。
     * 长提示（如自动加载播报）不该把随后的戳击台词直接清掉——较短的新台词总是接管气泡。
     */
    say(text, ms) {
      if (!text) return;
      const life = ms || 2200;
      this._bubbleUntil = Date.now() + life;
      this.bubble.textContent = text;
      this.bubble.classList.add('is-show');
      clearTimeout(this._bubbleTimer);
      this._bubbleTimer = setTimeout(() => {
        if (this.bubble) this.bubble.classList.remove('is-show');
        this._bubbleUntil = 0;
      }, life);
    }

    /* ---------------- 挂载 ---------------- */

    /** 由主菜单接线：把桌宠挂到右侧内容区（浮动层） */
    attachTo(layer) {
      this.layer = layer;
      layer.append(this.root);
      layer.append(this.statusBox);
      window.addEventListener('resize', CW.util.rafThrottle(() => {
        if (this.root.classList.contains('is-default-pos')) return;
        const r = this.root.getBoundingClientRect();
        this.applyPos(r.left, r.top);
      }));
    }
  }

  CW.Pet = Pet;
})((window.CW = window.CW || {}));
