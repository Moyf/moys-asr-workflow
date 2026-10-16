---
task: editor-burn-video
pr: 241
date: 2026-10-15
updated: 2026-10-16
status: pending
---

# 编辑器「烧录视频」人工核验 · 2026-10-15

> 分支 feat/editor-video-burn-in-ass（基线 9ec2ef1d）。自动化已通过：Python 12 例新增 + 全量套件（仅 1 例环境性失败与本改动无关）、node --test 395 例、check:editor / typecheck、e2e burn-video-jobs 6 例 + ass-export 19 例。以下为真实浏览器人工确认项。

## 实现与审查结论（只读）
<!-- id: implement-review -->
<!-- badge: fixed 只读 -->

此前编辑器侧没有整片烧录功能；已有的是 Launcher 工具箱「压制字幕」与编辑器单帧「实际画面预览」。本次在 server-editor 侧复用媒体任务体系（MediaJob）新增整片烧录，编码行为与工具箱「烧录字幕」同款（自动硬件编码器按 nvenc → amf → qsv → cpu 顺序回退，CRF 21 / preset medium / 音频 192k，缺字中止不输出方框）。

入口一：工具栏「烧录视频」按钮（「去空隙导出」左侧，仅 ASS 字幕模式且已绑定视频工程时显示），烧录当前工程绑定的完整源视频 + 原时间轴 ASS。入口二：「去空隙导出 → 重组后烧录视频」，按保留区间解码后精确裁剪音画并烧录，字幕时间轴即收缩后的去空隙时间轴，切点帧级精确。音频工程两个入口均不可用（去空隙菜单内隐藏、服务端再校验视频源）。

v1 不暴露编码参数面板（维护者已确认全默认）；编码器探测逻辑从 maw/postprocess_ffmpeg.py 以公共别名复用。未重新生成 blank-editor.html（发布前统一重生成）。


## 自动化验证结果
<!-- id: auto-verify -->
<!-- badge: pass 已通过 -->

| 命令 | 范围 | 结果 |
| --- | --- | --- |
| uv run --no-sync python scripts/run_tests.py tests/test_burn_video_export.py | burn_ass_video 命令构造 / 编码器回退 / 缺字中止 + 烧录任务 HTTP 生命周期（12 例） | 12 passed |
| uv run --no-sync python scripts/run_tests.py | 全量 2297 例 | 除 1 例环境性失败（test_hub_download：本机 MAW 模型缓存命中，与本改动无关）外全部通过 |
| node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs | 编辑器脚本清单 / i18n / 波形 JS | 395 passed |
| pnpm run check:editor + pnpm run typecheck | bundle 新鲜度与 TS 类型 | 通过（bundle 为构建产物，未入库） |
| playwright test --project=chromium tests/e2e/burn-video-jobs.spec.mjs | 烧录任务流：请求契约 / 停止取消 / 同名与扩展名校验 | 6 passed |
| playwright test --project=chromium tests/e2e/ass-export.spec.mjs | 菜单结构与 ASS 导出回归 | 19 passed |

环境性失败说明：test_hub_download.PrepareHubSnapshotTests.test_existing_modelscope_cache_is_reused_including_mirrored_org 在本机已有 MAW 模型缓存时命中本机缓存而非临时目录，属于既有环境差异；该测试覆盖 maw/hub_download.py，本次改动未触及该文件。


## 人工核验：烧录字幕视频（完整源视频）
<!-- id: manual-burn-full -->
<!-- badge: todo 待核查 -->

准备：Launcher 打开 server-editor 并绑定一个视频工程（含若干字幕，ASS 模式开启）；本机 FFmpeg 需带 libass（与「实际画面预览」同要求）。

- [ ] **烧录入口仅在支持的工程与模式中显示**
  （操作）编辑器工具栏（「去空隙导出」左侧）：开启 ASS 字幕模式，查看「烧录视频」按钮
  （预期）ASS 模式 + 已绑定视频工程时按钮显示；关闭 ASS 模式或浏览器（file:// 便携页）打开时不显示
  <!-- id: full-menu-visible -->
- [ ] **完整源视频烧录可完成或取消**
  （操作）工具栏「烧录视频」按钮：选择保存位置（.mp4）并等待完成
  （预期）出现进度面板（烧录百分比随编码推进），可点「停止视频烧录」取消；完成后输出 MP4，画面带 ASS 样式字幕，时间轴与原视频一致
  <!-- id: full-burn-run -->
