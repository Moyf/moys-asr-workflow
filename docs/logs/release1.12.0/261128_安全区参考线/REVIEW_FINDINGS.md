# 安全区参考线 · 提交前自审（实现者自检）

- 日期：2026-11-28
- 分支：`Moyf/maw-safe-area-guides`（基线 = origin/main `ba9f33b3`，无落后提交）
- 范围：MAWE 播放预览新增「显示安全区参考线」（Premiere 风格 5% / 10% 双框 + 内框中点刻线）

> 说明：本记录由实现 Agent 在工作树内完成自检与验证。AGENTS 要求的「未参与实现的审查者通读 diff」
> 一轮由后续 PR 评审承担（本任务以「留待评审」交付，且派发约束禁止本会话再派子代理）。
> 以下 finding 均带证据（文件:行 + 实际执行的命令与结果）。

## 结论

无 blocker / major。3 条 nit / 接受的取舍，逐条如下；均已处置或明确接受并写入交付说明。

## 后续独立审查处置（2026-11-28 第二轮）

协调者复审原提交（e41294ee）后提出三项后续项，处置如下：

### R1 · 已处置 · 补监听 HTMLVideoElement 的 `resize` 事件

- 问题：`editor-safe-area-guides.js` 的 observePlayer 只听 `loadedmetadata` / `emptied` 并观察元素
  布局尺寸；播放器盒不变而固有尺寸变化（流中途变画幅）的场景没有刷新来源。
- 处置：监听列表加入 `resize`，换出元素同步解除（`for (const name of ['loadedmetadata', 'emptied', 'resize'])`）。
- 验证（真实素材、无事件 mock）：ffmpeg libvpx-vp9 编码两段不同分辨率（640×360 / 360×640）WebM
  用 concat demuxer 拼接成变画幅素材；真实编辑器页播放跨过 2s 切换点，Chromium 恰好触发一次
  元素 `resize`（640×360 → 360×640），参考线随新 contain 矩形刷新，实测
  `layer {left:134.95, width:106.88, height:190}` vs 期望 `{left:134.96, width:106.88, height:190}`。
- 红绿双向验证与一个重要实测发现：**默认 wave-right 布局下，固有尺寸变化会连带元素盒轻微重排
  （ResizeObserver 实测 377x186 → 377x190），仅移除 resize 监听时用例不会变红**——RO 只是碰巧
  兜住。因此 e2e 用例先内联钉住视频元素盒高度（固定盒是真实布局形态，事件仍由浏览器真实触发），
  隔离出「盒不变而固有尺寸变化」的纯 resize 场景：
  - 红（移除监听 + 固定盒）：`follows a mid-stream resolution change` 1 failed（参考线停留在
    旧横屏矩形）；
  - 绿（恢复监听）：同用例 passed，全 spec 8 passed。
- 该场景固化为 e2e 用例「follows a mid-stream resolution change via the video element resize event」
  （无 libvpx-vp9 编码器时 `test.skip`）。

### R2 · 已处置 · 删除未消费的门面与状态

- 问题：`guidesService.refresh`、`window.MaweSafeAreaGuides` 与 `editor-globals.d.ts` 的
  `MaweSafeAreaGuides` 声明均无消费方（git grep 证实）。
- 处置：三者删除；保留 `guidesService.ready` 守卫与 `observeSafeAreaGuidesPlayer` 导出
  （`editor-media-playback.js` 的媒体重绑通路继续消费）。CHANGELOG 条目按「面向用户的一句话」
  简化，画幅/刻线/不拦截指针等细节已在 `docs/user/EDITOR_GUIDE.md` 第 6 节。

### R3 · 已处置 · F3 记录更正

- 见上文 F3「已更正」小节：原「PlayRes 改变暂停 PNG 画幅导致错位」的说法经源码与双路实测否定，
  已改为更正记录；无需改动 ASS 渲染器或独立窗口。

## Findings

### F1 · nit（已处置）· 纯白画面上白芯不可见，黑晕对比不足

