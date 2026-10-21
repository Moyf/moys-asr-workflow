# 工程音量：维护者反馈与修复记录

基线：PR [285](https://github.com/Moyf/moys-asr-workflow/pull/285)，功能提交 `1751baaa`；本轮在 `codex/pr285-maintainer-feedback` 修复并推送原 PR 分支，保持 Draft，不合并。

反馈来源：[维护者 2026-10-21 的评论](https://github.com/Moyf/moys-asr-workflow/pull/285#issuecomment-6309312778)。原实现与早期验证见[设计与验证](设计与验证.md)，本轮人工验收沿用并更新[核验清单](工程音量.checklist.md)。

## 处理清单

| 条目 | 反馈与决定 | 状态 | 修改与验证 |
| --- | --- | --- | --- |
| 1 | 音量面板改为可移动非模态浮窗，保持打开试听；复用现有浮窗机制，保留测量与增益手势生命周期 | 已修复 | 浮窗新增可选关闭回调；真实拖动、外部播放、关闭、Esc 与缩窗回钳验证通过 |
| 2 | 新建或缺字段的参考响度默认 −14 LUFS；增加 −70～0 LUFS 自定义，保留工程已保存的合法参考值 | 已修复 | 同步归一化、序列化、撤销重做、用户指南及工程契约；−18.5 保存重开及撤销恢复通过 |
| 3 | 常规滑块 −6～+12 dB；底部勾选后扩为 −60～+24；不因收起扩展或加载工程暗中修改增益 | 已修复 | 范围外值自动展开并暂禁收起，回到常规值后可取消；旧增益、键盘端点、自动匹配及序列化测试通过 |
| 4 | 监听音量显示百分比，响应滑块与播放器音量变化；修复被面板挡住的 tooltip | 已修复 | 移除监听 tooltip，监听 volumechange；50% 显示和监听独立性通过 |
| 5 | 左侧重新测量、橙色匹配按钮，重置增益独立靠右；合并说明、测量中黄字、2×2 指标与胶囊数值 | 已修复 | 中英、测量中、窄窗口四张截图已自查；浏览器逐主块实测间距均 ≥8px，黄色 computed style 与两列布局通过 |
| 6 | 修复两个 CI 任务共用的脚本清单断言漏项 | 已修复 | manifest 为 195 项，旧预期 194 项，补上新音量模块后原失败断言通过；远端后续完整工作流仍须核对 |

## CI 事实基线

- [Editor build and contracts](https://github.com/Moyf/moys-asr-workflow/actions/runs/39464484563/job/118772166735)：构建、TypeScript、Node 915 项通过；Python assembly 24 项中 1 项失败，后续浏览器层跳过。
- [Windows preview](https://github.com/Moyf/moys-asr-workflow/actions/runs/39464485285/job/118772168908)：打包契约 34 项通过；Python 2650 项中 1 项失败、17 项跳过，尚未实际成包。
- 两处共同失败为 `test_editor_script_manifest_is_ordered_and_complete`：`tests/test_editor_assets.py` 预期漏掉 `editor/media/editor-audio-processing.js`。修复后须重跑后续层，不能将旧构建或单测通过视为成包通过。

## 验证与提交

以下为修复分支工作区验证；提交后以 Git 历史定位对应源码。原始输出放工作树忽略目录 `.artifacts/checks/<run-id>/`，其中 `result.json` 保存命令、退出码、耗时与 PID。

| 层级 | 命令与范围 | 实际结果 / run-id |
| --- | --- | --- |
| Node 专项 | `node --test tests/test_audio_processing.mjs` | 17/17，`20261021T062529Z-ba88d699`；包含真实 JsonRepair 序列化、撤销、范围与监听事件 |
| 原 CI 失败断言 | `python scripts/run_tests.py tests.test_editor_assets.EditorAssetContractTests.test_editor_script_manifest_is_ordered_and_complete` | 1/1，`20261021T062532Z-518490b8` |
| 音量 Chromium | `node node_modules/playwright/cli.js test --config=tests/config/playwright.config.mjs --project=chromium tests/e2e/audio-processing.spec.mjs` | 最终 4/4，`20261021T063604Z-2123d91c`；收尾无清理错误 |
| 烧录 Chromium | 同上并包含 `tests/e2e/burn-video-jobs.spec.mjs` | 烧录 21/21，`20261021T063119Z-9b9a0e25`；该轮音量有 2 项失败，因此不称整组通过 |
| 静态与文档 | 编辑器 build/check、TypeScript、Ruff、个人路径、文档结构和清单格式 | 通过；文档 0 新断链、0 结构错误 |

浏览器首轮有两项失败：RMS 基线在 analyser 数据窗填满前采样，修订测试等待已知合成正弦进入稳态，保留原 −12 dB 比率断言并增加实际增益检查；另一项测试把浮窗拖到播放按钮上方，改为真实拖至空位后真实点击，未使用强制点击。该轮服务停止还曾超时，重跑前核对本工作树无残留；最终专项收尾正常。

本地全量 Node 在进程生命周期测试处先超时；正常权限复跑为 920 通过、2 失败、1 跳过，失败均因测试未指定 `MAW_E2E_PYTHON` 而触发环境同步，继而造成独立环境依赖缺失。固定两种 Python 环境变量后首次复验仍因 `certifi` 缺失失败，随后按同一锁定清单修复环境，不修改产品或放宽断言。同期 Python 全量 600 秒超时，未取得整组通过证据；环境修复后的主线组合结果见下表。

## 主线组合与验证

修复提交 `89c616a4`，主线同步提交 `8e554793`；后者引入当前 `main 508d2a48`，仅 CHANGELOG 与日志索引冲突，已保留双方内容。此操作不合并 PR、不改 Draft 状态。代码相同的后续验证记录提交不重复运行已通过的功能层。

| 层级 | 组合验证结果 | 证据 run-id |
| --- | --- | --- |
| Chromium：音量、烧录、编辑器装配 | 28/28 通过；包括真实音频、HTTP 测量/保存、三条烧录增益快照及 file/HTTP 装配 | `20261021T064351Z-057e9a9b` |
| Node 全量 | 954 项：952 通过、1 失败、1 跳过；失败是已有 `scroll: wrapper-exit` 超过内部 15 秒期限，不称整组通过 | `20261021T064352Z-b19c05a1` |
| Node 唯一失败点单独复验 | 原断言和时限保持，1/1 通过；单项成功不替代全量结果 | `20261021T064839Z-61bbfcc8` |
| TypeScript / Ruff | 通过 | `20261021T064444Z-3d85749d` / `20261021T064455Z-3de3629d` |
| Editor / Launcher 构建与新鲜度 | 均通过，Editor 67 ESM 工厂、195 源文件 | `20261021T064451Z-295378c0` / `20261021T064455Z-351f8866` |
| 文档与个人路径 | 1315 文件，0 新断链、0 结构错误；本分支个人路径检查通过 | `20261021T064441Z-aa0dc38d` / `20261021T064455Z-801ce2d1` |
| 人工清单源格式 | 通过，生成 HTML 并在真实浏览器打开确认 9 项核对项；未将人工项自动打勾 | `20261021T065007Z-3a642ad6` / `20261021T064703Z-9c0628c0` |
| Python 全量 | 固定解释器和修复依赖后的正常权限串行运行仍达 600 秒上限；未得到整组结果，不记通过 | `20261021T064348Z-52dd0dd1` |
| Python 定向 | `python scripts/run_tests.py tests/test_editor_assets.py tests/test_editor_manifest.py tests/test_audio_loudness.py tests/test_project_io.py tests/test_burn_video_export.py tests/test_packaging_contract.py`：134 项，132 通过、2 跳过、0 失败 | `20261021T065440Z-a6079e52` |

独立复核确认测试预期与 manifest 的 195 项完全同序；主线 ESM host 初始化仍先于浮窗和音量模块，`MaweHost.server.fetch` 接口不变。浮窗新增 `onClose` 为可选项，仅音量面板使用，不改变其他浮窗关闭行为。

## 远端验证与后续主线同步

首次推送 `3ca240ed` 的三个工作流全部成功：Editor 的 Node 954/954、装配契约 25+6、Chromium 58/58；Windows 打包契约 34 项、Python 全量 2693 项（17 跳过）通过，实际构建、exe 冒烟及产物上传成功。预览产物约 57 MB，绑定该提交。

CI 运行期间主线另合入 `43d9546a`（PR 284）。第二次同步只有日志索引冲突，保留双方条目；音量核心、序列化及增益契约无改动。重新验证：Node 音量、编辑工具、脚本顺序/语法与手势 377/377（`20261021T070544Z-345cd0ad`）；Python 装配、清单与工程保存 44 项、2 跳过（`20261021T070545Z-64c1d0b2`）；Chromium 音量、纯文本编辑与 file/HTTP 装配 23/23（`20261021T070548Z-15d467fe`）。TypeScript 和文档检查通过，后者 1316 文件、0 新断链、0 结构错误。前述远端成功仅属于 `3ca240ed`，不冒充新组合结果。

远端完整测试和实际 Windows 成包以 [PR 的当前提交检查](https://github.com/Moyf/moys-asr-workflow/pull/285/checks)为准，必须确认 HEAD 与验证提交一致。不会重新生成 `blank-editor.html`，内联副本待发布前统一重生成。

## 未验证边界

原生保存选择器、桌面 WebView、跨平台与实际设备听感仍由维护者按核验清单确认；自动化浏览器验证不代替这些验收。
