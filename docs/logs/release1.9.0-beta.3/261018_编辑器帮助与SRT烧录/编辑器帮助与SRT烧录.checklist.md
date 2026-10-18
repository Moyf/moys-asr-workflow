---
task: editor-help-srt-burn
pr: 268
date: 2026-10-18
status: pending
---

# 编辑器帮助、SRT 烧录与字符包裹核验

> 初始实现基线 38eec454，本轮同步 main 至 efe12061。自动化验证与维护者人工验收分别记录；本页人工项保持待确认。

## 实现与审查结论
<!-- id: help-srt-scope -->

四页精简帮助分别介绍 ASS 样式、双语字幕、导出与烧录、标记与区段；对应设置与工具窗可直达。当前指南和官网统一使用“双语字幕”，历史日志保留原称。

关闭 ASS 模式时，当前 SRT 通过共用转换器应用样式库的 SRT 烧录槽位，画布及字号按源视频分辨率换算；转换和编码受同一媒体任务管理。ASS 导出方案、视频绑定、进度、停止与流式保存沿用既有机制。

包裹字符按当前单双符号规则识别已有淡入淡出，补齐单侧时复用已有符号。右键、自定义及批量预览与执行共用处理逻辑，保留震动等已有句级外层。

## 修复与提交记录
<!-- id: help-srt-changes -->

已修复：帮助缺少专题与入口、当前文档名称不一致、关闭 ASS 后不能烧录视频、单符号及单侧淡入淡出包裹失效。音频绿幕不在本次实现范围；内联副本待发布前统一重生成。

CI 复查：初次 Windows 预览构建在全量 Python 的页面契约检查失败，旧断言未计入四页帮助、四个入口及十个内容分组。已同步预期数量，并确认新增帮助导航与内容 ID 唯一、存在直达入口；应用源码未改动。复查时没有 PR 评论、行内意见或审查提交。

同步主线：以 `7f392736` 为分支起点普通合并 main `efe12061`，唯一文本冲突为日志索引，双方记录均保留。首句时间码修复的四个文件与 `7f392736` 完全一致；烧录显式使用 `alignFirstStart: false`，独立字幕文件导出仍遵循“首条字幕时间从 0 开始”。主线的工程切换意图、保存绑定校验、媒体加载与旧任务失效保护一并保留。

## 自动化验证
<!-- id: help-srt-automation -->

代码验证对应分支 `code/editor-help-srt-burn-20261018`，代码提交 `2d95d7a3`，其后仅回填本清单。以下命令均从仓库根目录经 `python scripts/run_check.py --timeout 240 --` 包装执行，Python 使用匹配锁文件的环境，浏览器显式指定已安装的 Chromium。

| 层次 | 命令与范围 | 结果 |
| --- | --- | --- |
| Node | `node --test tests/*.mjs` | 832 通过、0 失败；1 项 POSIX 进程组测试在 Windows 跳过 |
| Python | `python scripts/run_tests.py tests.test_burn_video_export tests.test_postprocess.MediaToolTests tests.test_ass_styles` | 71 通过，包含真实 FFmpeg 的普通／去空隙 SRT 样式与字幕时间、转换子进程取消清理 |
| 浏览器 | `node node_modules/@playwright/test/cli.js test tests/e2e/editor-help-srt-burn.spec.mjs tests/e2e/burn-video-jobs.spec.mjs tests/e2e/green-screen-export.spec.mjs tests/e2e/ass-frame-green-screen.spec.mjs --project chromium --workers 1 --reporter line` | 21 通过；覆盖帮助四入口、中英和窄窗口、包裹与撤销、SRT 保存及现有绿幕功能 |
| 文档 | `python scripts/check_docs.py`；`python scripts/run_tests.py tests.test_docs_check` | 检查通过；22 项回归通过；6 条既存历史日志未登记提示 |
| 构建与静态 | `node scripts/build-editor.mjs --check`；`node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json`；`ruff check maw/postprocess_ffmpeg.py server-editor/serve.py tests/test_burn_video_export.py` | 全部通过 |
| 官网 | `node website/node_modules/astro/bin/astro.mjs check --root website`；同入口 `build --root website` | 0 错误／警告；22 页构建通过 |

四个新增帮助入口的相邻控件水平间隔均实测至少 8px，涉及面板截图已检查。原始结果保存在本地 `.artifacts/checks/`；Node、Python、浏览器最终结果分别为 `20261017T164844Z-d294e365`、`20261017T164853Z-f8f34ace`、`20261017T164845Z-5b3eb809`。初轮沙箱临时文件／Git 权限及未指定浏览器导致的环境失败，已在明确指定 Python、浏览器和临时目录后复跑通过。自动化结果不代表下列人工项已确认。

本轮同步 `efe12061` 的组合验证另行记录，不沿用旧提交的 CI：

