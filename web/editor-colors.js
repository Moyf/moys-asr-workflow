// 调色板：颜色标签、窗口注入的 ASR_EDITOR_PALETTE 与按名取值。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweColors 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweColors(global) {
  'use strict';



  // 标记颜色：5 种基础色，用于给字幕分组着色。
  // 数据模型与表情包同构：head 持完整 color {name, value, start, end}，后续 ref 持 color_ref {name, headIdx}
  // 调色板数值唯一来源于 maw/colors.py（渲染时注入 window.ASR_EDITOR_PALETTE）；
  // 这里只补充编辑器 UI 用的中文标签。
  const COLOR_LABELS = { yellow: '黄', green: '绿', red: '红', purple: '紫', blue: '蓝' };

  // 调色板注入守卫（原 editor.js 加载期校验，随调色板初始化一同迁移）。
  if (!Array.isArray(window.ASR_EDITOR_PALETTE) || !window.ASR_EDITOR_PALETTE.length) {
    throw new Error('调色板未注入：缺少 window.ASR_EDITOR_PALETTE（检查 edit.py / serve.py 渲染管线）');
  }

  const COLOR_PALETTE = window.ASR_EDITOR_PALETTE.map((c) => ({
    name: c.name,
    label: COLOR_LABELS[c.name] || c.name,
    value: c.value,
  }));


  const COLOR_BY_NAME = Object.fromEntries(COLOR_PALETTE.map(c => [c.name, c]));


  function colorValue(name) { return COLOR_BY_NAME[name]?.value || '#777'; }

  global.MaweColors = Object.freeze({
    COLOR_LABELS,
    COLOR_PALETTE,
    COLOR_BY_NAME,
    colorValue
  });
})(typeof window !== 'undefined' ? window : globalThis);
