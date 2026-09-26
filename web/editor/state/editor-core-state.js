// 核心运行态：容器/播放器/波形实例引用、播放帧句柄与媒体文件类型判定。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweCoreState 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweCoreState(global) {
  'use strict';



  const container = document.getElementById('cues-container');


  let player = document.getElementById('player');

    // 可被「加载媒体」替换为新 <video>/<audio>
  let waveformEditor = null;


  let playbackFrameId = 0;


  let playbackFramePlayer = null;


  // 工程内波形是可直接使用的缓存；加载关联媒体时不要因为媒体签名不同而覆盖它。
  // 媒体生成的波形则不属于工程缓存，切换媒体时仍应重新分析。
  let waveformLoadedFromProject = false;


  const MEDIA_FILE_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|wav|mp3|m4a|aac|ogg|flac|opus)$/i;


  function isMediaFile(file) {
    return Boolean(file) && (file.type.startsWith('video/') || file.type.startsWith('audio/') || MEDIA_FILE_RE.test(file.name));
  }


  function isReapeaksFile(file) {
    // .quapeaks 是 MAW 自有容器（改名自 reapeaks 内核）：浏览器直读必须同样认它，
    // 否则服务端读得到、用户在浏览器里打开却报「不支持的文件」。
    return Boolean(file) && /\.(?:reapeaks|quapeaks)$/i.test(file.name);
  }

  global.MaweCoreState = Object.freeze({
    container,
    get player() { return player; },
    set player(v) { player = v; },
    get waveformEditor() { return waveformEditor; },
    set waveformEditor(v) { waveformEditor = v; },
    get playbackFrameId() { return playbackFrameId; },
    set playbackFrameId(v) { playbackFrameId = v; },
    get playbackFramePlayer() { return playbackFramePlayer; },
    set playbackFramePlayer(v) { playbackFramePlayer = v; },
    get waveformLoadedFromProject() { return waveformLoadedFromProject; },
    set waveformLoadedFromProject(v) { waveformLoadedFromProject = v; },
    MEDIA_FILE_RE,
    isMediaFile,
    isReapeaksFile
  });
})(typeof window !== 'undefined' ? window : globalThis);