- 现象：首版描边为白芯 `rgba(255,255,255,.85)` + 黑晕 `rgba(0,0,0,.45)`；在纯白素材上白芯与背景同化，
  黑晕合成后约 140/255 灰度，像素检测（阈值 <90）完全找不到线条。
- 证据：`.artifacts/analyze-safe-area.py` 首轮输出 `white-footage: vertical_lines=[] horizontal_lines=[]`。
- 处置：加深为白芯 `.95` + 黑晕 `.6`（`web/editor.css` 的 `.safe-area-rect` / `.safe-area-tick` 规则）。
  复测（阈值放宽到 <150 对应 H.264 limited-range 白 ≈235）：
  `white-footage: vertical_lines=[(39,39,1),(55,55,1),(320,320,1),(337,337,1)] horizontal=[(8,8,1),(18,18,1)]`，
  位置与 5% / 10% 预期一致。接受残留：纯白画面上参考线呈中灰细线（Premiere 同类做法）。

### F2 · 接受的取舍 · z 序在字幕预览层之下

- 决策：参考线 `z-index: 5`，低于 CSS 字幕预览层 `#overlay` 的 `z-index: 10`（`web/editor.css`）。
  CSS 预览的默认字幕底衬（黑 @65%）会把其后的线段压暗到约 35% 对比度。
- 理由：字幕可读性优先；ASS 模式的 Canvas 文本无底衬，参考线完全可见；e2e 断言了
  `pointer-events: none`、实际帧状态下仍可见（`tests/e2e/safe-area-guides.spec.mjs` 第 7 个用例）。
  若评审倾向 Premiere 的「参考线盖在一切之上」，把 z-index 提到 10 以上即可，属一行改动。

### F3 · 已更正（2026-11-28 复核）· PlayRes 与暂停实际帧画幅

- 首轮记录曾称「工程把 ASS 分辨率自定义成与素材宽高比不同时，暂停实际帧与参考线的框会错位」。
  **复核后该说法不成立，予以更正**：
  1. 渲染端：`server-editor/serve.py` 的 `render_ass_frame_png`（1430-1469 行）视频路径滤镜只有
     `format=rgb24,ass=filename='frame.ass'`（1467 行），不做任何按 PlayRes 的缩放输出；
  2. 预览端：`currentAssVideoResolution()`（`web/editor/io/editor-export-srt.js:269`）始终取
     媒体元数据 / 播放器固有尺寸，预览 ASS 的 PlayRes 本来就等于素材分辨率。
- 实测证据（沿用真实 ASS 暂停帧流程，见 `.artifacts/verify-safe-area-playres.mjs`）：
  - UI 流程：ASS 模式 + 实际画面窗口标题报告 `00:02.000 · 640 × 360 · 无损 PNG`（= 视频尺寸）；
  - 同一 `/api/ass-frame` 端点提交 PlayRes 1920×1280（3:2，与 16:9 素材不同比）的 ASS 脚本，
    返回 PNG 实测仍为 640×360。
- 结论：暂停 PNG 画幅恒等于视频画幅，与视频矩形锚定的参考线不会因 PlayRes 产生错位；
  不需要为此改动 ASS 渲染器或扩展独立窗口。

### F4 · nit（已核对，非缺陷）· EN 模式下 `el.title` 为空

- 现象：EN 语言下开关 label 的 `title` 属性读出空串。
- 排查：`translateText('在视频画面上叠加 5% …', 'en')` 直接返回正确英文（node vm 直测）；
  根因是共享 tooltip 把 `title` 转存为 `data-title`（`web/shared/editor-i18n.js` 的
  translateAttributes 注释），实测 `data-title` 为
  `"Overlay 5% and 10% safe area guides on the video to judge how far subtitles sit from the frame edges"`。
  与既有开关行为一致，不需要改动。

## 验证摘要（实际执行的命令与结果）

