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
