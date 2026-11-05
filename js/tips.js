/*!
 * Cae'sWorld — tips.js
 * “你知道吗”字符库：从 data/tips.txt 抽取（每行一条）。
 * - 优先 fetch 读取，换行兼容 \r\n；空行跳过；同一会话里不连续重复同一条。
 * - fetch 失败（file:// 直开、离线、404）时回退到内置副本 + 之前缓存的文本，保证加载页永远有字。
 */
(function (CW) {
  'use strict';

  const TIPS_FILE = 'data/tips.txt'; // 经 CW.route 转为根相对
  const CACHE_KEY = 'tips.cache';
  const FETCH_TIMEOUT = 4000;

  const FALLBACK = [
    '感谢游玩我们的项目~',
    '据说这里的文字会发生变化哦',
    '每一张卡，都可以是某个人亲手写下的故事。',
  ];

  let pool = FALLBACK.slice();
  let lastShown = null;
  let status = 'fallback'; // fallback | loaded | cached

  function parse(text) {
    return String(text)
      .replace(/^\uFEFF/, '')
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  }

  /** 带超时的 fetch */
  function fetchWithTimeout(url, ms) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), ms);
    return fetch(url, { cache: 'no-cache', signal: ctrl ? ctrl.signal : undefined })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .finally(() => clearTimeout(timer));
  }

  /** 随机抽取一条：尽量不与上一条相同（有多条时） */
  function randomTip() {
    if (!pool.length) return '感谢游玩我们的项目~';
    if (pool.length === 1) return pool[0];
    let t = pool[Math.floor(Math.random() * pool.length)];
    let guard = 0;
    while (t === lastShown && guard++ < 12) t = pool[Math.floor(Math.random() * pool.length)];
    lastShown = t;
    return t;
  }

  async function load() {
    // 1) 先用缓存，保证“秒出字”
    const cached = CW.store.get(CACHE_KEY, null);
    if (Array.isArray(cached) && cached.length) pool = cached;

    // 2) 再尝试拉取最新文件
    try {
      const lines = parse(await fetchWithTimeout(CW.route(TIPS_FILE), FETCH_TIMEOUT));
      if (lines.length) {
        pool = lines;
        status = 'loaded';
        CW.store.set(CACHE_KEY, lines);
        const src = document.querySelector('meta[name="cw-tips-source"]');
        if (src) src.setAttribute('content', status);
        return { ok: true, count: pool.length, source: TIPS_FILE };
      }
    } catch (e) {
      status = Array.isArray(cached) && cached.length ? 'cached' : 'fallback';
      console.warn('[tips] 读取 ' + TIPS_FILE + ' 失败，使用备用字符库：', e && e.message);
    }
    return { ok: false, count: pool.length, source: status };
  }

  CW.tips = {
    load,
    randomTip,
    parse,
    get pool() { return pool.slice(); },
    get status() { return status; },
  };
})((window.CW = window.CW || {}));
