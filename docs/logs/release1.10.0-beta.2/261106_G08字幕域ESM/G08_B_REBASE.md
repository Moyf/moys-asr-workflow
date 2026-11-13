# G08-b 在 G08-a 合入后的重放与验证

## 基线与范围

- 上游 `main` 为 `df00f73a`（已合入 G08-a，PR #316）；重放前 Cat Fork 的 G08-b 位于 `28200dcb`。在独立工作树把 G08-b 的九个提交重放到该 main，得到 `eb1839fd`，无冲突。
- G08-a 的 `find-replace` 已随上游 #339 删除，不属于 G08-b。G08-b 在 #339 新版 `text-process` 上转换，且把新增的 `text-presets` 也转为 init。
- 本轮发现 `text-process` 已声明导入五个预设函数，但九处调用仍走 `MaweProcessing.*`。已把函数调用改为导入绑定；`library`、`portable` 两个属性继续显式从 `window.MaweProcessing` 读取。

## 验证

| 层 | 命令或范围 | 结果 |
|---|---|---|
| 构建 | `node scripts/build-editor.mjs --write`、`pnpm run check:editor`、`pnpm run typecheck` | 92 个 ESM 工厂、151 个源码；bundle 新鲜；typecheck 通过 |
| Node | `pnpm run test:unit` | 1043/1043 通过 |
| Python 契约 | `scripts/run_tests.py tests/test_editor_assets.py tests/test_web_build.py tests/test_packaging_contract.py` | 83/83 通过 |
| Chromium | `split-style-markers.spec.mjs`、`editor-text-tools.spec.mjs`、`overlay-track.spec.mjs` | 16/16、34/34、27/27 通过 |
| 静态检查 | `git diff --check` | 通过 |

新工作树首次运行 Node 套件时，因未生成 launcher bundle 出现两项产物缺失及一项 ASR 预设浏览器超时；补建 launcher bundle 后重跑，1043/1043 通过。测试使用 Node 25.8.0，包声明支持 Node 22、24 或 26 及以上；正式 CI 仍需覆盖受支持的版本。

本地结果文件位于当前工作树 `.artifacts/checks/`：Node `20261106T100848Z-97a4932e/result.json`、Python `20261106T100919Z-3ea49754/result.json`、Chromium 三组分别为 `20261106T101024Z-fcb2ffee/result.json`、`20261106T101119Z-92f53074/result.json`、`20261106T101250Z-8c27db94/result.json`。测试对应重放基线 `eb1839fd` 加本轮补丁；最终提交 SHA 与 CI 以 PR 为准。

## 待处理与边界

- G08-a 已合入的若干属性成员被包装成函数导出（如 `selectedIdxs`），G08-b 也存在同类未使用的属性包装。当前没有静态消费者，浏览器用例未发现功能问题；未来导入这些属性前须改为正确的值或访问器接口。
- 申请上游 PR 前，需以最终 HEAD 核对独立自审、个人路径检查、CI 与 PR 描述。人工核验项目见同目录清单。

## 2026-11-09：最新 rebase 后的 G08 残余检查

审计基线为 `review/g08-b-rebase` 的 `f7814538`，已重放到上游 `ce55c207`。本轮仅补齐 G08 同域函数消费边，不调整用户操作语义。

| 检查项 | 状态 | 处理与证据 |
| --- | --- | --- |
| 核心模块登记 | 仅说明 | 27 个非 wiring 字幕核心模块全部为 `kind: init`，无漏登记。早期 `overlay-track` 纯模块及跨域 wiring 保留原边界。 |
| 同域函数调用残余 | 已修复 | `editor-text-process` 中三处 `finishEdit`、一处 `commitCuePanelEdit`，以及 `editor-timed-text-edit` 中一处 `getCurrentCuePanelTarget` 改用静态 import。它们在 rebase 前的 PR 中也已存在，并非本次上游新增。 |
| 上游新增代码 | 仅说明 | 波形 `cue-quick-edit` 已采用 ESM 工厂并由 `waveform.js` 静态导入、创建和安装；字幕添加/切分的新逻辑已在原 init 内，状态回调继续按原数据接口传递。没有发现需要另转 init 的新增字幕模块。 |
| 后续防回归 | 已修复 | 新增 `tests/test_editor_cues_imports.mjs`，用 AST 扫描上述 27 模块之间的直接门面函数调用；保留状态属性、模块自身兼容包装与跨域调用。 |

### 本轮验证

以下均由 `python scripts/run_check.py --timeout <秒> --` 包装，结果路径相对当前工作树，对应 `f7814538` 加上述三文件补丁。

| 层 | 命令 / 范围 | 实际结果与证据 |
| --- | --- | --- |
| 新检查红绿对照 | `node --test tests/test_editor_cues_imports.mjs` | 临时恢复两个源码为 HEAD 版本，实际检出五处并 exit 1：`20261109T035149Z-a59a3be4/result.json`；随后恢复补丁并重建。 |
| 构建与定向 Node | `node scripts/build-editor.mjs --write`；新检查及 bundle 套件 | 重建成功；17/17 通过：`20261109T035149Z-9dfc4278/result.json`、`20261109T035150Z-20db3120/result.json`。首次在重建前误跑出现一项过期产物断言失败，已重建纠正，不作为源码失败。 |
| TypeScript | `node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json` | exit 0：`20261109T035050Z-4755ef39/result.json`。 |
| Chromium | `editor-text-tools.spec.mjs`、`timed-text-edit.spec.mjs` | 完整两组 50/50：`20261109T035440Z-7ea1af22/result.json`。 |
| 扩展 Node | `node --test tests/*.mjs` | 1071/1072，exit 1：`20261109T035450Z-7f7c2455/result.json`。唯一失败为进程生命周期测试请求独立旁观进程时 `fetch` 报 `bad port`；该端口由系统动态分配，与字幕模块未共享代码。单独重跑该用例 1/1 通过：`20261109T035628Z-427fbeaa/result.json`。局部重跑不代表完整套件通过。 |

表内 result 文件均位于 `.artifacts/checks/`。独立自审未发现新的 blocker / major，见同目录 `REVIEW_FINDINGS.md`。本轮不生成便携 HTML；内联副本待发布前统一重生成。未运行全量 Python、全量浏览器、打包或远端 CI；此前字词拖动的三项未解决验证边界仍见[播放头与 PR 反馈记录](../261109_G08B播放头与PR反馈/TEST_FEEDBACK_G08B.md)。
