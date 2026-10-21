# 测试反馈账本：ASS 字体名兼容（得意黑 / Smiley Sans）

基线：`release1.10.0-beta.1`（HEAD b4b604a7），分支 `fix/ass-smiley-sans-font-render`。
反馈渠道：维护者会话实测（2026-10-21）。状态取值：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。

## 问题清单

| # | 问题 | 状态 | 核实结论/方案 |
|---|------|------|--------------|
| 1 | ASS 实机画面与视频烧录无法渲染「得意黑」（Smiley Sans）：编辑器 CSS 预览显示正常（斜体），实机画面/烧录输出回退为正体默认字体，且无任何警告。维护者样式里存的 Fontname 是 `Smiley Sans`；改成「得意黑」后渲染正常（维护者 2026-10-21 实测确认） | 已修复 | 已定性：libass（`directwrite (with GDI)` 提供器）按 nameID 1（GDI 兼容 family）匹配，`Smiley Sans`（nameID 16 排版名）不匹配 → 静默回退 ArialMT/雅黑（西文字形齐全连缺字形告警都没有）。修复：实机画面/烧录归一化 + 「已按本机字体匹配」/「未在本机找到」告警（serve.py、postprocess_ffmpeg.py + BurnSubtitleResult.warnings 透传 Launcher）。真机冒烟：Smiley Sans 归一化后渲染 PNG 与直接写得意黑逐字节一致 |
| 2 | 渲染/导出时字体名归一化：把输入名规范化成 libass 可匹配的名字再写进 ASS（维护者已批准实施） | 已修复 | `maw/ass_fonts.py` 别名表 + `normalize_ass_text_fontnames`；三处接入：实机画面（serve.py render_ass_frame_png）、烧录（run_burn_subtitles，原始 .ass 写归一化临时副本不改用户文件）、编辑器 .ass 导出（`GET /api/ass-font-aliases` + 导出捕获窗口 + flashHint）。表不可用时全链路降级为现状 |
| 3 | ASS 样式字体下拉搜不到「得意黑」：手填「得意黑」可正常渲染，但下拉（本机扫描）只有英文名 | 已修复 | queryLocalFonts 返回的是浏览器视角的 family 名（本机：有 en 条目的字体返回 en，如 SimSun），得意黑的浏览器名是 `Smiley Sans`，所以列表里没有「得意黑」。修复：下拉并入服务端别名表条目（canonical 显示、aliases 参与搜索），queryLocalFonts 扫描降级为兜底并按名字归并 |
| 4 | 既有需求「有中文名的字体优先用中文名」：寒蝉点阵体显示中文，大部分字体仍是英文 | 已修复 | 核实：现有中文名逻辑只有 `web/shared/utils/fonts.js` 的 `SUBTITLE_FONT_FAMILY_DISPLAY_NAMES_ZH` 硬编码表（微软雅黑/宋体等十几个系统字体），不含扫描字体。寒蝉点阵体显示中文是因为它的名字表 **en-US 槽位登记的就是中文**（`寒蝉点阵体 16px`），浏览器只能返回中文。修复：ASS 下拉的 canonical 由服务端字体名字表按系统 UI 语言生成，任何有中文名的本机字体都以中文名入选；普通字幕外观（纯 CSS 域）不受影响 |

## 字体名方案（2026-10-21 设计定稿，待维护者确认范围）

### 实测事实矩阵（本机 zh-CN，D:\Apps gyan ffmpeg 8.1 与 scoop 9.0.2 行为一致）

| 名字（SmileySans-Oblique.ttf / ChillBitmap_16px.ttf） | libass 实机画面/烧录 | 浏览器 CSS 预览 |
|---|---|---|
| `得意黑`（nameID1-zh，与 nameID16-zh 同文） | ✓ | ✓ |
| `Smiley Sans`（nameID16-en） | ✗ → ArialMT | ✓ |
| `Smiley Sans Oblique`（nameID1-en） | ✓ | ✗ |
| `SmileySans-Oblique`（PS 名） | ✓ | ✗ |
| `寒蝉点阵体 16px`（nameID1，en-US 槽位=中文） | ✓ | ✓ |
| `寒蝉点阵体`（nameID16） | ✗ → ArialMT/雅黑 | ✗（两个渲染器都不认） |
| `ChillBitmap_16px`（PS 名） | ✗ | — |

结论：**libass 稳定匹配 nameID 1 的任意语言变体；浏览器匹配规则无法用单一规律预测（1/16 互有成败）**。两端通吃的名字只在「nameID1 与 nameID16 存在同文字符串」时必然存在（得意黑恰好满足：中文名两边相同）。queryLocalFonts 返回浏览器视角名字，不能当中文名来源。OS/2 USE_TYPOGRAPHIC_NAMES 位与浏览器行为无关（两字体该位相反、行为也相反）。

### 方案：服务端字体别名表为单一事实源

A. 新模块 `maw/ass_fonts.py`：fontTools 扫描本机字体（Windows 走 HKLM/HKCU Fonts 注册表 + 字体目录兜底，复用 `maw/lottie_glyphs.py` 的枚举与 name 表读取），输出每个字体的全部 family 别名（nameID1 各语言 + nameID16 + full/PS），并提供 `resolve(name) -> canonical`：命中任意别名 → 返回 nameID1 中按系统 UI 语言优先的名字（zh 系统取中文名）；完全未命中 → None。进程内缓存。