- [ ] **烧录使用当前 ASS 样式库**
  （操作）先在字幕样式里改字体/字号/颜色：重新烧录
  （预期）输出画面样式跟随当前 ASS 样式库设置，与「实际画面预览」一致
  <!-- id: full-burn-style -->
- [ ] **拒绝覆盖源视频和非 MP4 扩展名**
  （操作）保存位置选择器：输入与源视频同名或 .mkv 等非 mp4 扩展名
  （预期）出现红字提示且不开始任务（同名 / 扩展名两条提示）
  <!-- id: full-burn-conflict -->
- [ ] **字体缺字时中止并提示**
  （操作）样式库选一个缺字形的字体（如部分花体）：烧录含缺字文本的工程
  （预期）任务失败并提示「字幕字体…缺少字形…已中止烧录」，不产出带方框的视频
  <!-- id: full-burn-missing-glyph -->

## 人工核验：重组后烧录视频（去空隙）
<!-- id: manual-burn-gap -->
<!-- badge: todo 待核查 -->

准备：视频工程扫描静音空隙并移除若干段；与「重组后视频」（流复制）对比切点精度。

- [ ] **去空隙烧录菜单按媒体类型显示**
  （操作）去空隙导出菜单：移除空隙后展开菜单
  （预期）「重组后烧录视频」出现在「重组后视频」下方；音频工程中该项隐藏
  <!-- id: gap-menu-visible -->
- [ ] **重组烧录切点精确且字幕时间轴匹配**
  （操作）去空隙导出 → 重组后烧录视频：对同一工程分别导出「重组后视频」与「重组后烧录视频」，逐切点对比
  （预期）烧录版切点帧级精确（无关键帧对齐的提前/滞后），字幕出现时间与「去空隙 SRT/ASS」配套时间轴一致
  <!-- id: gap-burn-precise -->
- [ ] **跨空隙字幕随收缩时间轴正确平移**
  （操作）烧录结果播放：核对跨越移除区的字幕
  （预期）字幕随收缩时间轴平移，无原有空隙时间出现字幕残留
  <!-- id: gap-burn-subtitle -->
- [ ] **去空隙烧录可取消重试且任务互斥**
  （操作）烧录进行中：点击「停止视频烧录」
  （预期）任务取消、面板消失，可立即重新发起；同时发起「重组后视频」时两者互斥（一方运行另一方报 409 提示）
  <!-- id: gap-burn-stop -->

## 人工核验：相邻功能回归抽查
<!-- id: manual-regression -->
<!-- badge: todo 待核查 -->

- [ ] **视频流复制重组仍可用**
  （操作）去空隙导出 → 重组后视频：照常导出一个流复制重组视频
  （预期）行为与改动前一致（任务请求方法重构为共享助手后的回归确认）
  <!-- id: regress-gap-video -->
- [ ] **ASS 单帧实际预览仍可用**
  （操作）ASS 实际画面预览：暂停并渲染当前帧
  （预期）仍正常出图（同一 libass 探测缓存路径）
  <!-- id: regress-ass-frame -->
- [ ] **烧录按钮随 ASS 开关即时切换**
  （操作）ASS 字幕模式开关：反复切换 ASS 模式，观察工具栏按钮
  （预期）「烧录视频」按钮随开关即时显示/隐藏，无残留；其余 ASS 模式联动控件行为不变
  <!-- id: regress-ass-mode-toggle -->
- [ ] **烧录入口与进度面板英文文案完整**
  （操作）编辑器右上角切换 English：查看两个烧录入口与进度面板文案
  （预期）菜单项、进度、停止按钮与提示均有英文，无中文残留
  <!-- id: regress-i18n -->
- [ ] **音频工程保持导出功能且不显示烧录入口**
  （操作）音频工程：查看「更多导出」与「去空隙导出」菜单
  （预期）无烧录入口；「重组后音频」等原有功能正常
  <!-- id: regress-audio-project -->

## 后续操作步骤
<!-- id: next-steps -->
<!-- badge: fixed 说明 -->

1\. 核对完成后导出未确认项 JSON 回传；2. 需要改编码参数面板时在「烧录视频」工具栏入口上叠加（服务端已支持 requested encoder 扩展位）；3. 发布前统一重生成 blank-editor.html（本次未生成，改动均在源码与模板层）；4. CHANGELOG「未发布 → ✨ 提升」已登记「编辑器内烧录视频」条目。
