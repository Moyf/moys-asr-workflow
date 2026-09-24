// 服务器连接：健康检查、断联横幅与启动进度轮询。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweServerConnection 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweServerConnection(global) {
  'use strict';



  // Server-editor 页面可能在本地服务退出后继续留在浏览器中。定期复用
  // startup-status 这个轻量 JSON 接口：断联时保留页面里的编辑内容，并显示
  // 持久横幅；服务恢复后自动清掉横幅，不刷新页面，避免覆盖未保存的改动。
  const SERVER_CONNECTION_CHECK_INTERVAL_MS = 2000;


  const SERVER_CONNECTION_REQUEST_TIMEOUT_MS = 1500;


  const SERVER_CONNECTION_FAILURE_THRESHOLD = 2;


  const serverConnectionBanner = document.getElementById('server-connection-banner');


  let serverConnectionCheckTimer = 0;


  let serverConnectionCheckInFlight = false;


  let serverConnectionFailureCount = 0;



  function serverConnectionCheckUrl() {
    return MaweBoot.SERVER_CONFIG?.healthUrl || MaweBoot.SERVER_CONFIG?.startupStatusUrl || '';
  }



  function renderServerConnectionBanner(disconnected) {
    if (serverConnectionBanner) serverConnectionBanner.hidden = !disconnected;
  }



  function scheduleServerConnectionCheck(delayMs = SERVER_CONNECTION_CHECK_INTERVAL_MS) {
    if (!serverConnectionCheckUrl()) return;
    if (serverConnectionCheckTimer) window.clearTimeout(serverConnectionCheckTimer);
    serverConnectionCheckTimer = window.setTimeout(() => {
      serverConnectionCheckTimer = 0;
      void checkServerConnection();
    }, Math.max(0, delayMs));
  }



  async function checkServerConnection() {
    const url = serverConnectionCheckUrl();
    if (!url || serverConnectionCheckInFlight) return;
    serverConnectionCheckInFlight = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SERVER_CONNECTION_REQUEST_TIMEOUT_MS);
    let healthy = false;
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      const result = await response.json().catch(() => null);
      healthy = response.ok && result?.ok === true;
    } catch (_error) {
      // A refused/aborted local request is the expected signal that the server disappeared.
    } finally {
      window.clearTimeout(timeout);
      serverConnectionCheckInFlight = false;
    }

    if (healthy) {
      serverConnectionFailureCount = 0;
      renderServerConnectionBanner(false);
    } else {
      serverConnectionFailureCount += 1;
      if (serverConnectionFailureCount >= SERVER_CONNECTION_FAILURE_THRESHOLD) {
        renderServerConnectionBanner(true);
      }
    }
    scheduleServerConnectionCheck();
  }



  function startServerConnectionMonitor() {
    if (!serverConnectionBanner || !serverConnectionCheckUrl()) return;
    renderServerConnectionBanner(false);
    void checkServerConnection();
  }



  const SERVER_STARTUP_LABELS = {
    zh: {
      starting: '正在启动编辑器…',
      reading_project: '正在读取工程…',
      validating_project: '正在校验工程…',
      preparing_media: '正在准备媒体…',
      loading_waveform_cache: '正在读取波形缓存…',
      generating_waveform: '未找到可用缓存，正在生成波形…',
      waveform_ready: '波形已就绪…',
      waveform_unavailable: '波形缓存不可用，继续加载…',
      loading_spectral_cache: '正在读取频谱缓存…',
      loading_reapeaks_waveform: '正在读取 REAPER 波形缓存…',
      loading_loudness_stats: '正在读取响度统计…',
      waveform_skipped: '已跳过波形处理…',
      finalizing: '正在完成工程加载…',
      ready: '工程加载完成',
      error: '工程加载失败',
      preparing: '正在准备工程…',
    },
    en: {
      starting: 'Starting editor…',
      reading_project: 'Reading project…',
      validating_project: 'Validating project…',
      preparing_media: 'Preparing media…',
      loading_waveform_cache: 'Reading waveform cache…',
      generating_waveform: 'No usable cache found; generating waveform…',
      waveform_ready: 'Waveform ready…',
      waveform_unavailable: 'Waveform cache unavailable; continuing…',
      loading_spectral_cache: 'Reading spectral cache…',
      loading_reapeaks_waveform: 'Reading REAPER waveform cache…',
      loading_loudness_stats: 'Reading loudness stats…',
      waveform_skipped: 'Waveform processing skipped…',
      finalizing: 'Finishing project loading…',
      ready: 'Project loaded',
      error: 'Project loading failed',
      preparing: 'Preparing project…',
    },
  };



  function serverStartupLabel(stage) {
    const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
    return SERVER_STARTUP_LABELS[language][stage] || SERVER_STARTUP_LABELS[language].preparing;
  }



  async function loadServerStartup() {
    const url = MaweBoot.SERVER_CONFIG?.startupStatusUrl;
    const status = MaweBoot.SERVER_CONFIG?.startupStatus;
    if (!url || status === 'ready') return;
    if (status === 'error') {
      const detail = MaweBoot.SERVER_CONFIG.startupError || serverStartupLabel('error');
      MaweHint.flashHint(`${serverStartupLabel('error')}：${detail}`, 'warning');
      return;
    }

    const finishLoading = MaweLoadingProgress.beginEditorLoading(
      serverStartupLabel(MaweBoot.SERVER_CONFIG.startupStage),
      MaweBoot.SERVER_CONFIG.startupProgress,
    );
    const poll = async () => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok !== true) {
          throw new Error(result.error || `服务器返回 ${response.status}`);
        }
        if (result.status === 'ready') {
          MaweLoadingProgress.updateEditorLoading(100, serverStartupLabel('ready'));
          finishLoading();
          // 页面中的 DATA、媒体标签和保存能力都由服务端工程一起渲染；
          // 工程准备好后刷新一次即可无竞态地接管完整工程和波形。
          window.location.reload();
          return;
        }
        if (result.status === 'error') {
          finishLoading();
          MaweHint.flashHint(
            `${serverStartupLabel('error')}：${result.error || serverStartupLabel('error')}`,
            'warning',
          );
          return;
        }
        MaweLoadingProgress.updateEditorLoading(result.progress, serverStartupLabel(result.stage));
        window.setTimeout(() => { void poll(); }, 500);
      } catch (_error) {
        window.setTimeout(() => { void poll(); }, 1000);
      }
    };
    await poll();
  }

  global.MaweServerConnection = Object.freeze({
    SERVER_CONNECTION_CHECK_INTERVAL_MS,
    SERVER_CONNECTION_REQUEST_TIMEOUT_MS,
    SERVER_CONNECTION_FAILURE_THRESHOLD,
    serverConnectionBanner,
    get serverConnectionCheckTimer() { return serverConnectionCheckTimer; },
    set serverConnectionCheckTimer(v) { serverConnectionCheckTimer = v; },
    get serverConnectionCheckInFlight() { return serverConnectionCheckInFlight; },
    set serverConnectionCheckInFlight(v) { serverConnectionCheckInFlight = v; },
    get serverConnectionFailureCount() { return serverConnectionFailureCount; },
    set serverConnectionFailureCount(v) { serverConnectionFailureCount = v; },
    serverConnectionCheckUrl,
    renderServerConnectionBanner,
    scheduleServerConnectionCheck,
    checkServerConnection,
    startServerConnectionMonitor,
    SERVER_STARTUP_LABELS,
    serverStartupLabel,
    loadServerStartup
  });
})(typeof window !== 'undefined' ? window : globalThis);
