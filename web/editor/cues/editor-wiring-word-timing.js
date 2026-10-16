

// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';
import { MaweWordTiming } from "./editor-word-timing.js";
MaweWordTiming.bind();
// 项目设置 → 字幕轨道的「显示字词时间码」镜像开关。
document.getElementById('project-word-timing-toggle')?.addEventListener('change', (event) => {
  MaweWordTiming.setEnabled(event.target.checked);
});
