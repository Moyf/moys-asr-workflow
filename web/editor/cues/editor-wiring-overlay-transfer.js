// 叠加轨接线（启动位）：领域逻辑已全部收入同目录 ESM 纯模块 overlay-track.js
// （轨道查询、主/叠加迁移、颜色与合并、波形新增），消费方静态 import 该模块。
// 本文件保留两件启动动作，仍在原清单位置执行：
//   1. normalizeMultiSubtitleState()：工程加载后的多重字幕状态归一化；
//   2. 向 window.MAWE 注册 overlay-track 命名空间，供 e2e 数据层直调
//      （取代 classic 时代的 overlay 函数转发门面）。
import * as OverlayTrack from './overlay-track.js';

export function initOverlayTransferWiring() {
  'use strict';

  MaweMultiSubtitleCore.normalizeMultiSubtitleState();
  window.MAWE.register('overlay-track', () => OverlayTrack);
}
