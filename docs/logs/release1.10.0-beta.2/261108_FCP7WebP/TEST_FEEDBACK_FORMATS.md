# PNG 保留、可选 WebP 与移除 Pillow 运行时

基线：`feat/fcp7-webp-subtitles` / `1b2f28d5`，工作树开始时干净。此前 WebP 替换 PNG 的决定被维护者纠正；本记录为当前要求，IMPLEMENTATION.md 的旧验证保留其历史语境。

| 条目 | 状态 | 决定、证据与边界 |
| --- | --- | --- |
| 1. PNG 默认与 WebP 可选 | 已修复 | 保留旧任务路由和函数名；省略 imageFormat 时输出 PNG，显式 webp 才输出 WebP；面板提供两种图片格式。旧素材不迁移、不改写。62 项渲染/HTTP/打包回归含双格式、两帧率严格像素对照通过，`20261108T015220Z-cafb6b62`。 |
| 2. 移除图片字幕 Pillow 运行时 | 已修复 | FFmpeg 负责透明检测、RGBA 哈希和编码；Python 只解析元数据、去重、合并与发布。Pillow 仅留既有开发/构建/OCR 可选组。禁止 PIL 导入的子进程实际导出两种格式通过；62 项渲染/HTTP/打包契约通过，`20261108T014540Z-22021c1d`。实际发布包另列条目 3。 |
| 3. 回归、浏览器与发布包 | 已修复 | 14 项 Chromium 通过，`20261108T014734Z-8d956e2e`。正式 spec 构建 `20261108T014734Z-243b1a40`；实际排除 PIL 的 EXE 启动、浏览器导出两种格式及旧包保留通过，`20261108T014936Z-6cfb6e19`。整套 Python 的超时/基线失败单独记录，不声称全绿。 |
| 4. 独立复审与文档 | 已修复 | 指南、计划、变更说明与官网同步；独立复审无 blocker/major，1 项文档 minor 已修复，见 REVIEW_FINDINGS.md。 |
| 5. 目标软件 WebP 导入 | 仅说明 | 沿用用户允许跳过本机 VEGAS 14 WebP 导入的边界；不将 PNG 导入证据当成 WebP 证据。 |
| 6. 同期远端提交与三端 CI | 已修复 | 正常合并 `22e01d89`，保留其界面和接口兼容；解决 FFmpeg 8.1 像素偏差。cat fork 专用 tag 的 Windows、Linux、macOS 三端构建均通过，见下文。 |

测试统一经 scripts/run_check.py，原始证据存 `.artifacts/checks/<run-id>/`，逐项完成后回填。内联副本待发布前统一重生成。

## 阶段记录

- 默认 PNG 回归在修改前真实失败：`WEBP != PNG`，`20261108T014051Z-58560dde`；实现后通过 `20261108T014315Z-c6dcd951`。
- 第一版 FFmpeg 参数混用输出帧率与 passthrough 被 FFmpeg 拒绝，未产出素材；现将采样后的本地帧时钟统一为整数秒，并对三路使用 1 fps CFR，外部 XML 时钟不变。回归覆盖非整数视频帧率。
- `uv lock --offline` 尝试因缓存缺少 torch 跨 Python 版本元数据失败；未同步环境。仅移除锁中两条主程序 Pillow 依赖边，保留所有可选组和包版本；随后 `uv lock --check --offline` 成功（185 包）。
- 用户补充要求：完成后推 tag 至 cat fork，检查三端 CI。测试 tag 仅用于 fork，不发布上游版本。

## 本地分层检查（合并同期远端前）

全部证据均为 `1b2f28d5` 加当前未提交修改，目录 `.artifacts/checks/<ID>/result.json`。