- 首句修复的导出器、烧录接线、Node 与浏览器回归四文件相对 `7f392736` 无差异；首句导出设置开启时，测试确认普通烧录保留 900ms、去空隙烧录保留映射后的 130ms，而独立字幕文件仍从 0 开始。
- Node 全量 `node --test tests/*.mjs` 首轮 844 通过、1 项驱动程序就绪超出原 15 秒上限、1 项 POSIX 平台跳过（`20261018T043033Z-80e1a108`）。该超时项以原代码、原断言、原时限隔离复验 1/1 通过、约 1.6 秒（`20261018T043341Z-d7a61e9c`）；保留两轮结果，不把首轮记为全绿。
- Chromium 的烧录、帮助、工程异步切换、绿幕导出与绿幕实际帧五 spec 共 35/35 通过（`20261018T043032Z-d41c6059`），包括 ASS／SRT 普通与去空隙烧录的 `alignFirstStart: false` 请求。
- Python 全量 `python scripts/run_tests.py` 共 2562 项、0 失败、31 项跳过（`20261018T043029Z-c614d38d`）。
- Editor 重建／新鲜度、TypeScript、Ruff、文档检查通过；文档仍为六条已有日志索引提示。

## 人工核验
<!-- id: help-srt-manual -->

- [ ] **烧录首句保持媒体时间码**
  （操作）开启“首条字幕时间从 0 开始”，使用第一句在播放开始一段时间后才出现的工程，分别检查 ASS／SRT 模式的普通烧录与去空隙烧录，并另行导出字幕文件。
  （预期）烧录字幕只在原时间或去空隙映射后的时间出现，不提前到第零帧；独立字幕文件仍按设置将首句延长到 0，设置值本身保持。
  <!-- id: help-srt-first-cue -->

- [ ] **帮助入口直达正确页面且保留原窗口**
  （操作）工程设置 → 字幕样式／双语字幕、全局设置 → 字幕导出，以及标记与区段工具窗，分别点击“帮助”。
  （预期）帮助选择对应页面；原窗口保持打开；ASS 帮助位于分组右上角，与相邻控件有间隔。
  <!-- id: help-srt-entrances -->

- [ ] **中英文帮助在窄窗口可完整阅读**
  （操作）依次浏览四页帮助，切换英文并缩窄窗口。
  （预期）正文与标题同步翻译，无横向溢出，目录可访问全部分区。
  <!-- id: help-srt-language -->

- [ ] **当前文档与官网采用双语字幕名称**
  （操作）查看当前双语指南、文档索引和官网侧栏。
  （预期）相关标题与正文显示“双语字幕”，原有链接仍可打开。
  <!-- id: help-srt-naming -->

- [ ] **关闭 ASS 后使用 SRT 烧录槽位**
  （操作）在样式库为 SRT 烧录槽位选用易辨认的字体、颜色与字号，ASS 输出方案另选不同样式；关联视频、关闭 ASS 模式并烧录。
  （预期）输出 MP4 采用 SRT 槽位样式，字幕文字与时间为当前编辑结果，不误用 ASS 方案；源文件不被覆盖。
  <!-- id: help-srt-default-style -->

- [ ] **去空隙 SRT 烧录与收缩时间轴一致**
  （操作）关联有声音的视频并移除若干空隙，关闭 ASS 模式，选择“去空隙导出 → 重组后烧录视频”。
  （预期）输出采用 SRT 烧录样式；切点附近字幕与音画同步，没有重复扣除空隙时长。
  <!-- id: help-srt-gap -->

- [ ] **停止与更换工程不保存旧任务结果**
  （操作）烧录长视频，在进度窗口停止；再次发起，在保存选择器等待期间更换工程或解绑媒体。
  （预期）停止后完成清理；旧任务不提交文件，按钮恢复可用，不能把旧字幕烧到新媒体上。
  <!-- id: help-srt-cancel -->

- [ ] **单符号淡入淡出包裹后仍位于最外侧**
  （操作）特殊文本规则选择“单双皆可”，对 `>文字<` 通过右键、自定义和批量面板添加 `++`，再撤销；切换“双个符号”重复操作。
  （预期）单双皆可得到 `>++文字++<`，预览与执行一致且可撤销；双个符号下单个尖括号按字面保留。
  <!-- id: help-srt-single-fade -->

- [ ] **补齐单侧淡入淡出不重复已有符号**
  （操作）对 `>>文字` 和 `文字<<` 添加“淡出淡入”，再重复应用；另外检查含震动和强调的组合。
  （预期）两例均得到 `>>文字<<`，重复应用不再增加符号；原有震动、强调与正文保持，可撤销恢复。
  <!-- id: help-srt-complete-fade -->

## 后续操作
<!-- id: help-srt-next -->

维护者在真实工程完成上述核验后再更新人工状态；保留主线已有绿幕导出入口。真实原生文件选择器、目标播放器、硬件编码与跨平台发行包仍需单独验收。
