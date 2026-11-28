const guidesService = {};

export function observeSafeAreaGuidesPlayer(player) {
  return guidesService.observePlayer(player);
}

export function initMaweSafeAreaGuides() {
  if (guidesService.ready) return;

  // === 安全区参考线（播放预览）===
  // Premiere 风格双框：外框 = 视频显示区域四边内缩 5%（动作安全），内框 10%
  // （字幕安全）；左右按画面宽度、上下按画面高度计算，内框四边中点各一条
  // 短刻线。叠层定位在播放器中视频的实际绘制矩形（object-fit: contain 的
  // contain 数学）上，排除播放器适配画幅产生的留黑；横竖屏、缩放、切换媒体
  // 与编辑器全屏都跟随实际画面，没有视频时隐藏。纯视觉参考：层不拦截指针、
  // 触摸与焦点，不写工程、不影响导出 / 烧录 / 实际帧图像。
  // 显隐与几何由本机偏好 safeAreaGuidesEnabled 驱动（全局设置 → 播放预览），
  // 切换立即生效，与 .mosp 工程数据无关。

  const layer = document.createElement('div');
  layer.id = 'safe-area-guides';
  layer.className = 'safe-area-guides';
  layer.hidden = true;
  layer.setAttribute('aria-hidden', 'true');
  const outerRect = document.createElement('div');
  outerRect.className = 'safe-area-rect safe-area-outer';
  const innerRect = document.createElement('div');
  innerRect.className = 'safe-area-rect safe-area-inner';
  layer.append(outerRect, innerRect);
  // 内框四边中点刻线（N/S/E/W）：刻线长度是屏幕像素，不随画幅缩放。
  for (const edge of ['n', 's', 'w', 'e']) {
    const tick = document.createElement('div');
    tick.className = `safe-area-tick safe-area-tick-${edge}`;
    layer.append(tick);
  }
  // 挂到 stage 末尾；z-index（5）低于字幕预览层（10），高于视频与 ASS 暂停
  // 实际帧——普通字幕、ASS 即时预览与叠加实际帧时参考线都可见。
  MaweDom.playerStage?.appendChild(layer);

  // 视频实际绘制矩形（stage 坐标系）；无视频 / 元数据未就绪时返回 null。
  // 视频元素以 object-fit: contain 绘制：绘制矩形 = 元素盒内按素材宽高比
  // 取最小缩放后居中的子矩形。用元素盒而非舞台盒，layout-classic 下元素
  // 高度随画幅收缩（无留黑），wave-right 与全屏下元素盒填满舞台（有留黑）。
  function videoDisplayRect() {
    const stage = MaweDom.playerStage;
    const player = MaweCoreState.player;
    if (!stage || !player || player.tagName !== 'VIDEO') return null;
    const videoWidth = Number(player.videoWidth);
    const videoHeight = Number(player.videoHeight);
    if (!(videoWidth > 0) || !(videoHeight > 0)) return null;
    const elementRect = player.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if (!(elementRect.width > 0) || !(elementRect.height > 0)) return null;
    if (!(stageRect.width > 0) || !(stageRect.height > 0)) return null;
    const scale = Math.min(elementRect.width / videoWidth, elementRect.height / videoHeight);
    const width = videoWidth * scale;
    const height = videoHeight * scale;
    return {
      left: elementRect.left - stageRect.left + (elementRect.width - width) / 2,
      top: elementRect.top - stageRect.top + (elementRect.height - height) / 2,
      width,
      height,
    };
  }

  let lastAppliedKey = '';

  function hide() {
    lastAppliedKey = '';
    if (!layer.hidden) layer.hidden = true;
  }

  function refresh() {
    const rect = MaweSettings.EDITOR_SETTINGS.safeAreaGuidesEnabled === true
      ? videoDisplayRect() : null;
    if (!rect || rect.width < 2 || rect.height < 2) {
      // 关闭、无视频或布局过渡期间矩形塌缩：隐藏并失效缓存，等下一次布局
      // 事件给出稳定矩形（ResizeObserver / fullscreenchange 会再触发）。
      hide();
      return;
    }
    const key = [rect.left, rect.top, rect.width, rect.height]
      .map((value) => value.toFixed(2)).join(',');
    if (key === lastAppliedKey && !layer.hidden) return;
    lastAppliedKey = key;
    layer.hidden = false;
    layer.style.left = `${rect.left.toFixed(2)}px`;
    layer.style.top = `${rect.top.toFixed(2)}px`;
    layer.style.width = `${rect.width.toFixed(2)}px`;
    layer.style.height = `${rect.height.toFixed(2)}px`;
  }

  // rAF 合并同一帧内的多次布局事件；100ms 有界跟进兜底过渡期间的连续事件，
  // 与 ASS 预览刷新（editor-ass-preview-refresh.js）同一策略。
  let refreshFrame = 0;
  let refreshTimer = 0;
  function scheduleRefresh() {
    if (typeof requestAnimationFrame === 'function') {
      if (!refreshFrame) {
        refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; refresh(); });
      }
    } else {
      refresh();
    }
    if (!refreshTimer) {
      refreshTimer = window.setTimeout(() => { refreshTimer = 0; refresh(); }, 100);
    }
  }

  // 媒体加载会替换播放器元素（editor-media-load.js replaceChild），经
  // MaweMediaPlayback.bindPlayerEvents → observePlayer 重新挂监听与观察，
  // 与 ASS 预览刷新同一接入点。
  let observedPlayer = null;
  function observePlayer(player) {
    if (observedPlayer === player) return;
    if (observedPlayer) {
      resizeObserver?.unobserve(observedPlayer);
      observedPlayer.removeEventListener('loadedmetadata', scheduleRefresh);
      observedPlayer.removeEventListener('emptied', scheduleRefresh);
    }
    observedPlayer = player || null;
    if (!observedPlayer) return;
    observedPlayer.addEventListener('loadedmetadata', scheduleRefresh);
    observedPlayer.addEventListener('emptied', scheduleRefresh);
    resizeObserver?.observe(observedPlayer);
    scheduleRefresh();
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRefresh) : null;
  // 尺寸来源：舞台盒与视频元素盒（layout-classic 二者随内容伸缩，wave-right
  // 与全屏下视频填满舞台）；window resize 与全屏切换覆盖布局过渡。
  if (MaweDom.playerStage) resizeObserver?.observe(MaweDom.playerStage);
  window.addEventListener('resize', scheduleRefresh);
  document.addEventListener('fullscreenchange', scheduleRefresh);

  // 开关：切换立即生效并写入本机偏好；启动时的勾选恢复在
  // editor-wiring-settings-init.js 按同一设置完成，不经此监听。
  MaweDom.safeAreaGuidesToggle?.addEventListener('change', () => {
    MaweSettings.updateEditorSettings({ safeAreaGuidesEnabled: MaweDom.safeAreaGuidesToggle.checked });
    scheduleRefresh();
  });

  guidesService.ready = true;
  guidesService.refresh = refresh;
  guidesService.observePlayer = observePlayer;
  observePlayer(MaweCoreState.player);
  refresh();
  window.MaweSafeAreaGuides = Object.freeze({
    refresh,
    scheduleRefresh,
    observePlayer,
  });
}
