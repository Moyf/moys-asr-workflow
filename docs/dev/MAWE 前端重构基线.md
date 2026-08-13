---
title: MAWE 前端重构基线
created_at: 2026-08-13
updated_at: 2026-08-13
status: captured
---

# MAWE 前端重构基线

本文件记录 Phase 0 的重构前快照和 Phase 1 的装配合同。它是长期重构的对照点；后续阶段不能只描述“代码已经拆开”，还要说明相对本基线改变了哪些边界和行为。

## 快照范围

- 分支：`refactor/mawe-p0-p1`
- 基线日期：2026-08-13
- 主要流程：`server-editor/serve.py` 生成页面；`edit.py --blank` 生成便携页面
- 行为原则：不改变工程 schema、DOM 合同、快捷键、导出内容和波形交互

### Phase 0 开始前的源码规模

| 文件 | 行数 | 说明 |
| --- | ---: | --- |
| `web/editor.js` | 7288 | 迁移前的启动、状态、编辑命令、播放、预览、I/O 和快捷键入口 |
| `web/waveform.js` | 3635 | 波形运行时、Canvas、虚拟化、工作区和拖拽交互 |
| `web/editor-utils.js` | 962 | 可在 Node 中测试的纯逻辑和历史栈 |
| `web/editor-i18n.js` | 665 | 翻译、动态属性和对话框适配 |
| `web/editor-onboarding.js` | 621 | 新手引导及 `MAWE_EDITOR_BRIDGE` 消费者 |
| `web/editor-template.html` | 876 | 页面 DOM 和内联资源 token |

测试规模基线为 15 个 Playwright E2E spec、约 3418 行 E2E JavaScript，以及 24 个 Python 测试文件。测试数字用于识别覆盖变化，不代表所有交互都已自动化。

## 资源装配合同

Phase 1 起，编辑器脚本顺序唯一记录在 `web/editor-scripts.txt`：

1. `editor-runtime.js`：建立 `window.MAWE` 模块工厂注册入口。
2. `editor-utils.js`：建立 `window.AsrEditorUtils`，并注册 `editor-utils`。
3. `editor-i18n.js`：建立 `window.MAWE_I18N`，并注册 `i18n`。
4. `waveform.js`：建立 `window.AsrWaveform`，并注册 `waveform`。
5. `editor.js`：启动主编辑器，建立 `window.MAWE_EDITOR_BRIDGE`，并注册 `editor-bridge`。
6. `editor-onboarding.js`：建立 `window.MAWE_ONBOARDING`，并注册 `onboarding`。

`edit.py`、Server 页面和 Tauri 构建都读取同一份清单；模板底部只保留 `__EDITOR_SCRIPTS_JS__` 一个脚本 token。旧的兼容出口继续存在，注册表不持有工程数据或控制器实例。

## 状态与依赖清单

### 工程和运行状态

| 状态类别 | 当前所有者 | 典型字段 | 后续迁移方向 |
| --- | --- | --- | --- |
| 工程真源 | `editor.js` 的 `DATA` | `segments`、`media`、`preview`、`workspace` | Phase 4 的 Store / commands |
| 编辑运行态 | `editor.js` 顶层变量 | `selectedIdxs`、`currentCuePanelIdx`、`editingState`、`lastActive` | Phase 4 的运行状态 Store |
| 媒体与波形运行态 | `editor.js` + `WaveformEditor` | `player`、`waveformEditor`、播放帧、拖拽会话 | Phase 3 adapter；保留波形内部局部状态 |
| 用户偏好 | `editor.js` / `WaveformEditor` | `EDITOR_SETTINGS`、波形设置、主题 | Phase 3 settings service |
| 历史与脏标记 | `editor.js` | `editorHistory`、`gapRemoveDirty`、项目 dirty 判断 | Phase 4 命令结果 |

### 兼容出口和消费者

