// 最小样例 · 模块侧：renderAll 的所有者。
// 对位真实事件：PR #136 第五次 main 同步期间，main 侧把 renderAll
// 从位置参数改为对象参数（{ waveform, preserveCueListScroll, cueListAnchor }）。

/**
 * 渲染选项（对应 main 侧 #sync-5 的签名演进）。
 * @typedef {Object} RenderOptions
 * @property {boolean} [waveform] 是否重绘波形缓存
 * @property {boolean} [preserveCueListScroll] 是否保留字幕列表滚动位置
 */

/**
 * @param {RenderOptions} [options]
 * @returns {void}
 */
function renderAll(options = {}) {
  const { waveform = true, preserveCueListScroll = false } = options || {};
  void waveform;
  void preserveCueListScroll;
}

globalThis.MaweNavPreview = Object.freeze({ renderAll });
