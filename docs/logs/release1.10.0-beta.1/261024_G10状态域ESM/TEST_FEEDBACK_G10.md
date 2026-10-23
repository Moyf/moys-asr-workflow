# G10 状态域 ESM 转换进度账本

基线：esm/g10-state-io（基于 #300 后 main），PR 目标：单个上游 PR。

## 已完成

| 文件 | 形态 | 验证 |
|---|---|---|
| builder validateInitModule | 允许纯函数具名导出 + 惰性 const | node 拒绝矩阵 + 正例 |
| state/core-state | init + isMediaFile/isReapeaksFile 提升导出 | node |
| state/cue-panel-state | init + resetCuePanelEditState 导出 | node |
| state/project-settings | init + syncControls 导出（ass-manager 门面调用改经 MaweAssManagerWiring）| node |
| state/state | register/resolve 退役，createEditorState 具名导出 | state 12 过 |
| state/commands | 同上，createEditorCommands 具名导出 | commands 7 过 |
| state/view-updates | 同上，createViewUpdates 具名导出 | 同 commands 套件 |
| state/settings | init 包 IIFE + 26 个纯函数转发导出 | node 105 |
| state/history | init + 12 转发导出 | node |
| state/multi-subtitle-core | init + 41 转发导出 | node |
| io/multi-import 等 5 文件 | init 包 IIFE + 函数转发导出（属性型成员不导出） | node 182 + Python 53 |

## 关键决定

1. **门面保留为 classic 出接口**（#300 已声明边界）：67 文件消费 MaweSettings，
   G10 一个 PR 内不可能全改 import；G08 兄弟边用新导出，classic 侧（wiring/media）
   继续读门面，G16 退役。
2. **属性型门面成员不导出**（getter/setter/DOM 句柄无法函数转发）：
   MaweServerSave.projectFileHandle 等 6 个成员消费方继续走门面。
3. **modules.json 条目按清单位次排序**（test_editor_assets trace 契约要求）。
4. 双实例独立性守卫已存在（test_editor_state 77 行），本次直调工厂保留语义。

## 验证记录

- node 182/182（bundle/domains/host/state/commands/waveform/assets/thumbnails/web-build/sticker）
- Python 53/53（editor-assets 清单元组 + trace 位次 + web-build）
- typecheck 过（initMaweState 经局部 any 中转对齐原 resolve 装配语义）
- e2e：i18n-save 15 过；project-async-lifecycle + new-project + open-project-attach 跑中

## 待办

- [ ] e2e 生命周期三 spec 结果确认
- [ ] PR 描述 + 上游提交（等 #300 合入）

## G08 两批（261024 续）

| 批次 | 分支 | 内容 | 验证 |
|---|---|---|---|
| G08-a | esm/g08-cues-a | 6 个小 classic → init+导出；8 个已 init 文件补转发导出；9 对边换 import；helper 垫片升级 | node 182、Python 53、typecheck、split-style-markers 16 |
| G08-b | esm/g08-cues-b（堆叠 a） | 13 个枢纽 classic → init+导出（260 具名导出）；27 文件兄弟边全量 import；word-timing 撞名 import 修剪 | node 182、Python 53、typecheck、e2e 14+ |

关键实现细节：
- vm 测试垫片：import 符号 → 调用时经 window 门面（门面名从兄弟转发行回读，prefix 正则需转义）；
  overlay-track 纯模块不垫片（桩环境按 classic 语义直供同名全局，如 test_sticker_placement 的 getOverlayTrack mock）。
- 属性型门面成员（getter/setter、DOM 句柄）不导出：MaweServerSave.projectFileHandle 等 6 个。
- 撞名处理：word-timing 顶层 import clearSelection 与本地 IIFE 内同名函数、导出段三方撞——
  删除未使用 import 绑定（本地函数语义不变）。
- 注册表残留：cues 域 27 文件零 MAWE.register；唯一残留是 overlay-track 的 e2e 数据层注册（G06 约定）。

### G08-b 缝合修复记录（e2e 驱动，两轮）

| 轮 | 缺口 | 修复 |
|---|---|---|
| 1 | MULTI_SUBTITLE_UTILS（boot/editor.js const 别名）断链：split-core 32 + binding-align 2 | 改 window.AsrEditorUtils（AST 扫描器清零） |
| 1 | isPlaybackActive（wiring-keyboard-guards 顶层函数）：cue-events 1 处 | 走 MaweKeyboardGuards 门面 |
| 2 | multiSubtitleSplitDuplicate（dom-panels DOM 常量，不在 MaweDom）：split-core 1 处 | 函数体内 getElementById 直查 |

教训：G07 的 legacy 自由引用扫描器只查了 window 门面与顶层函数，
漏了 **const 别名绑定** 与 **classic DOM 常量** 两类；G08 补齐扫描维度
（scan-aliases.mjs），全量清零后 e2e 16/16。

### 缝合修复 3（overlay-track e2e 驱动）：io 域别名断链

project-load(5) + multi-import(6) 对 MULTI_SUBTITLE_UTILS 的
裸引用在 G10 转换时漏扫（扫描器当时只覆盖 cues 27 文件）。
症状：导入工程后 overlay_track 归一化中断 → 叠加行不渲染
（overlay-track 27 spec 全红）。改 window.AsrEditorUtils。

**扫描范围教训**：legacy 自由引用扫描必须覆盖所有已转换域
（cues + io + state），不是只扫当前批次。

最终 e2e：overlay-track 27/27、split-style-markers 16/16、
project-async-lifecycle + sticker-preview-lifecycle 17/17、
editor-i18n-save 15/16（140:1 = main 既有 #290 文案缺口）。
