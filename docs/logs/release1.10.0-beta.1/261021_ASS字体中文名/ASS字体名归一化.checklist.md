---
task: ass-font-aliases
date: 2026-10-21
status: pending
---

# ASS 字体名归一化（得意黑 / Smiley Sans 兼容）

> 范围：libass 只按 nameID1 匹配字体导致的静默回退。本批改动：服务端字体别名表（maw/ass_fonts.py）+ 实机画面/烧录/编辑器导出三处归一化与告警 + ASS 字体下拉别名表驱动 + 预览别名链。基线 release1.10.0-beta.1（分支 fix/ass-smiley-sans-font-render）。

## 实现 / 审查结论

<!-- id: section-design -->

- 服务端别名表 `maw/ass_fonts.py`：注册表+目录扫描本机字体，聚合 nameID 1/4/6/16 全部别名；canonical 按「系统 UI 语言 → zh → en → 第一个」从 nameID1 选取；存储名已是该字体 nameID1 之一（libass 可直接命中）时不改写不告警。
- 归一化 choke point 在 ASS 文本层（只动 `Style:` 行第 2 字段），覆盖一切字体名来源；预览（DOM/canvas）输出 `"存储值", "canonical", "其余别名", sans-serif` 别名链。
- 已实测机制边界：libass 匹配任意语言 nameID1；浏览器匹配不可预测（Smiley Sans 与寒蝉点阵体行为互为镜像），故预览走别名链而非赌单一名字。详见账本 `TEST_FEEDBACK_ASS字体中文名.md` 事实矩阵。

## 修复记录

<!-- id: section-fixes -->

- 条目 1（静默回退无告警）：实机画面 warnings 追加「已按本机字体匹配为「得意黑」」/「未在本机找到」两类行；烧录经 `BurnSubtitleResult.warnings` 透传到 Launcher 工具箱完成消息。
- 条目 2（名字归一化）：`serve.py render_ass_frame_png`、`postprocess_ffmpeg.py run_burn_subtitles`（原始 .ass 写归一化临时副本，不改用户文件）、编辑器 .ass 导出（`GET /api/ass-font-aliases` 别名表 + 导出捕获窗口 + flashHint）。
- 条目 3（搜不到得意黑）：ASS 字体下拉并入别名表条目（value=label=canonical，aliases 参与搜索）；queryLocalFonts 扫描降级为兜底并按名字归并。
- 条目 4（中文名优先）：不再依赖硬编码表——canonical 由字体名字表按系统语言生成，任何有中文名的本机字体都会以中文名入选下拉。
- 协调审阅：修正桥接字体分组后的索引；按所属 face 保留 full/PS 别名的 nameID1 目标与既有可匹配字体名，避免不同字重合并成同一字体；补齐编辑器烧录最终 ASS 副本归一化、异步字体表先失效缓存后刷新和脚本装配契约。

## 自动化验证结果

<!-- id: section-auto -->

- `scripts/run_check.py` → `scripts/run_tests.py tests/test_ass_fonts.py tests/test_local_editor_server.py tests/test_postprocess.py tests/test_ass_styles.py tests/test_project_ass_export.py`：293 tests OK（含新增 21 个 `test_ass_fonts.py` 单测与 4 个 serve/burn 集成测试）。
- `node --test tests/test_editor_utils.mjs`：343 pass（含别名链/过滤/归一化新断言）。
- `pnpm run check:editor`：bundle 新鲜（已重建）。
- 真机冒烟（本机 ffmpeg + 真实字体表，`.artifacts/ass-font-test/smoke_normalize.py`）：`Smiley Sans` → 告警「已按本机字体匹配为「得意黑」」且渲染 PNG 与直接写「得意黑」逐字节一致（61517B）；`NoSuchFontXYZ` → 告警「未在本机找到」。
- 已知环境性失败：无。未验证边界：非中文 locale 机器对中文名 nameID1 的 libass 匹配未实测；旧服务器/便携页（无端点）降级路径有单测覆盖但未手工实测。

## 人工核验

<!-- id: section-manual -->

- [ ] **ASS 字体下拉显示并搜到「得意黑」**
  （操作）启动编辑器（serve.py 或 GUI）→ 打开 ASS 样式库字体输入框 → 分别输入「得意黑」与「Smiley」
  （预期）下拉出现「得意黑」条目；两种输入都能过滤到同一条目
  （说明）别名表是启动后异步拉取，页面刚打开的 1-2 秒内可能仍是旧列表
  <!-- id: check-dropdown-zh -->
- [ ] **选「得意黑」后实机画面与烧录渲染正确**
  （操作）ASS 样式字体选「得意黑」→ 打开实机画面窗口渲染一帧 → 再用工具箱烧录一小段
  （预期）画面为斜体得意黑；烧录完成消息无字体告警
  <!-- id: check-frame-render -->
- [ ] **存量工程（存了 Smiley Sans）自动归一化且有提示**
  （操作）打开字体名仍为 Smiley Sans 的旧工程 → 渲染实机画面 → 导出 .ass → 工具箱烧录
  （预期）实机画面 warnings 显示「字体「Smiley Sans」已按本机字体匹配为「得意黑」」；导出后 flashHint 提示替换，.ass 文件 Style 行 Fontname=得意黑；烧录完成消息含同一说明
  <!-- id: check-legacy-project -->
- [ ] **未安装字体的告警**
  （操作）ASS 样式填一个本机不存在的字体名（如 NoSuchFontXYZ）→ 渲染实机画面 → 烧录
  （预期）实机画面 warnings 显示「字体「NoSuchFontXYZ」未在本机找到，实际画面将回退为其他字体」；烧录完成消息包含同一告警且不中断出片
  <!-- id: check-missing-font -->
- [ ] **普通字幕外观不受影响**
  （操作）非 ASS 模式下打开普通字幕外观的字体选择与预览
  （预期）行为与改动前一致（预设/扫描/微软雅黑等显示名逻辑不变）
  <!-- id: check-normal-appearance -->

## 后续操作

<!-- id: section-followup -->

- 全部勾选后把 front-matter `status` 改为 `passed`（部分通过改 `partial`），运行 `build.py --scan docs/logs` 汇总。
- 账本 `TEST_FEEDBACK_ASS字体中文名.md` 与本清单同目录，收口时可按流程整理为 GitHub Issue。
