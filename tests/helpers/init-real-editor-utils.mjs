// Node ESM 直连测试的门面初始化：真实模块图里 initEditorUtils 只在
// 这里跑一次，填充 shared/editor-utils.js 的模块级 AsrEditorUtils 常量，
// 使 ESM import 的领域模块读到已填充门面（与生产 bundle 同语义）。
// 幂等：同进程多次调用只初始化一次。
import { initEditorHost } from '../../web/editor/boot/editor-host.js';
import { AsrEditorUtils, initEditorUtils } from '../../web/shared/editor-utils.js';

let done = false;

export function initRealEditorUtils() {
  if (done) return AsrEditorUtils;
  // Node 无 window：测试里 classic 语义 window === globalThis。
  if (typeof window === 'undefined') globalThis.window = globalThis;
  initEditorHost();
  initEditorUtils();
  done = true;
  return AsrEditorUtils;
}
