import { freezeFacade } from './editor-facade-utils.js';
import { getMaweState } from './editor-state.js';
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';

const container = document.getElementById('cues-container');


  // 可被「加载媒体」替换为新 <video>/<audio>

// 工程内波形是可直接使用的缓存；加载关联媒体时不要因为媒体签名不同而覆盖它。
// 媒体生成的波形则不属于工程缓存，切换媒体时仍应重新分析。

const MEDIA_FILE_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|wav|mp3|m4a|aac|ogg|flac|opus)$/i;

function isMediaFile(file) {
  return Boolean(file) && (file.type.startsWith('video/') || file.type.startsWith('audio/') || MEDIA_FILE_RE.test(file.name));
}

function isReapeaksFile(file) {
  // .quapeaks 是 MAW 自有容器（改名自 reapeaks 内核）：浏览器直读必须同样认它，
  // 否则服务端读得到、用户在浏览器里打开却报「不支持的文件」。
  return Boolean(file) && /\.(?:reapeaks|quapeaks)$/i.test(file.name);
}

export const MaweCoreState = freezeFacade({
    container,
    get player() { getMaweState().runtime.player ??= /** @type {HTMLMediaElement|null} */ (document.getElementById('player')); return getMaweState().runtime.player; },
    set player(v) { getMaweState().runtime.player = v; },
    get waveformEditor() { return getMaweState().runtime.waveformEditor; },
    set waveformEditor(v) { getMaweState().runtime.waveformEditor = v; },
    get playbackFrameId() { return getMaweState().runtime.playbackFrameId; },
    set playbackFrameId(v) { getMaweState().runtime.playbackFrameId = v; },
    get playbackFramePlayer() { return getMaweState().runtime.playbackFramePlayer; },
    set playbackFramePlayer(v) { getMaweState().runtime.playbackFramePlayer = v; },
    get waveformLoadedFromProject() { return getMaweState().runtime.waveformLoadedFromProject; },
    set waveformLoadedFromProject(v) { getMaweState().runtime.waveformLoadedFromProject = v; },
    MEDIA_FILE_RE,
    isMediaFile,
    isReapeaksFile
  }, ["player", "waveformEditor", "playbackFrameId", "playbackFramePlayer", "waveformLoadedFromProject"]);
window.MaweCoreState = MaweCoreState;
