// console-mirror: 把用户可见的报错类反馈同步一份到 DevTools 控制台。
// 提示卡（toast）与错误面板只在屏幕上停留很短时间，控制台副本让维护者
// 在用户反馈后仍能回查失败原因；编辑器 flashHint 与 Launcher 错误面板
// 共用本模块，输出前缀与级别语义保持一致。default/success 不镜像，
// 控制台只保留报错信号，避免把开发者控制台刷成操作流水账。
export function createUtilsModule(options) {
  'use strict';
  const config = options || {};
  const prefix = typeof config.prefix === 'string' ? config.prefix : '';
  const getConsole = typeof config.getConsole === 'function' ? config.getConsole : () => console;
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const dedupeWindowMs = Number.isFinite(config.dedupeWindowMs) ? config.dedupeWindowMs : 1000;

  // type → console 级别：warning / invalid 都属于用户可见的操作反馈而非
  // 运行时缺陷，统一镜像为 warn（DevTools 黄色，不占用 error 通道——
  // e2e 与维护者约定 error = 意外缺陷）；info → info；其余类型不镜像。
  function feedbackConsoleLevel(type) {
    if (type === 'warning' || type === 'invalid') return 'warn';
    if (type === 'info') return 'info';
    return null;
  }

  // 拖拽连发 / rAF 循环里同一提示会反复触发：滚动窗口内同文案只镜像一次，
  // 持续刷屏期间保持抑制；键空间有界，长会话不无限增长。
  const lastMirroredAt = new Map();
  function isRecentDuplicate(level, message) {
    if (!(dedupeWindowMs > 0)) return false;
    const key = `${level}|${message}`;
    const previous = lastMirroredAt.get(key);
    const current = now();
    if (previous !== undefined && current - previous < dedupeWindowMs) {
      lastMirroredAt.set(key, current);
      return true;
    }
    if (lastMirroredAt.size >= 200) lastMirroredAt.clear();
    lastMirroredAt.set(key, current);
    return false;
  }

  // message 为提示文案；options.error / options.detail（如原始 Error 或
  // 结构化诊断对象）会作为第二个控制台参数原样透传，保住堆栈与上下文。
  function mirrorFeedback(message, type, mirrorOptions = {}) {
    const level = feedbackConsoleLevel(type);
    if (!level) return false;
    const text = String(message ?? '').trim();
    if (!text) return false;
    if (isRecentDuplicate(level, text)) return false;
    const target = getConsole();
    const log = target?.[level];
    if (typeof log !== 'function') return false;
    const detail = mirrorOptions.error ?? mirrorOptions.detail ?? null;
    const line = prefix ? `${prefix} ${text}` : text;
    if (detail === null) log.call(target, line);
    else log.call(target, line, detail);
    return true;
  }

  return Object.freeze({ feedbackConsoleLevel, mirrorFeedback });
}