- 构建 / 静态：
  - `pnpm run build:editor` → `Editor: 121 ESM factories / 156 sources`；`pnpm run check:editor` → `Editor bundle is fresh`。
  - `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` → 2 pass。
  - `node --test tests/test_editor_utils.mjs` → 374 pass（含新增 safeAreaGuidesEnabled 归一断言）。
  - `node --test tests/test_editor_bundle.mjs tests/test_editor_domains.mjs tests/test_editor_module_loader.mjs tests/test_ass_preview_refresh.mjs` → 全部 pass。
  - `pnpm run typecheck` → 无输出（通过）。
  - `python -m unittest tests.test_editor_assets tests.test_editor_manifest` → 34 tests OK
    （曾失败一次：清单契约测试要求登记新文件，已把 `editor-safe-area-guides.js` 加入
    `tests/test_editor_assets.py` 预期集合后复验通过）。
  - `uv run --no-sync ruff check` → 通过；`git diff --check` → 干净；
    `python scripts/check_personal_paths.py --diff-ref origin/main` → 无命中。
  - `uv run --no-sync python scripts/prepare_release_notes.py --check-all` → `Release documents checked: 25`。
- e2e（`scripts/run_check.py` 包裹，Chromium headless）：
  - `tests/e2e/safe-area-guides.spec.mjs` → **7 passed**：
    1) 全新偏好默认关闭，开启后几何 = 实际绘制矩形 ±1.5px、外框 5% / 内框 10% 结构断言、
       刻线 4 条落在内框中点、`pointer-events:none`、`elementFromPoint` 命中 video 且点击可切换播放；
    2) 刷新后偏好记忆；3) 竖屏留黑（层盒 107px < 元素 377px，宽高比 ≈ 9:16）；
    4) 纯音频保持隐藏；5) 全屏进入/退出几何跟随（Δ=0px）；6) 走真实
       `#load-media-file` → `loadMediaFile` 路径切换媒体后参考线重新锚定新画幅；
    7) `ass-stage-ready`（暂停实际帧叠加）下 `#overlay` 隐藏而参考线可见、z 序压过实际帧。
- 真实浏览器交互（`.artifacts/verify-safe-area.mjs`，server-editor + Playwright）：
  - 设置页间距实测：新开关与上一行「预览表情包」`gapPx: 8`、`fontSize: 12px`（≥11px 达标）。
  - 横屏留黑几何 Δ：left 0.003px / width 0.01px；全屏 Δ：0px。
  - 偏好与工程隔离：仅切参考线开关（开→关→开）`hasProjectChanges` 恒为 false、
    `previewGeometryDirty` 恒为 false（`.artifacts/verify-safe-area-dirty.mjs` 输出），
    localStorage `safeAreaGuidesEnabled` 正确写入。此前脚本里出现的 `projectDirty:true`
    归因为同页开启了 ASS 模式（既有行为），与参考线无关。
- 像素级自查（`.artifacts/analyze-safe-area.py` / `-more.py`，PIL 检测 1px 亮线 / 暗线）：
  - 白底素材、横屏 testsrc2、竖屏、ASS 即时预览、暂停实际帧、全屏六张截图均检测到参考线，
    且坐标与 5% / 10% 预期一致（横屏竖线 x=40/56/319/336、横线 y=9/19）。
- 文档一致性：CHANGELOG `[未发布]` 新条目 + `docs/user/EDITOR_GUIDE.md`（设置表行 + 预览章节）；
  `prepare_release_notes.py --check-all` 通过。

## 未验证 / 边界

- layout-classic（元素盒即画面、无留黑）未单独跑 e2e：几何公式与 wave-right 同源
  （元素盒 contain 数学），wave-right 留黑与全屏两个更难场景已覆盖。
- 真实全屏在 headless Chromium 完成，未做带窗口管理器的实机全屏；交互验证为自动化浏览器，
  人工肉眼观感（线的粗细 / 颜色偏好）留给 PR 评审。
- 未参与实现的独立审查轮按任务约束留给 PR 评审（见顶部说明）。
