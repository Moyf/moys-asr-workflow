# 字幕拖动性能量化研究（5000 条工程）

记录时间：2026-10-07。目的：在动手优化前，量化"几千条字幕拖动卡顿/卡死"的真实热点，
为「受影响集 + 偏移量、视口内渲染、松手批量提交」的方案提供数据基线。

## 方法

- 环境：`server-editor/serve.py --blank`（端口 18777）+ agent-browser Chrome。
- 注入合成工程：N 条字幕（每条 6 个词级 items）、合成波形 payload
  （`i8-minmax-base64`，100 峰/秒，16kHz/div160），波形为 multi 行模式。
- 计时：页面内 `performance.now()`；帧等待用双层 rAF（稳态约 30ms = 2 个 vsync）。
- 拖动手势直接调用 `waveformEditor.beginCueDrag / moveCueDrag / endCueDrag`，
  合成 PointerEvent 结构，与真实手势同路径。

## 数据

### 规模缩放（清空选区）

| 指标 | 1000 条 | 3000 条 | 5000 条 | 复杂度 |
|---|---|---|---|---|
| `renderAll`（waveform none） | 33ms | 147ms | 295ms | O(N) DOM 重建 |
| `renderAll`（含 refreshCueOverlay） | 28ms | 155ms | 306ms | 同上 |
| history `begin`（capture+指纹） | 19ms | 40ms | 70ms | O(N) 序列化 |
| history `commit`（hasChanges+发布） | 6ms | 15ms | 30ms | O(N) 序列化 |
| 指纹字符串体积 | 0.56MB | 1.73MB | 2.92MB | — |
| `selectAll`（Ctrl+A） | 49ms | 516ms | 1302ms | **O(N²)** |
| `clearSelection`（全选后） | 46ms | 480ms | 1395ms | **O(N²)** |
| `refreshCueBlocks`（每帧，可视块） | 0.5ms | 0.4ms | 0.5ms | O(可视块) 已虚拟化 |
| 波形 DOM 内块数 | 48 | 48 | 48 | 已按行虚拟化 |

### 5000 条拖动手势分解

| 阶段 | 单条拖动 | 全选（5000）后拖动 |
|---|---|---|
| `beginCueDrag`（按下） | 17.5ms | 54ms |
| `moveCueDrag`（每次 move） | 1.7ms | 3-5ms |
| 拖动帧（rAF + paint 稳态） | ~30ms（流畅） | ~30ms（流畅） |
| `endCueDrag`（松手 = commit） | 228ms | 1956ms |
| 附加：selectAll 建立选区 | — | 864ms + 巨帧 |
| 附加：clearSelection | — | 1528ms |

### 选区是二次方（卡死根因）

- 单次 `container.querySelector('.cue[data-idx=…]')` 在 5000 行下 ≈ 0.32ms。
- 5000 选中 × 0.32ms ≈ 1.6s，与实测吻合：
  - `renderAll` 在全选状态下 **1805ms**（无选区 295ms）——`editor-cue-panel.js:75-78`
    逐个选中下标 `querySelector` 回填 `.selected`。
  - `selectAll` / `clearSelection` 同模式逐条 `querySelector`
    （`editor-selection.js:90-93, 349`）。
- 框选 2000 条（`addCueSelection` 逐条 `addToSelection`）≈ 340ms
  （`editor-waveform-init.js:119-121`）。

### 松手后的一帧巨 paint（归因未定，遗留问题）

- selectAll 完成后的第一/二帧出现 **2.5s / 1.0s** 的
  `LocalFrameView::RunPaintLifecyclePhase`，把紧随的拖动前几帧拖住
  （实测第 1 帧等待 2940ms，第 2 帧起恢复 ~30ms 稳态）。
- Chrome profiler（136k 事件）：拖动稳态帧内 paint 仅 1-2ms，JS 每帧 ≤6ms；
  巨帧只发生在选区刚建立后。
- 已排除：`.cue` transition（禁用 `transition: none` 后无改善：1422 vs 1607ms）。
- 待查方向：content-visibility 对 5000 行的首次交集/containment 结算、
  style recalc 与 paint 的叠加时机。量级 0.3s~3s 不稳定（受 GC/IO 影响）。

## 结论

1. 「拖动几千条卡死」 = 建立大选区（框选/Ctrl+A/Shift 范围选，O(N²)）+
   全选态下松手提交（renderAll 的 O(selected×N) 回填 + O(N) 全量重建）的叠加；
   拖动过程本身的每帧成本已被现有虚拟化兜住（波形 0.5ms/帧，paint 1-2ms）。
2. 单条拖动在 5000 条下不卡死，但每次松手有 230ms 冻结（renderAll 全量重建），
   外加 history 快照/指纹 ~100ms。
3. 列表 DOM 本身（5 万节点）在 `content-visibility: auto` 下布局成本可忽略
   （强制 layout 探针 0.1ms），无需先做整表虚拟化。

## 修复建议（按收益/成本排序，与「受影响集+偏移量」方案对齐）

1. **选区路径去二次方**（小改动，消灭 1.3s/1.4s/1.8s 三处）：
   `renderAll` 建行时收集 `data-idx → el` 一次遍历，替代逐选中下标
   `querySelector`（editor-cue-panel.js:75-78）；`selectAll`/`clearSelection`
   改为一次 `querySelectorAll` 扫描 + Set 判断（或复用同一索引）；
   `addCueSelection` 批量化 `addToSelection`。
