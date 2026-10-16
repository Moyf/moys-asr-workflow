# 编辑器「烧录视频」功能实现记录

分支 `feat/editor-video-burn-in-ass`，基线 9ec2ef1d。

## 需求

参照「去空隙导出 → 重组后视频」的服务端媒体导出机制，在编辑器内新增「烧录视频」：
直接调用 FFmpeg（libass）把当前工程 ASS 字幕烧进视频，与 Launcher 工具箱「压制字幕」同款
（自动硬件编码器探测 + CPU 回退、缺字中止、输出 MP4）。已确认：

- 调查结论：编辑器侧此前**没有**整片烧录功能（全分支历史、下游 OMYAA-MAW-NRH-FFV 均无）；
  已有的关联能力是 Launcher `run_burn_subtitles` 与编辑器单帧「实际画面预览」`/api/ass-frame`。
- 范围（维护者确认）：两个入口都做——完整源视频（原时间轴）+ 去空隙重组后视频（收缩时间轴）。
  去空隙场景因重编码可获得帧级精确切点（摆脱流复制的关键帧对齐限制）。
- 参数：v1 不暴露编码参数面板，内部全默认（auto 编码器 + 默认 CRF/预设/音频码率）。

## 设计

- 服务端 `serve.py`：新增 `burn_ass_video()`（ffconcat 输入支持区间、`ass=` 滤镜、
  编码器回退循环、缺字中止）+ `/api/exports/burned-video/jobs` 系列路由，复用 `MediaJobManager`
  （与媒体重组共享单任务槽）、`ensure_libass_supported`、`_probe_gap_removed_video`/`_gap_removed_ffconcat_text`。
- 编码器探测逻辑从 `maw/postprocess_ffmpeg.py` 以公共别名导出复用。
- `maw/media_jobs.py`：`MediaJob.run_command` 增加 `cwd` 透传（ASS 写入任务临时目录、
  进程 cwd 指向该目录，沿用「实际画面预览」确立的滤镜文件名约定）。
- 前端：新模块 `web/editor/io/editor-wiring-burn-video.js`（任务面板/取消/下载流复用重组后视频的
  生命周期模式；ASS 文本来自 `buildAss()` / `buildGapRemovedAss()`）；i18n 补英文词条；
  bundle 重建后 `pnpm run check:editor`。

## 入口调整（第二轮，同日）

维护者反馈：完整源视频的烧录入口不放「更多导出」菜单，改为工具栏独立按钮
（「去空隙导出」左侧），普通按钮样式（红色方案提出后又取消），仅在 ASS 字幕模式显示。

- 模板：`#burn-video-export-btn` 插入「导出工程」与「去空隙导出」之间；「更多导出」里的菜单项移除。
- 显隐：`canBurnVideoExport && burnVideoJobsUrl && EDITOR_SETTINGS.assMode`；模块暴露
  `MaweBurnVideoExport.syncButton`，由 `editor-wiring-ass-manager.js` 的 `syncAssModeControl()`
  随 ASS 开关即时同步（设置加载路径 editor-wiring-settings-init / editor-project-settings 也经此函数覆盖）。
- i18n：按钮文案「烧录视频」；e2e 新增显隐测试（assMode 关 → 隐藏，开 → 显示，能力位关闭 → 隐藏）。

## 核对清单工具化（第三轮，同日；提交至 main，不经 PR）

把本任务的人工核对清单沉淀为可复用工具链（`tools/verification-checklist/`）：

- **Markdown 源格式（v1）**：清单源文件为带 YAML front-matter 的 Markdown（task/pr/date/status），
  agent 只写 MD；`build.py --data *.md` 与 JSON 同一套校验，`--check` 只校验，
  `--to-md` 做 JSON→MD（`--meta` 写 front-matter），`--scan` 汇总核验状态。
  check 行 ID 放行尾 `<!-- id: -->`、分区 ID 为标题下注释行（GitHub 渲染不可见）；
  note 行首标记符转义（`\-`、`1\.` 等）。JSON→MD→HTML 与 JSON→HTML 逐字节一致（已验证）。
- **HTML 页面导出**：新增「导出 Markdown」「复制 Markdown」（与导出 JSON 并排且更靠前），
  产出核对结果快照（任务列表勾选态 + 引用行备注 + 行尾核对项 ID；被忽略分组标注）。
  `buildResult` 抽取共享；按钮随「无可导出项」禁用同步。
