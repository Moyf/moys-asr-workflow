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