B. 渲染端归一化（choke point 在 ASS 文本层，覆盖一切来源）：
   - `serve.py render_ass_frame_png`（实机画面）：写 frame.ass 前归一化所有 Style 行 Fontname；
   - `postprocess_ffmpeg.py` 烧录：SRT 转换产物、工程转换产物、原始 .ass（写归一化临时副本）统一处理；
   - 编辑器 .ass 下载导出（JS buildAss）：新增 `GET /api/ass-font-aliases` 别名表，编辑器拉取缓存后写 Style 时查表（旧 server/便携页无端点时优雅降级）；
   - 告警（条目 1）：归一化发生替换 → 信息级提示「已匹配为本机字体『得意黑』」；未命中 → 警告「字体『X』未在本机找到，将回退为其他字体」；现有缺字形告警保留。

C. ASS 字体选择器（条目 3/4）：下拉数据源 = 内置建议 + 服务端别名表（canonical 中文名优先）+ queryLocalFonts 扫描兜底；显示 canonical、按别名搜索（「得意黑」「Smiley」都能搜到同一条）；选中存储 canonical。普通字幕外观（纯 CSS 域）与 `SUBTITLE_FONT_FAMILY_DISPLAY_NAMES_ZH` 不动。

D. 预览别名链：ASS 预览（DOM 与 canvas）的 font-family 输出 `<stored>, <canonical>, <其余别名>, sans-serif`，规避浏览器匹配不可预测性。

### 边界/风险

- libass 在非中文 locale 机器对中文名 nameID1 的匹配未验证（本机 en/zh nameID1 均匹配，libass 疑似遍历多名字，风险低）；归一化按本机 UI 语言优先取名，自带适配。
- 归一化仅对本机已安装字体生效；未安装字体的 ASS（分享场景）原样保留并告警。
- 无 server 环境（便携页直开）编辑器导出无法归一化，维持现状。

## 阶段汇总

- 协调审阅（2026-10-22）：桥接合并字体分组后修正后续分组索引，避免下一字体查找越界导致整张别名表降级。每个 full/PS 别名保留所属 face 的 nameID1 目标；共享排版名稳定采用首次选择，已可匹配的 nameID1 原样保留，避免 Semibold 变成 Regular。该映射连同 family 透传前端，预览别名链仅使用同一目标的名字，下拉按 face 分列，搜索 Semibold 或其 PS 名时选中相应字重。
- 协调审阅（2026-10-22）：编辑器整段/去空隙/绿幕烧录的最终任务 ASS 副本也在服务端归一化，补齐前端字体表尚未加载与 SRT 转换后的路径；只改任务副本的 Style 字体名，不动内联斜体标签。字体表加载时先失效预览排版/度量缓存，再刷新暂停画面。补齐脚本装配预期清单，保留严格顺序断言。
- 本轮回归先在旧实现失败复现：分组越界、Semibold family/full/PS 错写为 Regular、编辑器 ASS/SRT 烧录绕过字体归一化、缓存刷新早于失效。修复后字体与直接烧录 24 项、真实 JS 字体接线/导出与暂停画面首刷 2 项通过；其余组合验证由本轮协调审阅记录补充。非中文 locale、旧服务器和原生界面仍保留原人工核验边界。
- 本轮分层验证：Node 字体/导出/脚本语法与顺序 353 项全部通过；Python 字体、服务器、后处理、样式、工程 ASS、装配/清单、烧录相关组共 375 项，唯一 error 为 `test_reapeaks_loading_is_deferred_until_server_is_serving` 的首页请求 1 秒超时（单跑同样超时），另 2 跳过；保留失败原状，未把局部结果记为整组通过。TypeScript、Ruff、两套 bundle 构建/新鲜度、文档链接与核验清单语法通过；远端 CI、原生界面与跨平台由最终协调记录单独确认。
- 合入经审阅的工程音量累计提交 `a7c56b20` 后：字体/装配/清单/直接烧录 67 项通过（2 跳过），音量/字体/导出 Node 368 项全部通过，TypeScript、Ruff、bundle 新鲜度和文档检查通过。新增组合断言确认最终任务 ASS 字体名已归一化、内联斜体标签保留、工程增益仅提交一次固定 `volume`；真实 FFmpeg 与最终三 PR 组合另由协调核验。

- 续 1（2026-10-21）：条目 1 调查闭环（复现矩阵 + 机制定性），维护者确认「改得意黑可渲染」；批准条目 1、2 实施。新增条目 3、4。方案设计与实施待续。
- 续 2（2026-10-21）：条目 3、4 调查闭环（queryLocalFonts 行为 + 硬编码中文名表 + 寒蝉点阵体名字表实锤）；浏览器/libass 匹配矩阵补齐（含寒蝉点阵体镜像反例、PS 名反例），方案 A-D 定稿。待维护者确认范围后派发实施。
- 续 3（2026-10-21）：维护者确认范围——编辑器导出 .ass 也归一化（新增 /api/ass-font-aliases 端点）、ASS 字体下拉改为别名表驱动并显示/存储中文名 canonical。方案 A-D 全部批准，实施派 general 子代理执行（条目 1-4 均「进行中·实施派发」），主会话完成后核对 diff 与验证再改「已修复」。
- 续 4（2026-10-21）：实现子代理被 5 小时用量限额中断，但 A-D 代码已全部落盘（17 个修改文件 + 3 个新文件，bundle 已重建）。主会话核对：diff 与规格一致；`run_tests.py`（test_ass_fonts / test_local_editor_server / test_postprocess / test_ass_styles / test_project_ass_export）293 OK；`node --test tests/test_editor_utils.mjs` 343 pass；`check:editor` 新鲜；真机冒烟（.artifacts/ass-font-test/smoke_normalize.py）三态验证通过。`git diff --check` 与个人路径检查干净。条目 1-4 改「已修复」（待维护者人工核验清单确认，见同目录 `ASS字体名归一化.checklist.md`，HTML 已生成 .artifacts/ass-font-test/verification.html）。未验证边界：非中文 locale 机器、旧服务器/便携页降级（有单测覆盖）。改动未提交，待维护者 review。
