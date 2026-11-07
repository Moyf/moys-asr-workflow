# 放大出现动画方向修复（`{{单句放大出现}}`）

基线：`fix/pop-in-scale-direction`（branch-off main @ `f3f45273`）。worktree 只提交本分支，不 merge、不 push。

## 现象与根因

维护者反馈 `{{单句放大出现}}` 是「先出现再缩小」，期望「先出现（小）再放大到原字号」。261021 排查结论（语义反转 + 放开 fromScale < 1 + 排查结尾跳回）经本次代码复核后落地：

- **方向做反**：旧默认 `fromScale = 1.4`，发射 `\fscx140…\t(…,\fscx100…)`，即从 140% 缩小落定——「放大出现」名不符实。修复：默认改 `0.8`（80% → 100% 单调放大）。
- **fromScale < 1 被四处钳死**：发射门 `Number(pop.fromScale) > 1`（`ass-animation.js`）、预览门同式、归一化钳制 `[1,10]`（JS `normalizeAssAnimations` 与 Python `_normalize_animation`）、UI 输入 `min="1"`。全部放开到允许 < 1，下限 0.3（防 0/负值），上限 10 不变；`fromScale = 1` 无视觉变化，仍不发射标签。
- **结尾跳回（261021 疑似多组 `\t` 打架）**：对照 libass 源码（`ass_parse.c` `\t` 处理）复核确认——`\t` 在 `t ≥ t2` 后 `k = 1` 恒取目标值，负 t1 按 `(t − t1)/delta_t` 正确推进；显式起点 `\fscx` + 单条 `\t` 对任意 fromScale 都不会跳回。pop 与自定义变换并存时 libass 按标签序链式生效（后一条从当前值走向目标），导出语义正确。**真正的偏差在 Canvas 预览补偿公式**：`assPreviewStyleAt` 的 `Math.max(1, popScale)` 钳制是旧语义（popScale 恒 ≥ 1）下的防御性 no-op，fromScale < 1 时把补偿缩放钳回 1，pop 与自定义 `\fscx` 变换同开时预览值偏离 libass 链值。修复后公式对任意正 popScale 精确，新增逐帧对照测试覆盖（含窗口结束不跳回断言）。
- **重叠字幕时 pop 文字大小与只有主字幕对不齐（backlog 53 行）**：不是动画重复应用（三轨各自只发射一次标签，`events.length = 0` 后由排布切片统一重发）。根因是排布保守边界：pop 句的包围盒把入场最大状态（旧语义 = 1.4 × 字号）计入采样，叠加轨与主字幕同片排布时整组更容易触发 `slice.scale` 压缩适配，落定字号随之变小；只有主字幕时单句走 legacy 路径不缩放，两路径字号不一致。默认 fromScale 改 0.8 后入场峰值恰为落定字号，不再额外预留；同时把包围盒内部极值覆盖从 `popAtStart > 1` 扩到任意 pop 生效（峰值取 `max(fromScale, 1)`、端点加自定义变换目标），fromScale < 1 与自定义轴变换组合时不再低估。

## 改动

- `web/shared/utils/ass-animation.js`：发射门/预览门放开 fromScale < 1（=1 仍跳过）；注释同步 libass 语义。
- `web/shared/utils/ass-style.js`：默认 `fromScale` 0.8；归一化钳制 [0.3, 10]；`assPreviewStyleAt` 补偿缩放钳制改 `Math.max(0.01, …)`。
- `maw/ass_styles.py`：默认 0.8 与钳制 [0.3, 10] 同步。
- `web/editor-template.html`：起点倍率输入 `min="1"` → `min="0.3"`。
- `web/shared/utils/ass-canvas-layout.js`：排布包围盒峰值缩放 `max(fromScale, 1)`，pop 生效即启用内部极值覆盖。
- 测试：`tests/test_ass_animation.mjs`（默认方向 0.8→1.0、fromScale>1 保留、=1 不发射、0.3 钳制、pop+自定义 `\t` 链式发射与逐帧链值对照、放大方向单调性、sub-1 pop 包围盒覆盖落定字号）、`tests/test_ass_styles.py`（默认值、下限钳制、往返）、`tests/test_editor_assets.py`（默认字面量、`min="0.3"` 契约）。
- UI 文案：设置卡帮助文字与 `editor-i18n.js` 键值成对更新（「默认 0.8，从小放大；大于 1 则从大缩小」）；`text-processing.js` 注释同步双语义。
- 文档：`docs/user/ASS_STYLES.md` 语义与默认值；`CHANGELOG.md` 未发布 🐛 修复。

## 验证

- `node --test tests/test_ass_animation.mjs tests/test_mass_markers.mjs` → 44/44（其中动画用例 22，含本次新增 4 条）。
- `TMPDIR=$PWD/.artifacts/tmp node --test tests/*.mjs`（先 `npm run build` 重建 editor/launcher bundle）→ 1002/1002。
- `python scripts/run_tests.py tests/test_ass_styles.py tests/test_editor_assets.py` → 45 OK；全量 `python scripts/run_tests.py` → 2803 OK（skipped 19，环境性跳过；主仓库 venv 3.11.15，uv.lock 与 main 一致）。
- `npm run check:editor` / `check:launcher` fresh；`npm run typecheck` 通过；`git diff --check`、`check_personal_paths.py --diff-ref main`、`check_docs.py`（0 new broken links）干净。
- 独立复核与双向验证：4 条 finding 全部处置（见 [REVIEW_FINDINGS](REVIEW_FINDINGS.md)）；canvas-layout 修复回退后新包围盒用例真红（比例 0.8 < 1），恢复后绿。
- 未验证边界（人工实机）：真实 libass/ffmpeg 烧录帧对照（单 \t 不跳回的源码结论建议实机抽查）、浏览器拖动/播放/seek 观感、叠加轨共存时的排布字号实测、样式库卡片间距（本次未动布局）。`blank-editor.html` 按约定留待发布前统一重生成。
