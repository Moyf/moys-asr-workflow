# PR #412 的辅助浏览器失败分诊

本地基线：`test/2dev-playwright-discovery@0e5efef8`，工作树原先干净。远端证据：[CI 44884679882 分片 1/2](https://github.com/Moyf/moys-asr-workflow/actions/runs/44884679882/job/136787402618)。

| # | 问题 | 状态 | 核实结论／方案 |
| --- | --- | --- | --- |
| 1 | `issue234-review-regressions`：拆分／跨轨后撤销、保存、重开 | 已修复 | L49 普通保存返回 `undefined`；旧夹具进入显式迁移另存。改用共享 importer 生成规范 v2 夹具，核对 Server 真实写回及重开。 |
| 2 | 同 spec：禁用轨道的分组可见性及导出 | 已修复 | 旧测试读取不存在的顶层 `segments`。改用主轨／叠加轨 API，保留预览、FCP、Resolve、OTIO 及分组成员断言。 |
| 3 | 同 spec：贴纸几何、撤销与保存 | 已修复 | 贴纸撤销不再把原本不存在的 `preview.extension_subtitle` 写进工程，保留干净检查点；显式配置的副字幕外观和扩展字段仍可撤销、重做、写回及重开。 |
| 4 | 同 spec：轨间转移后保留 ID | 已修复 | 更新轨道访问并保留 ID 冲突覆盖与重开断言。 |
| 5 | 同 spec：同名分组的素材与结束边界 | 已修复 | 用主轨及 v2 分组 API，保留两个素材 URL 与精确结束边界断言。 |
| 6 | `editor-text-tools`：添加步骤时替换未编辑的初始步骤 | 已修复 | 可控延迟复现：预设响应在「查找」获焦后替换输入节点，随后输入丢失，导致仅有一行。刷新时保留已获焦的步骤控件；常规路径等预设就绪，另保留延迟回归。远端原失败没有独立时序证据。 |
| 7 | `multi-subtitle-metadata`：同人物跨轨合并、撤销、保存 | 已修复 | 分开验证混合主轨拒绝且不改数据／历史、未绑定副轨仍拒绝混合身份、主轨同人时允许合并并统一副轨。保留字词时间、分组、撤销、写回、重开及交换验证；身份归字幕而非字词。 |
| 8 | `subtitle-preview-geometry`：保存后读旧顶层 `segments` | 已修复 | 用 `getMainTrack(onDisk).segments` 取 v2 主轨，原保存、重开和时间断言不变；定向 Chromium 通过（`20261121T115521Z-b6b1d6d4`）。 |
| 9 | `ass-export`：Linux runner 加载本机 `Arial` 报 `NetworkError` | 已修复 | 使用内嵌合成 WOFF，不依赖系统字体；验证两组字体加载和字宽，再执行原有度量与 `\fs` 动画断言。Windows Chromium 通过，Linux CI 待复验。 |
| 10 | `keyboard-timing`：按住共享边界再按 D，CI 中第二条结束时间由 18000 变成 18100 ms | 已修复 | 时序触发的产品缺陷：拖动期间静默保存把面板旧时长当编辑写回。修复：波形拖动期间静默保存延后（拖动提交经命令层刷新重新武装防抖保存），保存与另存为的路径跳过拖动中的面板旧值提交、只序列化实时模型。补两条确定性回归（静默延后、显式保存不腐蚀），均先在旧代码上失败复现 `end:18100`。 |

## 阶段汇总

- `0e5efef8` 定向复跑 7 条：本地复现条目 1–5、7，条目 6 通过（`20261121T100140Z-a59b72db`）。干净目标 `2.0dev@e7c92910` 用归档、独立构建和相同锁文件环境定向复跑，结果完全一致（`20261121T100513Z-5069ff81`）；六个确定性失败已证实为目标基线问题，文本处理偶发失败不据此归因。
- 开始实施：按独立 spec 拆分，条目 6 做可控时序复现，不靠固定延时、重试或放宽原有断言。
- `issue234-review-regressions` 迁移后的首次完整验证为 4 通过、1 失败（`20261121T100713Z-bff28089`），留下真实的贴纸撤销虚脏回归，未弱化断言。
- 文本处理先红后绿：旧 bundle 在延迟响应探针中收到 1 行而不是 2 行（`20261121T100517Z-4d12d0eb`）；修复后 `editor-text-tools` 全份 33/33（`20261121T100733Z-566adf11`）。
- `multi-subtitle-metadata` 全份 9/9（`20261121T100935Z-27395fdb`）。
- 贴纸负向对照：`20261121T100914Z-b6ee0d9c`；修复后 `issue234-review-regressions` 全份 6/6（`20261121T101006Z-075d94b3`）。补跑的 `subtitle-preview-geometry` 预览拖动撤销／重做通过；另一条保存重开用例仍读取旧 `onDisk.segments`，不在远端七条清单中（`20261121T101006Z-fdad2df1`）。
- 首轮合并验证包含三份受影响 spec 及清理预览，54/54 通过（`20261121T101140Z-0dbbf4cd`）；此轮在独立自审整改前执行。
- 额外的 `subtitle-preview-geometry` 保存重开用例在干净 `2.0dev@e7c92910` 同样因旧 `onDisk.segments` 读取失败（`20261121T101519Z-70bd270e`），不归入这七项。
- 独立自审整改后，`pnpm test issue234-review-regressions.spec.mjs editor-text-tools.spec.mjs multi-subtitle-metadata.spec.mjs ai-cleanup-scope-integration.spec.mjs` 全部 56 条通过（`20261121T101817Z-09196218`）；bundle 新鲜度与类型检查通过（`20261121T101817Z-6451d62f`、`20261121T101819Z-9dab2c4c`）。人工验收与远端 CI 尚未执行。
- `ea6da117` 的 [远端 CI](https://github.com/Moyf/moys-asr-workflow/actions/runs/44897268325)：前七项均通过；辅助 Chromium 742 通过、2 失败，补记条目 8–9。此次跟进基于干净的 `test/2dev-playwright-discovery@ea6da117`。
- 条目 8–9 仅修改两个测试 spec。Windows Chromium 执行 `pnpm test ass-export.spec.mjs subtitle-preview-geometry.spec.mjs`，28/28 通过（`20261121T115846Z-d3046850`）；独立自审无阻断项，Linux CI 待推送后验证。
- 本轮调查基于干净工作树 `test/2dev-playwright-discovery@e38ea111`。[远端 CI](https://github.com/Moyf/moys-asr-workflow/actions/runs/44902046766) 已验证条目 8–9 通过，分片合计 743 通过、1 失败（条目 10）；`Change acceptance` 通过。
- 条目 10 原用例本地定向 8/8（`20261121T125658Z-cc7c3f19`）。整份 `keyboard-timing.spec.mjs` 为 40 通过、1 失败（`20261121T130042Z-c4bd21e8`）；目标用例通过，失败为另一条 `dual mode links both edges via the seam zone while side handles trim independently`，是否同因未确认。
- 失败 CI trace 证明命中共享中缝，松手前仍是正确的 `10200–18000` 波形预览，松手过程中的 `/api/project` POST 已是 `10200–18100`。本地用 `.artifacts/pr412-held-save-probe/` 关闭背景自动保存、指定生产静默保存的调用时点：两组按 D 后均为 `10200–18000`；松手前保存把内存、POST 和最终结果改为 `10200–18100`，松手后保存则保持 `10200–18000`（对照 2/2，`20261121T130255Z-25b53fcf`）。面板仍显示旧起点 `10100`、旧时长 `7900`，保存提交面板时把起点钳到左邻的新结束 `10200`，再加旧时长。`editor-server-save.js` 的防抖与定时保存均调用同一静默入口；未单独控制验证 CI 中具体由哪个计时器触发。
- 实施修复：`web/editor/io/editor-project-save.js` 新增 `waveformCueDragActive()`，波形拖动期间静默保存直接延后（对齐既有 ASS 定位拖动的处理），`flushInlineEditsForSave` 与另存为路径跳过面板旧值提交。`tests/e2e/keyboard-timing.spec.mjs` 在 A/D 长按用例后新增两条回归。注意 e2e 的 serve.py 每次渲染前 `ensure_bundle` 自动重建：fail-first 需先暂存源码修复、以 HEAD 源码对应的旧 bundle 运行——两条回归分别失败于 `deferred` 为 `true`（`20261121T131212Z-1cf6e223`）与 POST `end:18100`（`20261121T131200Z-cc4dfdd3`）。
- 修复后整份 `keyboard-timing.spec.mjs` 43/43 通过（`20261121T131234Z-c16ba17e`，含上轮本地偶发失败的 `dual mode` 用例与 CI 原 `A/D` 用例）；bundle 新鲜度、类型检查、个人路径与 `git diff --check` 均通过。远端 CI 与人工验收待验证。
- 独立自审无 blocker / major，4 条 nit 已逐条处置并记入 `REVIEW_FINDINGS.md`；未验证项（面板失焦提交）已复核存在。`origin/2.0dev` 未前进（e7c92910 已在 HEAD 内），无需再合并。
