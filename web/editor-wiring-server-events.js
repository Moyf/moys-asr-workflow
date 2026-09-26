// === cleanPunctuation ===












// 原地切换工程（打开本地 .mosp / 新建空白 / 导入）会让 DATA 换成一个新工程，
// 但服务器的 /api/waveform 仍描述它自己绑定的旧工程。每次 applyCanonicalProject
// 递增该纪元；在途的延迟加载响应据此作废并终止轮询，旧工程的
// spectral / 波形 / 响度载荷绝不会套到新工程的波形上。




// 重试必须绑定发起时的工程纪元：排期期间原地切换了工程，这次重试就该取消。
// 否则新纪元的调用会原样接受旧工程的服务器载荷。
function scheduleDeferredReapeaksRetry(delayMs, epoch) {
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