- **文档与技能**：工具 README 重写（MD 契约 + 工作流）、skill `verification-checklist` 改为
  MD-first、根 AGENTS.md「批量改动的人工核查清单」更新为「agents 只写 Markdown」。
- **本任务的实例**：`docs/logs/release1.9.0-beta.1/261015_编辑器烧录视频/EDITOR_BURN_VIDEO.checklist.md`（status: pending），
  与本台账并排；核验完成后回写 `- [x]` 与 status。
- 存量问题确认：`tests/test_verification_checklist.py` 在 targeted run 下因裸 `from compact_assertions
  import` 导入失败（git stash 基线复现，与本次无关；discover 全量模式下正常）。

## 任务清单

| 状态 | 项 | 说明 |
| --- | --- | --- |
| 已修复 | media_jobs.run_command cwd 参数 | 透传给 popen_process_tree；媒体任务消息「媒体重组」改为「媒体导出」（烧录共享同一任务槽） |
| 已修复 | 服务端 burn_ass_video + 路由 + SERVER_CONFIG | burn_ass_video（区间走 ffconcat 单遍重编码）、/api/exports/burned-video/jobs 系列路由、_media_job_request 共享助手、canBurnVideoExport/burnVideoJobsUrl/burnVideoSourceName |
| 已修复 | 前端菜单项 + 任务流程 + i18n | editor-wiring-burn-video.js 新模块 + 清单/契约测试同步；「更多导出→烧录字幕视频」「去空隙导出→重组后烧录视频」；音频工程隐藏去空隙烧录项 |
| 已修复 | Python 测试（单元 + HTTP 生命周期） | tests/test_burn_video_export.py 12 例；test_editor_assets 清单契约同步 |
| 已修复 | bundle 重建与 check:editor | 192 sources；check:editor / typecheck / node --test 395 全过 |
| 已修复 | e2e burn-video-jobs.spec.mjs | 6 例全过（请求契约、停止/准入取消、mime/同名/扩展名失败、无空隙软失败） |
| 已修复 | 全量回归 | scripts/run_tests.py 2297 例最终确认：唯一失败为 test_hub_download 环境性失败（见下） |
| 已修复 | 文档（EDITOR_GUIDE / TOOLBOX / CHANGELOG） | |
| 已修复 | 人工核验清单 | .artifacts/burn-video/verification.html 已生成（不入库） |

## 环境性失败与存量问题（均与本改动无关）

- `test_hub_download.PrepareHubSnapshotTests.test_existing_modelscope_cache_is_reused_including_mirrored_org`：
  本机 `%LOCALAPPDATA%\MAW\model-cache` 已有该模型缓存时命中本机缓存而非临时目录；覆盖的
  `maw/hub_download.py` 未被本次改动触及。
- `gap-removed-audio-export.spec.mjs` 的「detach clears all capabilities…」：e2e 报
  `ReferenceError: MaweCoreState is not defined`。已用 `git stash` 在**不含本次改动的基线**上
  复现同样失败，确认是存量问题（另行排查，本次不修）。
- e2e 偶发 `browserType.launch` 超时一次（同机并行长测试导致），重跑即过，非逻辑失败。

## 验证记录（HEAD 9ec2ef1d + 本分支改动，未提交）

- `uv run --no-sync python scripts/run_tests.py tests/test_burn_video_export.py` → 12 passed
- `uv run --no-sync python scripts/run_tests.py` → 2297 例，唯一失败为上述环境项
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs` → 395 passed
- `pnpm run check:editor` / `pnpm run typecheck` → 通过（bundle 不入库）
- `playwright test --project=chromium tests/e2e/burn-video-jobs.spec.mjs` → 7 passed（含 ASS 模式显隐）
- `playwright test --project=chromium tests/e2e/ass-export.spec.mjs` → 19 passed（入口调整后复跑）
- `playwright test tests/e2e/gap-removed-media-jobs.spec.mjs tests/e2e/gap-removed-audio-export.spec.mjs` → 35 passed + 1 存量失败（见上）
- `git diff --check`、`scripts/check_personal_paths.py --diff-ref main` → 干净


## 2026-10-16 正确性复审补充

上文 ffconcat 直接重编码即可精确切点的判断已由真实长 GOP 反例推翻。当前修复改为解码后选择/裁剪与统一音画时钟；同时补齐媒体替换/解绑时烧录失效及全程缺字诊断。历史验证不能替代修复后的验证，详见[复审与修复记录](../../release1.9.0-beta.2/261016_PR241正确性复审/修复与验证.md)。
