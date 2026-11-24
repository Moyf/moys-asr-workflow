// platform: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { getNavigator } = dependencies;


  // macOS 上用 ⌘（event.metaKey）替代 Ctrl；Win/Linux 仍是 Ctrl。
  // server-align/index.html 的 ALT_KEY_LABEL 复制了本判定（独立页面不引共享
  // 模块）；改正则或回退时需两侧同步。
  function isMacPlatform(nav) {
    const n = nav || getNavigator();
    if (!n) return false;
    const p = String(n.platform || n.userAgentData?.platform || '');
    return /Mac|iPhone|iPad/.test(p);
  }


  function configuredEnterAction(event, splitKey) {
    if (event?.key !== 'Enter') return null;
    const mod = event.ctrlKey || event.metaKey;
    if (event.shiftKey && mod) return 'split';
    if (event.shiftKey) return 'newline';
    if (mod) return splitKey === 'ctrl-enter' ? 'split' : 'save';
    return splitKey === 'enter' ? 'split' : 'save';
  }

  return Object.freeze({ configuredEnterAction, isMacPlatform });
}