2. **拖动提交补丁化**（用户方案核心）：提交时已知受影响下标
   （`drag.indices ∪ commitIndices` + 联动副字幕），只更新这些行的
   时间/字数/dirty 类与列表顺序，替代全量 `renderAll`；
   波形侧继续走 `refreshCueBlocks`（已是增量）。
3. **拖动中记录受影响集与偏移量、松手批量落账**：与 2 配合，
   `moveCueDrag` 只改内存时间 + 视口内块几何（现状已如此），把
   `markMainSegmentsDirty`/`syncBindingOffsets` 等批量动作全部留到松手。
4. **history 降本**（次要）：`fingerprint` 从全工程 `JSON.stringify`
   改为廉价结构（或 timing command 只比较受影响段）；`begin` 的
   全量 `snapshotTiming`（含 items 克隆）可懒化到首帧实际移动时。
5. **巨帧 paint**：归因未定，单独跟进；若确认与 content-visibility
   首次结算相关，可评估在批量选区操作期间临时收窄列表 DOM 的方案。

## 优化实施结果（2026-10-07）

按建议 1/2/4 实施；建议 3 经实测确认拖动每帧已是增量的
（`moveCueDrag` ~2-5ms、`refreshCueBlocks` 0.5ms、paint 1-2ms），
无需额外改造。全部改动：

- `web/editor/cues/editor-selection.js`：新增 `applyMainSelectionClasses`
  （选中数 > 64 时单次扫描列表行，否则逐行查找）+ 批量入口
  `addManyToSelection` / `addManyToExtensionSelection`；
  `clearSelection`/`selectRange`/`selectAll` 改走统一路径。
- `web/editor/cues/editor-cue-panel.js`：`renderAll` 选中回填改单次扫描；
  新增 `patchCueRows`（受影响行时间/字数/dirty 更新 + 就地顺序修复 +
  面板刷新），多重字幕可见时自动回退 `renderAll`。
- `web/editor/state/editor-view-updates.js`：`invalidate` 支持
  `cueListPatch`。
- `web/editor/media/editor-waveform-init.js`：波形框选走批量选区入口；
  `onCommitEdit` 在主轨/叠加轨且多重字幕不可见时提交 `cueListPatch`。
- `web/editor/media/waveform/cue-drag.js` + `cue-drag-update.js`：
  Shift+拖动换轨时在 drag 上标记 `trackChanged` 并随提交传出，
  让这类改变行结构的提交回退全量重建（e2e overlay-track 用例发现）。
- `web/shared/utils/history.js` + `web/editor/state/editor-history.js`：
  `buildHistoryRecord` 支持 `{ clone: false }`，快照捕获不再二次克隆。

### 5000 条实测对比（同基准脚本）

| 场景 | 优化前 | 优化后 | 说明 |
|---|---|---|---|
| Ctrl+A 全选 | 1302ms | 7-16ms | O(N²) → O(N) |
| 全选后 clearSelection | 1395ms | 11-12ms | 同上 |
| Shift 范围选 2000 条 | 218ms | 11ms | 同上 |
| 波形框选 2000 条 | 340ms | 10.2ms | 批量入口 |
| 全选态 renderAll | 1805ms | 608ms | 剩余为 O(N) 全量重建本身 |
| 单条拖动松手 | 228ms | 27-71ms | 补丁路径，行 DOM 不重建 |
| 全选拖动松手 | 1956ms | 71-107ms | 补丁路径 |
| history begin（按下） | 70ms | 21-53ms | 去掉二次克隆 |
| 选区建立后首帧 | 2.5s+1.0s | 226+118ms | 巨帧随 O(N²) 消除大幅缩小 |

巨帧 paint（建议 5）：优化后首帧成本从 2.5-3s 降到 ~350ms 一次性开销，
随后稳态帧 ~17ms 流畅；剩余成本与 5000 行 `.selected` 单次样式结算相当，
不再单独跟进。

### 验证

- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`：通过。
- `node --test tests/test_editor_utils.mjs tests/test_waveform_js.mjs`：368 通过
  （含新增 `buildHistoryRecord { clone: false }` 用例）。
- `uv run --no-sync python -m unittest discover -s tests -p "test_*.py"`：1833 通过。
- e2e（Playwright/chromium）全量：473 条全部通过。首轮曾发现
  Shift+拖动换轨后叠加行缺失（补丁跳过了行结构重建），已用
  `trackChanged` 标记回退全量路径并复测通过。
- 浏览器实测补丁路径：行 DOM 未重建（哨兵元素存活）、时间/字数/dirty
  文本正确更新、叠加轨拖动补丁生效、跨邻挤压拖动后 DOM 顺序与数据一致、
  撤销恢复时间与列表重建正常。

### 未验证边界

- 多重字幕可见时的拖动提交按门控回退 `renderAll`（行为与优化前一致），
  由 e2e multi-subtitle 套件覆盖，未做长工程人工压测。
- 叠加轨与主轨混排时的顺序修复只验证了叠加轨拖动；主轨拖动按挤压
  语义设计上不会跨行，顺序修复主要是防御性路径。

## 复现实验

在浏览器控制台注入合成工程（N 条字幕、合成波形 payload）与计时脚本，
用 `performance.now()` 与双层 rAF 计时，手势直接调用
`waveformEditor.beginCueDrag / moveCueDrag / endCueDrag`；
服务器启动：`uv run --no-sync python server-editor/serve.py --blank --port 18777`。
