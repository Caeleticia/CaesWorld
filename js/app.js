/*!
 * Cae'sWorld — app.js
 * 启动流程与界面编排：
 *   loading（大标题 + 你知道吗 + 进度条）→ 主菜单（左侧栏 + 右侧桌宠舞台）
 *
 * 启动顺序（每一步推进一段进度，保证进度条真实反映工作）：
 *   1. 字体就绪        2. 读取字符库 data/tips.txt
 *   3. 读取存档/偏好    4. 组件预热（图标、菜单结构）
 *   5. 进入主菜单（桌宠在后台异步加载，不阻塞界面）
 */
(function (CW) {
  'use strict';

  const { $, $$, el, sleep, pick, clamp } = CW.util;

  const MIN_LOADING_MS = 900; // 进度条太快会像“闪一下”，给一个最低时长
  const TIPS_INTERVAL = 7000;

  const App = {
    tipsTimer: null,
    pet: null,
    current: { menu: 'play', option: 'play.local' },
    openMenu: 'play',
    loadingDone: false,

    async boot() {
      const t0 = performance.now();
      this.cacheDom();
      // 让载入页先在屏幕上出现，再执行第一帧绘制（宽高才量得准）
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      this.bindLoading();
      this.startLoadingTips();

      // 阶段脚本：每个阶段返回进度与状态文案
      const stages = [
        ['准备画布', async (p) => { await sleep(120); p(0.08); }],
        ['读取字符库', async (p) => {
          const r = await CW.tips.load();
          p(0.34, r.ok ? `已载入 ${r.count} 条你知道吗` : `使用备用字符库（${r.count} 条）`);
          this.refreshTips(true);
        }],
        ['读取存档', async (p) => {
          this.settings = CW.store.get('settings', {});
          const last = CW.store.get('lastRoute', null);
          if (last && CW.menus.option(last.option)) this.current = { menu: last.menu, option: last.option };
          this.openMenu = this.current.menu;
          p(0.54);
        }],
        ['准备界面组件', async (p) => {
          this.buildSidebar();
          this.buildDemo();
          p(0.76);
        }],
        ['校验模型资源', async (p) => {
          // 只看 manifest 是否可读，真正的渲染由桌宠自己异步做，不阻塞进入
          try {
            const r = await fetch(CW.route('vendor/live2d/hiyori_vts/hiyori.model3.json'), { cache: 'no-cache' });
            p(0.93, r.ok ? '模型文件已就位' : '模型文件不可读（不影响进入）');
          } catch (_) {
            p(0.93, '模型文件需通过本地服务器访问');
          }
        }],
      ];

      const progress = this.makeProgress();
      try {
        await Promise.all(stages.map(async ([label, fn]) => {
          progress.label(label);
          await fn((v, note) => progress.set(v, note));
        }));
      } catch (e) {
        console.error('[boot] 启动阶段出错：', e);
      }

      // 保证最低时长 & 进度满
      progress.allDone();
      const elapsed = performance.now() - t0;
      if (elapsed < MIN_LOADING_MS) await sleep(MIN_LOADING_MS - elapsed);
      progress.complete('准备就绪');
      // 等进度条“跑到头”再切场景
      await new Promise((r) => setTimeout(r, 420));
      this.enterMainMenu('准备就绪');
    },

    cacheDom() {
      this.loadingScreen = $('#loading-screen');
      this.loadingTip = $('#loading-tip');
      this.loadingBar = $('#loading-bar');
      this.loadingPct = $('#loading-pct');
      this.loadingStatus = $('#loading-status');
      this.mainScreen = $('#main-screen');
      this.paintPaper();
      this.sidebarList = $('#sidebar-list');
      this.content = $('#content');
      this.petLayer = $('#pet-layer');
    },

    /** 给载入页铺满方格纸：用 <path> 一次性画线与装订孔，长宽随视口自适应 */
    paintPaper() {
      const svg = $('.loading-paper-svg');
      if (!svg) return;
      const W = 1600;
      const H = 900;
      const step = 22;
      const major = step * 5;
      const minor = [];
      const maj = [];
      // 横向/纵向细线（跳过与主格线重合的）
      for (let x = step; x < W; x += step) (x % major ? minor : maj).push(`M${x} 0V${H}`);
      for (let y = step; y < H; y += step) (y % major ? minor : maj).push(`M0 ${y}H${W}`);
      // 左侧装订孔（像活页本）
      const holes = [];
      for (let y = 40; y < H; y += 96) holes.push(`M${12} ${y}a4 4 0 1 0 .1 0Z`);
      svg.innerHTML =
        `<g fill="none" stroke-linecap="round">` +
        `<path d="${minor.join('')}" stroke="rgba(150,122,92,.11)" stroke-width="1"/>` +
        `<path d="${maj.join('')}" stroke="rgba(150,122,92,.2)" stroke-width="1"/>` +
        `</g>` +
        `<path d="${holes.join('')}" fill="rgba(150,122,92,.07)" stroke="rgba(150,122,92,.28)" stroke-width="1"/>`;
    },

    /* ---------------- 加载页 ---------------- */

    startLoadingTips() {
      const swap = () => this.refreshTips(false);
      // 前几秒快速轮播一次，让人意识到“你知道吗”在变
      setTimeout(swap, 1600);
      setTimeout(swap, 2600);
      this.tipsTimer = setInterval(swap, TIPS_INTERVAL);
    },

    refreshTips(immediate) {
      const text = CW.tips.randomTip();
      const nodes = $$('.cw-tip-text');
      nodes.forEach((n) => {
        n.classList.remove('is-swap');
        // 用 rAF 重启动画
        requestAnimationFrame(() => {
          n.textContent = text;
          n.classList.add('is-swap');
        });
      });
      if (immediate && this.loadingTip) this.loadingTip.textContent = text;
    },

    /**
     * 进度条：真实进度 = 已完成阶段数 / 总阶段数；显示值向真实值缓动（有“手感”），
     * 最后一小段冲刺。并发阶段各自上报完成，取最大者即可。
     */
    makeProgress() {
      const state = { done: 0, total: 5, target: 0.04, display: 0.02, complete: false, note: '' };
      const bar = this.loadingBar;
      const pct = this.loadingPct;
      const status = this.loadingStatus;
      const paint = () => {
        const v = state.display;
        if (bar) {
          bar.style.width = (v * 100).toFixed(1) + '%';
          bar.setAttribute('aria-valuenow', String(Math.round(v * 100)));
        }
        if (pct) pct.textContent = Math.round(v * 100) + '%';
      };
      const loop = () => {
        const t = Math.min(state.target, state.complete ? null : 0.97);
        state.display += (t - state.display) * (state.complete ? 0.16 : 0.09);
        if (state.complete && state.target - state.display < 0.002) state.display = Math.min(state.target, 0.985);
        paint();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);

      const setNote = (text) => {
        if (!text) return;
        state.note = text;
        if (status) status.textContent = text;
      };

      return {
        label: (l) => setNote('正在' + l + '…'),
        /** 某阶段完成：v 为该阶段完成时的目标总进度（0..1） */
        set: (v, note) => {
          state.done += 1;
          state.target = Math.max(state.target, clamp(v, 0, 0.96));
          setNote(note);
        },
        allDone: () => { state.target = 0.9; },
        complete: (note) => { state.complete = true; state.target = 1; setNote(note); },
      };
    },

    bindLoading() {
      // 兜底：若某个阶段卡死超过上限，直接进入主菜单（UI 优先可进入）
      setTimeout(() => {
        if (!this.loadingDone) {
          console.warn('[boot] 加载超时，直接进入主菜单');
          this.enterMainMenu('加载超时，已跳过');
        }
      }, 12000);
    },

    async enterMainMenu(reason) {
      if (window.__cwFreeze) { console.info('[preview] 载入页已冻结'); return; }
      if (this.loadingDone) return;
      this.loadingDone = true;
      if (this.tipsTimer) clearInterval(this.tipsTimer);
      if (this.loadingBar) {
        this.loadingBar.style.width = '100%';
        this.loadingBar.setAttribute('aria-valuenow', '100');
      }
      if (this.loadingPct) this.loadingPct.textContent = '100%';
      if (reason && this.loadingStatus) this.loadingStatus.textContent = reason;
      document.body.classList.remove('is-booting');
      document.body.classList.add('in-menu');
      await sleep(260);

      this.loadingScreen.classList.add('is-leaving');
      this.mainScreen.hidden = false;
      // 强制重排后加入场，保证动画一定播放
      void this.mainScreen.offsetWidth;
      this.mainScreen.classList.add('is-entering');

      setTimeout(() => { this.loadingScreen.hidden = true; }, 700);
      setTimeout(() => this.mainScreen.classList.remove('is-entering'), 1200);

      // 进入后：桌宠异步登场（不阻塞）
      this.mountPet();
      this.sayHello();
    },

    /* ---------------- 主菜单 ---------------- */

    buildSidebar() {
      const list = this.sidebarList;
      const nav = el('nav.sidebar-nav', { role: 'navigation', 'aria-label': '主菜单' });

      for (const m of CW.menus.items) {
        const optId = m.options && m.options.length ? m.options[0].id : null;
        const item = el('div.sidebar-item', { 'data-menu': m.id },
          el('button.sidebar-tab', {
            type: 'button',
            'aria-expanded': 'false',
            'aria-controls': 'submenu-' + m.id,
            'data-menu': m.id,
            title: m.en,
          },
            el('span.sidebar-ico', { html: CW.icons(m.icon) }),
            el('span.sidebar-label', m.label),
            m.tag ? el('span.sidebar-tag', m.tag) : null,
            el('span.sidebar-chev', { 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24"><path d="M9 6.5 15 12l-6 5.5"/></svg>' }),
          ),
          el('div.sidebar-sub', { id: 'submenu-' + m.id, role: 'group', 'aria-label': m.label + '的子选项' },
            el('div.sidebar-sub-inner',
              (m.options || []).map((o, i) =>
                el('button.sub-opt', {
                  type: 'button',
                  'data-option': o.id,
                  'data-menu': m.id,
                  style: { '--i': String(i) },
                },
                  el('span.sub-ico', { html: CW.icons(o.icon) }),
                  el('span.sub-body', el('span.sub-label', o.label), el('span.sub-desc', o.desc)),
                  el('span.sub-en', o.en),
                ),
              ),
            ),
          ),
        );
        nav.append(item);
      }

      nav.addEventListener('click', (e) => {
        const tab = e.target.closest('.sidebar-tab');
        const opt = e.target.closest('.sub-opt');
        if (tab) { this.toggleMenu(tab.dataset.menu); return; }
        if (opt) { this.selectOption(opt.dataset.option); }
      });
      // “你知道吗”换一条
      const swap = $('.sidebar-tip-swap');
      if (swap) swap.addEventListener('click', () => this.refreshTips(true));

      nav.addEventListener('keydown', (e) => {
        // Esc 收起子菜单
        if (e.key === 'Escape') this.collapseAll();
      });

      this.sidebarList.append(nav);
    },

    toggleMenu(id) {
      const willOpen = this.openMenu !== id;
      this.openMenu = willOpen ? id : null;
      $$('.sidebar-item', this.sidebarList).forEach((it) => {
        const on = it.dataset.menu === id && willOpen;
        it.classList.toggle('is-open', on);
        const tab = it.querySelector('.sidebar-tab');
        if (tab) tab.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
      // 展开时：默认点第一个模式（纯 UI 演示，不进入玩法）
      const menu = CW.menus.menu(id);
      if (willOpen && menu && menu.options[0] && !menu.options.some((o) => o.id === this.current.option)) {
        this.current = { menu: id, option: menu.options[0].id };
        this.renderView(false);
      }
    },

    collapseAll() {
      this.openMenu = null;
      $$('.sidebar-item', this.sidebarList).forEach((it) => {
        it.classList.remove('is-open');
        const tab = it.querySelector('.sidebar-tab');
        if (tab) tab.setAttribute('aria-expanded', 'false');
      });
    },

    selectOption(optionId) {
      const o = CW.menus.option(optionId);
      if (!o) return;
      this.current = { menu: o.parent, option: o.id };
      CW.store.set('lastRoute', this.current);
      this.renderView(true);
    },

    /* ---------------- 右侧演示区 ---------------- */

    /**
     * 右侧内联替身：仅当桌宠渲染失败时显示。
     * 桌宠本身是浮动组件（不占布局），演示卡保持“留白 + 舞台”的清爽样子；
     * 一旦 Live2D 起不来，就把替身放进 demo-card 的占位槽里，信息不丢、界面不空。
     */
    buildInlinePet() {
      const pict = el('div.cw-ipet',
        el('div.cw-ipet-body',
          el('p.cw-ipet-line', 'hiyori 模型文件已就位，正在尝试渲染。'),
          el('p.cw-ipet-sub', '桌宠：拖动移动 · 戳一下 · 双击打开设置 · 可以放在屏幕任意角落'),
        ),
        el('button.chip.cw-ipet-btn', { type: 'button' }, '重试加载'),
      );
      pict.querySelector('.cw-ipet-btn').addEventListener('click', () => {
        if (this.pet) this.pet.stage.retry();
      });
      return pict;
    },

    buildDemo() {
      const tpl = this.current;
      const opt = CW.menus.option(tpl.option);

      this.stageTitle = el('h2.cw-stage-title', opt ? opt.label : '');
      this.stageSub = el('p.cw-stage-sub', opt ? opt.desc : '');
      this.stageCrumbs = el('div.cw-crumbs');

      this.panelBody = el('div.cw-panel-body');
      this.stagePlaceholder = el('div.cw-placeholder');

      this.demoCard = el('section.demo-card.paper.sticky-note', { 'aria-label': '右侧演示区' },
        el('div.demo-head',
          this.stageCrumbs,
          el('div.demo-head-main', this.stageTitle, this.stageSub),
          el('div.demo-head-side', el('span.cw-status-pill', el('i.cw-pet-dot'), ' 演示 · 无玩法')),
          el('span.tape', { 'aria-hidden': 'true' }),
        ),
        el('div.cw-demo-stage-wrap',
          el('div.cw-demo-bg', { 'aria-hidden': 'true' }),
          el('div.cw-placeholder-slot'),
          el('div.cw-inline-pet-slot'),
        ),
      );
      this.demoCard.querySelector('.cw-placeholder-slot').append(this.stagePlaceholder);
      // 演示卡在底层，桌宠层叠在上面（指针事件穿透，仅桌宠自身接收）
      this.content.insertBefore(this.demoCard, this.petLayer);
      this.renderView(false);
    },

    renderView(animated) {
      const cur = this.current;
      const menu = CW.menus.menu(cur.menu);
      const opt = CW.menus.option(cur.option) || (menu && menu.options[0]);
      if (!menu || !opt) return;

      // 侧栏态
      $$('.sidebar-item', this.sidebarList).forEach((it) => {
        it.classList.toggle('is-active', it.dataset.menu === cur.menu);
      });
      $$('.sub-opt', this.sidebarList).forEach((b) => {
        const on = b.dataset.option === cur.option;
        b.classList.toggle('is-current', on);
        b.setAttribute('aria-current', on ? 'page' : 'false');
      });
      if (!this.openMenu) this.openMenu = cur.menu;
      this.toggleMenu(cur.menu);

      // 标题
      this.stageCrumbs.innerHTML = '';
      this.stageCrumbs.append(
        el('span.crumb-root', menu.label),
        el('span.crumb-sep', { 'aria-hidden': 'true' }, '›'),
        el('span.crumb-leaf', opt.label),
      );
      this.stageTitle.textContent = opt.label;
      this.stageSub.textContent = (opt.en ? opt.en + ' · ' : '') + (opt.desc || '');

      // 占位视图：说明这是 UI，不放玩法
      const ph = menu.placeholder || {};
      const target = opt.id === menu.options[0].id ? ph : { ...ph, title: opt.label, sub: opt.desc };
      const notes = opt.id === menu.options[0].id
        ? (ph.notes || [])
        : [`「${menu.label} · ${opt.label}」的界面尚未接入。`, '当前版本只展示动态 UI 骨架。'];

      this.stagePlaceholder.innerHTML = '';
      this.stagePlaceholder.append(
        el('div.ph-badge', { html: CW.icons('card') }),
        el('h3.ph-title', target.title || opt.label),
        el('p.ph-sub', target.sub || ''),
        el('div.ph-mode-row',
          (menu.options || []).map((o) =>
            el('button.ph-mode', {
              type: 'button',
              class: o.id === opt.id ? 'is-on' : '',
              'data-goto': o.id,
            }, el('span.ph-mode-ico', { html: CW.icons(o.icon) }), o.label),
          ),
        ),
        el('ul.ph-notes', notes.map((n) => el('li', n))),
      );
      if (target.tag) this.stagePlaceholder.append(el('span.ph-tag', target.tag));
      this.rebindPlaceholder();

      if (animated) {
        // 重启动画：在同一个 tick 内移除/加回动画类，某些内核会把动画停在首帧；
        // 最稳的做法是换一个全新节点，让动画从第一帧正常播放。
        const bounce = (node) => {
          if (!node || !node.parentNode) return node;
          const fresh = node.cloneNode(true);
          fresh.classList.remove('pop');
          node.parentNode.replaceChild(fresh, node);
          void fresh.offsetWidth;
          fresh.classList.add('pop');
          return fresh;
        };
        this.stageTitle = bounce(this.stageTitle);
        this.stagePlaceholder = bounce(this.stagePlaceholder);
        this.rebindPlaceholder();
      }
    },

    /** 占位卡里的模式按钮（节点可能被替换过，每次重建后重新绑定） */
    rebindPlaceholder() {
      this.stagePlaceholder.querySelectorAll('.ph-mode').forEach((b) => {
        if (b.dataset.bound) return;
        b.dataset.bound = '1';
        b.addEventListener('click', () => this.selectOption(b.dataset.goto));
      });
    },

    /* ---------------- 桌宠挂载 ---------------- */

    mountPet() {
      if (this.pet) return;
      this.pet = new CW.Pet();
      this.pet.attachTo(this.petLayer);
      const slot = this.demoCard.querySelector('.cw-inline-pet-slot');
      let inlinePet = null;
      const syncInline = () => {
        const failed = this.pet.stage.mode === 'fallback';
        if (failed && !inlinePet) {
          inlinePet = this.buildInlinePet();
          slot.append(inlinePet);
          this.demoCard.classList.add('has-inline-pet');
        } else if (!failed && inlinePet) {
          inlinePet.remove();
          inlinePet = null;
          this.demoCard.classList.remove('has-inline-pet');
        }
      };
      this.pet.onStageChange = syncInline;
      // 稍等主菜单入场动画，再让桌宠登场并开始加载模型
      setTimeout(() => { if (this.pet) this.pet.activate(); }, 520);
    },

    sayHello() {
      if (!this.pet) return;
      setTimeout(() => this.pet.say(pick(['欢迎来到 Cae\'sWorld', '每个人都能做卡牌', '今天想做点什么？'])), 1400);
    },
  };

  // 暴露给调试
  CW.App = App;

  document.addEventListener('DOMContentLoaded', () => App.boot());
})((window.CW = window.CW || {}));
