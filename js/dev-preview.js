/*!
 * Cae'sWorld — dev-preview.js（仅调试用，不参与正式入口）
 * index.html?preview=loading&freeze=1  → 冻结载入页（不自动跳转），便于静态核对视觉
 * 正式入口不引用本文件。
 */
(function () {
  const q = new URLSearchParams(location.search);
  if (q.get('preview') !== 'loading') return;
  const freeze = q.get('freeze') !== '0';
  if (freeze) {
    // 阻断跳转：让 boot 的超时与阶段推进都停在载入页
    Object.defineProperty(window, '__cwFreeze', { value: true });
  }
})();

/* ?debug=title：把桌宠状态写进页面标题，便于在受限环境里远程观察 */
(function () {
  const q = new URLSearchParams(location.search);
  if (q.get('debug') !== 'title') return;
  let logs = [];
  const push = (s) => { logs.push(s); if (logs.length > 6) logs.shift(); document.title = 'DBG ' + logs.join(' | '); };
  window.__cwLog = push;
  document.addEventListener('DOMContentLoaded', () => {
    const wait = setInterval(() => {
      if (!window.CW || !window.CW.App || !window.CW.App.pet) return;
      clearInterval(wait);
      window.CW.App.pet.onStageChange = (st) => push(st.mode + ':' + String(st.statusText).slice(0, 60));
      push('hooked');
    }, 200);
  });
  window.addEventListener('error', (e) => push('ERR ' + String(e.message).slice(0, 80)));
  window.addEventListener('unhandledrejection', (e) => push('REJ ' + String(e.reason && e.reason.message || e.reason).slice(0, 80)));
})();
