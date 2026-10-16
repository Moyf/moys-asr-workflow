

// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';

import { MaweWaveformInit } from "../media/editor-waveform-init.js";
import { MaweServerConnection } from "./editor-server-connection.js";function scheduleDeferredReapeaksRetry(delayMs, epoch) {
  window.setTimeout(() => {
    if (epoch === MaweWaveformInit.deferredReapeaksEpoch) void MaweWaveformInit.loadDeferredReapeaks();
  }, delayMs);
}

// Server-editor 页面可能在本地服务退出后继续留在浏览器中。定期复用
// startup-status 这个轻量 JSON 接口：断联时保留页面里的编辑内容，并显示
// 持久横幅；服务恢复后自动清掉横幅，不刷新页面，避免覆盖未保存的改动。


















document.addEventListener('visibilitychange', () => {
  if (!document.hidden) MaweServerConnection.scheduleServerConnectionCheck(0);
});
window.addEventListener('online', () => MaweServerConnection.scheduleServerConnectionCheck(0));