| 出口 | 提供者 | 主要消费者 | 本阶段处理 |
| --- | --- | --- | --- |
| `window.AsrEditorUtils` | `editor-utils.js` | `editor.js`、测试 | 保留，增加工厂注册 |
| `window.MAWE_I18N` | `editor-i18n.js` | `editor.js`、onboarding | 保留，增加工厂注册 |
| `window.AsrWaveform` | `waveform.js` | `editor.js`、E2E | 保留，增加工厂注册 |
| `window.MAWE_EDITOR_BRIDGE` | `editor.js` | `editor-onboarding.js` | 保留，增加工厂注册 |
| `window.MAWE_ONBOARDING` | `editor-onboarding.js` | `editor.js` | 保留，增加工厂注册 |

`window.MAWE` 只提供 `register`、`has`、`list` 和 `resolve`。后续新模块应优先注册工厂；不得把 `DATA`、选择集合或 DOM 节点放进注册表。

## 关键 DOM 合同

当前功能控制器共享以下 DOM 区域。Phase 1 不改 ID、关键 class 或 `data-*` 属性；后续如果需要结构变更，必须单独列出迁移和 E2E 影响：

| 区域 | 代表节点 | 使用者 |
| --- | --- | --- |
| 媒体与预览 | `#player`、`.player-wrap`、`.player-stage`、`#overlay` | 播放、预览、波形 Seek |
| 字幕列表 | `#cues-container`、`#cues-empty`、`.cue[data-idx]` | 选择、搜索、原地编辑 |
| 当前字幕 | `#current-cue-panel`、`#cue-panel-text` | 面板编辑、拆分、导航 |
| 波形 | `#waveform`、`#waveform-scroll`、`.waveform-cue-block` | `WaveformEditor`、拖拽、虚拟化 |
| 工具和弹窗 | `#ctxmenu`、`#help-panel`、`#gap-remove-panel`、`#auto-merge-panel` | 命令入口、辅助工具 |

## 验证基线

每个 Phase 0–1 提交至少运行：

```powershell
node --check web\editor-runtime.js
node --check web\editor-utils.js
node --check web\editor-i18n.js
node --check web\waveform.js
node --check web\editor.js
node --check web\editor-onboarding.js
node --test tests\test_editor_runtime.mjs tests\test_editor_utils.mjs tests\test_waveform_js.mjs
uv run python -m unittest tests.test_editor_assets tests.test_waveform
uv run python edit.py --blank
git diff --check
```

交互验收仍以 Server 编辑器为主；涉及模板或共享脚本装配时，至少打开生成后的 `blank-editor.html` 做一次启动 smoke。长媒体滚动和连续播放的性能样本应在拥有固定工程夹具后补齐；在此之前不能声称已经完成性能门槛验证。

### 2026-08-13 当前批次验证记录

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| 6 个前端脚本 `node --check` | 通过 | 包括新增 `editor-runtime.js` |
| Node 单测 | 101/101 通过 | `editor-runtime`、`editor-utils`、`waveform` |
| Python 定向测试 | 17/17 通过 | 资产契约与波形页面生成 |
| Playwright 几何回归 | 7/7 通过 | Server 与便携 HTML 均覆盖 |
| i18n / onboarding 定向回归 | 7/8 通过 | 1 项既有未翻译文案失败，与本批次装配改动无关 |
| Tauri `cargo check` | 未完成 | 本机无法从 crates.io 获取缺失的 `http-range`；`rustfmt` 已单独检查 `build.rs` |
| Python 全量测试 | 未完成 | 当前解释器缺少 `requests`、`numpy` 等项目依赖；定向测试不受影响 |

## Phase 0–1 出口

- 基线文档、资产清单和模板脚本 token 可审查。
- `edit.py` 和 Tauri 构建使用同一份脚本顺序，重复或缺失资产会在生成时失败。
- 注册表单元测试通过，旧的 `window.*` 兼容出口仍可用。
- Server 页面和便携 HTML 能生成；没有未解析模板 token。
- 没有把 Store、命令层或 React 迁移提前混入本批次。

Phase 2 开始前，更新本文件的实际测试结果和性能证据，并在企划案中记录继续 / 调整 / 暂停决策。
