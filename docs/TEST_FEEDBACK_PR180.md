# TEST_FEEDBACK — PR #180 Review（Canvas 预览）

反馈来源：Moyf 在 [PR #180](https://github.com/Moyf/moys-asr-workflow/pull/180) 的审阅（审阅对象 `40d8cca5`，对照 base `d4e5dff2`）。结论：暂不 Squash & Merge，先处理渲染/接线回归并决定 3D 兼容方式，补迁移后的浏览器回归。

用户授权：审阅 PR；小问题直接修复后 Squash & Merge，复杂问题在 PR 反馈；合并前整理 CHANGELOG，只保留用户可感知的整体变化。

## 事实基线（恢复时先读）

```powershell
Get-Content -Raw docs\TEST_FEEDBACK_PR180.md
git status --short
git log --oneline origin/main..HEAD
```

- 分支 `feat/ass-subtitle-canvas-rendering`，已推送 origin，PR #180 OPEN。
- 审阅确认的方向（不改）：布局/绘制分离、复用行内格式与动画计算、行位图缓存、fade 只参与合成。
- e2e 运行方式：`npm test`（playwright，chromium project）。审阅者命令：
  `node_modules/.bin/playwright test tests/e2e/ass-export.spec.mjs tests/e2e/speaker-labels.spec.mjs tests/e2e/ass-frame-preview.spec.mjs --project=chromium --workers=1`
  （本 PR 27 过 / 8 挂；base 35/35 全过。）

## 问题清单

| # | 级别 | 问题 | 状态 | 处理记录 |
| --- | --- | --- | --- | --- |
| 1 | P1 | BS1 阴影未位移（`drawImage(layer, 0, 0)` 丢了 `(shad, shad)`）；BS3 的 pad 不含 shadow，底框阴影被裁切；阴影填充走 `fillText` 未走逐字符回退 | 已修复 | `rasterizeLine`：BS1 阴影层改为 `drawImage(layer, shadow, shadow)`；pad 统一 `outline + shadow + 2`，BS3 影框不再被截断；阴影填充统一 `paintItemText`。e2e 新增「影子相对文字偏移 ≥14px、BS3 蓝影超出红框 ≥20px」像素断言 |
| 2 | P2 | 显式空行被折叠：`A\n\nB` 与 `A\nB` 画布输出相同；空 fragment 不 measurer，行高 0 | 已修复 | `assCanvasLayoutLines`：非空文本中的空行按基准 run 的行盒占一行高（整条文本为空仍返回 0 高块）；新增 `A\n\nB` / 尾随 `\n` / 全空三组单测 |
| 3 | P2 | 叠加轨说话人标签消失：DOM 元素整体 hidden，Canvas 叠加轨 payload 未带 speaker | 已修复 | `applyAssSubtitlePreview` 按播放循环同源逻辑解析叠加轨标签与颜色传入 payload；e2e 新增叠加轨标签测试（`Host：` / `#c4a019` / 首行行首 / DOM 面不可见） |
| 4 | P1 | `\frx`/`\fry` 被静默取消（旧 CSS 有 perspective 近似） | 已修复 | Canvas 轴向透视缩短近似：`scale(fscx·cos(rotY), fscy·cos(rotX))`（>90° 自然镜像）；e2e 断言 `\frx90` 终点画布清空、中途保留可见动画；docs 明确为近似 |
| 5 | P1 | 既有 e2e 未迁移：ass-export / speaker-labels / ass-frame-preview 共 8 挂（DOM run/CSS 断言失效） | 已修复 | 全部迁移为渲染参数（`MaweAssCanvas.lastRender`）与画布像素断言，未删除行为覆盖；迁移后原 35 项 + 新增 3 项全过 |
| 6 | P2 | CHANGELOG 承诺过强（"整行一次成型""对齐 libass"），代码注释措辞同样过强（实为逐 run strokeText + 层级合成） | 已修复 | CHANGELOG 改用审阅建议的保守措辞；模块注释改为「逐 run strokeText 后作为整层单次 alpha 合成」 |
| 7 | 仅说明 | Windows PR 构建产物 bot 评论、greptile 试用到期提示、`ViewInvalidation.cueListPatch` typecheck 错误（base 同样存在） | 仅说明 | 无需改动 |
| 8 | 仅说明 | 未验证边界：跨浏览器/系统字体、4K/8K 性能、用户原素材；不声称 Canvas 与 libass 完全等价 | 仅说明 | PR 描述与文档不做等价承诺 |
| 9 | 附带 | 全量 e2e 后残留 12 个 serve.py 进程导致命令挂起 10 小时+（cue-scroll 共享 fixture 的 server 泄漏，正常结束也会残留） | 已修复（流程） | 新增 [docs/E2E_SERVER_HANG.md](E2E_SERVER_HANG.md)：诊断/清理命令与运行纪律，AGENTS.md 增设 e2e 运行纪律小节；fixture 生命周期的治本修复留待后续 |

## 验证账本

- `node --test tests\test_ass_canvas_layout.mjs`：5 组（含空行/尾随换行/全空）全过。
- `npx playwright test tests/e2e/ass-export.spec.mjs tests/e2e/speaker-labels.spec.mjs tests/e2e/ass-frame-preview.spec.mjs --project=chromium --workers=1`：**38/38 全过**（原 35 迁移 + 3 新增：阴影位移/BS3 裁切、`\frx` 塌缩、叠加轨标签）。
- 全量 `npx playwright test --project=chromium`：**486/486 全过（6.5 分钟）**。
- `npx playwright test tests/e2e/multi-subtitle.spec.mjs tests/e2e/overlay-track.spec.mjs`（迁移后锚点/opacity 断言）：121/121 全过。
- `uv run --no-sync python -m unittest tests.test_editor_assets`：23/23 全过。
- `git diff --check`：干净。

## 收尾汇总

- **已修复**：审阅 #1–#6 全部处理完毕（见上表处理记录与验证）；#9 为修复过程中发现并文档化的流程问题。
- **仅说明**：#7、#8；另有「全量 e2e 正常结束也会泄漏 fixture server」的治本修复（cue-scroll fixture 生命周期）未在本次实施，已写入文档待办。
- **未验证边界**：跨浏览器 / 系统字体差异、4K–8K 分辨率性能、用户真实素材；`\frx/\fry` 近似不含透视斜切（与旧 CSS perspective 行为有差异，已在文档声明）。
- **未重生成** `blank-editor.html`（按仓库约定，发布前统一重生成）。
