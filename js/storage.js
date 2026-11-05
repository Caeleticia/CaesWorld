/*!
 * Cae'sWorld — storage.js
 * 极简键值持久化：localStorage 封装 + 内存回退（无痕/隐私模式下不会抛错）。
 * 所有模块共享 window.CW.store。
 */
(function (CW) {
  'use strict';

  const PREFIX = 'caesworld.';
  const memory = new Map();
  let usable = null;

  function probe() {
    if (usable !== null) return usable;
    try {
      const k = PREFIX + '__probe';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      usable = true;
    } catch (_) {
      usable = false;
    }
    return usable;
  }

  const store = {
    get(key, fallback) {
      const k = PREFIX + key;
      try {
        if (probe()) {
          const raw = window.localStorage.getItem(k);
          return raw === null ? fallback : JSON.parse(raw);
        }
      } catch (_) { /* 落到内存 */ }
      return memory.has(k) ? memory.get(k) : fallback;
    },
    set(key, value) {
      const k = PREFIX + key;
      memory.set(k, value);
      try {
        if (probe()) window.localStorage.setItem(k, JSON.stringify(value));
      } catch (_) { /* 配额满等情况忽略，内存副本仍有效 */ }
    },
    remove(key) {
      const k = PREFIX + key;
      memory.delete(k);
      try {
        if (probe()) window.localStorage.removeItem(k);
      } catch (_) { /* ignore */ }
    },
  };

  CW.store = store;
})((window.CW = window.CW || {}));
