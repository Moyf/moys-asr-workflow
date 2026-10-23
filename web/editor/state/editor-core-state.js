// 核心运行态：容器/播放器/波形实例引用、播放帧句柄与媒体文件类型判定。
// 状态由 MaweState 持有；ESM init 模块：initMaweCoreState 在原清单位次
// 执行启动绑定；媒体类型判定为纯函数具名导出，兄弟模块静态 import；
// window.MaweCoreState 冻结对象保留为尚未迁移消费者的出接口（G16 退役）。

const MEDIA_FILE_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|wav|mp3|m4a|aac|ogg|flac|opus)$/i;

export function isMediaFile(file) {
  return Boolean(file) && (file.type.startsWith('video/') || file.type.startsWith('audio/') || MEDIA_FILE_RE.test(file.name));
}

export function isReapeaksFile(file) {
  // .quapeaks 是 MAW 自有容器（改名自 reapeaks 内核）：浏览器直读必须同样认它，
  // 否则服务端读得到、用户在浏览器里打开却报「不支持的文件」。
  return Boolean(file) && /\.(?:reapeaks|quapeaks)$/i.test(file.name);
}

export function initMaweCoreState() {
  'use strict';

  const container = document.getElementById('cues-container');

  MaweState.runtime.player = document.getElementById('player');

    // 可被「加载媒体」替换为新 <video>/<audio>

  // 工程内波形是可直接使用的缓存；加载关联媒体时不要因为媒体签名不同而覆盖它。
  // 媒体生成的波形则不属于工程缓存，切换媒体时仍应重新分析。

  window.MaweCoreState = Object.freeze({
    container,
    get player() { return MaweState.runtime.player; },
    set player(v) { MaweState.runtime.player = v; },
    get waveformEditor() { return MaweState.runtime.waveformEditor; },
    set waveformEditor(v) { MaweState.runtime.waveformEditor = v; },
    get playbackFrameId() { return MaweState.runtime.playbackFrameId; },
    set playbackFrameId(v) { MaweState.runtime.playbackFrameId = v; },
    get playbackFramePlayer() { return MaweState.runtime.playbackFramePlayer; },
    set playbackFramePlayer(v) { MaweState.runtime.playbackFramePlayer = v; },
    get waveformLoadedFromProject() { return MaweState.runtime.waveformLoadedFromProject; },
    set waveformLoadedFromProject(v) { MaweState.runtime.waveformLoadedFromProject = v; },
    MEDIA_FILE_RE,
    isMediaFile,
    isReapeaksFile
  });
}