| 层级 | 命令与结果 | ID |
| --- | --- | --- |
| 渲染/HTTP/打包契约 | scripts/run_tests.py tests.test_fcp7_png tests.test_fcp7_png_api tests.test_packaging_contract：62 项通过；PNG/WebP × 25/30000:1001 帧率保留严格 3/6 像素阈值 | `20261108T015220Z-cafb6b62` |
| Node | node --test tests/*.mjs：1054 项通过；随后增加一项客户端格式测试，相关文件 5 项通过 | `20261108T015001Z-9f247a35`、`20261108T015313Z-54e8c0ee` |
| 旧红新绿 | 默认 PNG 在旧实现失败；旧 renderer 禁止 PIL 后导入失败，旧客户端缺省/显式格式断言失败；新实现实际运行通过 | `20261108T014051Z-58560dde`、`20261108T015313Z-098d8496` |
| 静态/构建 | Ruff、typecheck、bundle freshness 均通过 | `20261108T015041Z-767cf38e`、`20261108T015001Z-a9523b06`、`20261108T015515Z-9e6d3e97` |
| 官网/文档 | sync/check/build 通过，40 页；文档 0 新断链/结构错误，4 个旧索引警告；个人路径检查通过 | `20261108T015132Z-0a49a86c`、`20261108T015210Z-e68ffadc`、`20261108T015313Z-195b597e`、`20261108T015313Z-61056e8f`、`20261108T015516Z-d2ed0a11` |

全量 Python 串行在 240 秒限时终止，未生成最终报告（`20261108T015001Z-2c051e3d`），未作为通过证据。分析历史检查采用 4 worker 后，以同一方式复跑：2864 项、23 跳过、4 失败（`20261108T015505Z-4244b055`）；其中新增二进制成员断言缺 compact 混入已修复，4 项门禁复验通过（`20261108T015712Z-37b89698`）。其余 3 失败与既有报告一致：burn_video_export 两项帧边界/时长，thumbnails 非零 PTS 时长；不得称本地全量通过。三端 CI 将使用各平台工具链再检验。

## 同期远端合并与 FFmpeg 8.1 修复

合并 cat 远端 `22e01d89`：保留 PNG 默认选中、逐格式标题/说明/hint、原生模式专用 e2e 和第五个 image_format 参数兼容。当前 PNG/WebP 统一使用 FFmpeg，无 Pillow 恢复路径。旧分支将 WebP 像素阈值放宽 64 的做法不沿用；两格式均保持严格 3/6。

- Gyan 官方 FFmpeg 8.1 初跑真实复现 7 失败/2 错误：`20261108T015838Z-3e333b1d`。逐阶段原始 RGB/Alpha 对照定位到 FFmpeg 8.1 在 alphamerge（声明 straight）→ unpremultiply（要求 premultiplied）之间自动插入预乘，造成重复预乘。旧图日志保存在 `.artifacts/fcp7-png/ffmpeg81-diagnostic-old/8.log`，诊断 `20261108T020317Z-1c0bbb35`；依据为官方 [alphamerge 源码](https://github.com/FFmpeg/FFmpeg/blob/n8.1/libavfilter/vf_alphamerge.c) 与 [premultiply 源码](https://github.com/FFmpeg/FFmpeg/blob/n8.1/libavfilter/vf_premultiply.c)。
- 修复为 RGB 与复制成 RGB 的 Alpha 通过 lut2 显式计算 `min(255,channel*255/alpha)`，Alpha=0 时 RGB 归零，最后合入原始 Alpha。避免版本限定的 alpha_mode 选项，也不让 unpremultiply 触发自动协商。8.1 下严格像素检查恢复通过，`20261108T020247Z-7b9858cf`（17 项）。
- 原 A=1 ASS 字形夹具在 8.1 的白底直接渲染已全部为 255，而 7.0.2 为 254–255；据双底计算预期 Alpha 分别为 0 和 1，均与管线恢复一致。直接诊断 `20261108T020317Z-31090542`，原始帧/日志在 `.artifacts/fcp7-png/ffmpeg81-diagnostic-faint/`。因此 Alpha=1 检测/跨批次去重用例改为精确黑/254白双底，独立验证真实 A=1 像素不被丢弃；实际 libass 的动画/多背景对照继续保留严格阈值，并非放宽像素断言。

此合并与滤镜修改后的完整回归、浏览器和实际包验证另列最终结果，之前结果仅保留对应代码的证据。

## 合并后最终本地验证

源码基线 `707a0b48`；其后仅补历史文档的阶段标记和本结果，不更改实现。

| 层级 | 实际结果 | run_check ID |
| --- | --- | --- |
| Python 全量 | FFmpeg 8.1，scripts/run_tests.py --parallel 4 --report .artifacts/fcp7-png/formats-python-81-final.json：2864 项，0 失败/错误，23 跳过；此前 7.0.2 的三项既有媒体失败在此版本工具链通过 | `20261108T020437Z-12ca119b` |
| Node 全量 | node --test tests/*.mjs：1055 项通过、无跳过 | `20261108T020437Z-c9e9ee94` |
| Chromium | PNG 默认、WebP 显式选项、原生文字、双语、取消、去空隙：14 项通过 | `20261108T020437Z-8944f486` |
| 实际程序包 | 正式 MAW.spec 构建成功；PYZ 与包目录无 PIL；隔离目录/用户数据启动实际 EXE + FFmpeg 8.1，经浏览器导出 PNG 与 VP8L WebP、两个 XML，先前 PNG 包保留，无页面错误；间距至少 8 px，已查看选项截图 | `20261108T020437Z-90439c6c`、`20261108T020558Z-ee8087e8` |
| 静态检查 | typecheck / Ruff / bundle freshness / 个人路径检查通过 | `20261108T020504Z-ce667b75`、`20261108T020505Z-c71d62de`、`20261108T020534Z-7017e792`、`20261108T020641Z-c917eae9` |

按用户允许，目标软件 WebP 导入仍未实测；Pillow 保留在开发、构建图标与 OCR 可选依赖组，图片字幕模块及主程序依赖/发布包已移除它。清单仅提供可选目标软件复核，不作为已完成的人工验收。

## cat fork 三端 CI

首个 tag `ci-fcp7-formats-20261108-71f98599` 对应源码 `71f98599`，CI commit 只增加 fork 专用 tag 触发规则，非 v tag 不执行发布 job。[运行记录](https://github.com/drunkenQCat/moys-asr-workflow/actions/runs/42437192505)。macOS 尚未分配 runner 就被取消，annotation 明确为 `The configuration 'macos-14-arm64-us-default' is not supported`，不是测试失败；依据 [GitHub 官方 runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，矩阵更新为受支持的 macos-15 ARM64，并同步打包契约后重跑。

FFmpeg 7.0.2 的最终双格式渲染兼容检查 17 项通过，`20261108T020718Z-2b84a0e8`。可选目标软件核验清单已校验、生成并在浏览器打开，`20261108T020856Z-15fd995d`。

修复 runner 后，打包契约 36 项通过（`20261108T021031Z-b2250ba7`）。最终源码 `5276954b`，cat fork tag `ci-fcp7-formats-20261108-5276954b`，CI commit `244ec030` 语义上仅增加 CI tag 触发规则；另有临时 wrapper 的 CRLF 偏差，已在 REVIEW_FINDINGS.md 记录并修正后续生成器，不带回功能分支。[完整运行](https://github.com/drunkenQCat/moys-asr-workflow/actions/runs/42437401842) 结论 success：

| 平台 | CI job | 结果 |
| --- | --- | --- |
| Windows x64 | [完整构建](https://github.com/drunkenQCat/moys-asr-workflow/actions/runs/42437401842/job/128599098500) | success |
| Linux x86_64 | [AppImage 构建](https://github.com/drunkenQCat/moys-asr-workflow/actions/runs/42437401842/job/128599098432) | success |
| macOS arm64 | [macOS 15 构建](https://github.com/drunkenQCat/moys-asr-workflow/actions/runs/42437401842/job/128599098549) | success |

非 v tag 的 GitHub Release 和更新索引步骤均按预期 skipped，未创建正式发布。上游 PR 353 的 editor、Ruff、Windows/Linux 调试工具与 CLA 在此源码上均通过。本条结果之后只补文档，不更改产品代码。三端构建通过不代表剪辑软件导入验收；目标软件 WebP 导入仍按用户允许未测，见条目 5。
