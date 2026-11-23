# 提交前自审：macOS 跨平台快捷键缺漏（Cmd+点击跳转 / Alt→Option 提示）

- 分支：`Moyf/fix-mac-shortcut-gaps`（基线 cce9f709，后合并 origin/main 37c11d1c）
- 审查者：未参与实现的独立 agent，只读审查（对照 HEAD=cce9f709 工作树 diff）
- 审查范围：15 个文件（+197/−32），含新 e2e `tests/e2e/gap-range-drag.spec.mjs`
- 审查证据：`git diff HEAD` 全文、`git diff --check`（exit 0）、`node scripts/build-editor.mjs --check`（fresh）、`node --test`（440 pass）、`pnpm run typecheck`（通过）、`unittest tests.test_waveform.EditorAssetTests`（12/12）、`tests.test_server_align`（13/13）、`check_personal_paths.py --diff-ref origin/main`（exit 0）、CRLF 扫描（均 0）

## 结论

**可提交，无 blocker / major。** 核心正确性由审查者逐链路核验：i18n 往返（平台替换先于首次翻译，`editor-i18n.js:1973` 注释明确该不变量；`textOriginals` WeakMap 捕获 `:2249`；三条例句与模板 3 个带前缀 kbd 一一对应）、Windows/Linux 零行为变化（非 Mac 早退且无 DOM 写）、降级路径（`isMacPlatform(null)` 返回 false，有直测）。

## Findings 与处置

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| minor | 新 e2e ±10ms 容差理论上最坏 ~11.9ms（roundMs ±5 + 整数化 clientX 半像素 ≈6.9），Windows headless 辅助巡检有 flake 风险（`gap-range-drag.spec.mjs:76-78`） | **已修复**：容差放宽到 20ms 并注明构成；坐标换算审查确认与生产 `input.js:325-332` 逐项一致 |
| minor | Alt→Option 显示标签覆盖不完整：模板 `:167/:1522/:1525/:1548/:2147` 的 title/aria 与英文词典 `:1767/:1787/:1788/:2099` 仍硬编码 Alt | **接受并披露**：CHANGELOG 措辞已如实限定范围为「帮助面板、静音空隙面板与右键菜单提示」；遗留点列入 PR 边界段 |
| minor | 文档 macOS 注记不一致：`EDITOR_GUIDE.md:31` 快捷表、`MULTI_SUBTITLE.md` 多处 Alt 提法未加注（`EDITOR_GUIDE.md:184`、`KEYBOARD_ADJUSTMENT.md:39` 已加） | **接受并披露**：注解已覆盖两个主要文档的首个语义定义点，其余列入 PR 边界 |
| nit | `tests/test_server_align.py:158` 的 `"Alt+点击切换禁用"` 断言改靠静态帮助文案偶然命中，对 tooltip 失去守护 | **已修复**：改断言源码模板字面量 `${ALT_KEY_LABEL}+点击切换禁用` |
| nit | `server-align.spec.mjs:90` 的 `pressedBefore ?? ''` 是死分支（take 元素必设 aria-pressed） | **已修复**：去掉 `?? ''`，null 时直接暴露异常 |
| nit | server-align `ALT_KEY_LABEL` 与 `platform.js isMacPlatform` 判定为复制非共享（语义逐字符一致，无分歧风险） | **已加固**：两处注释互相引用，要求改判定时双侧同步 |
| nit | `server-align/index.html:611` 静态帮助文案 JS 执行前短暂显示 Alt | **接受**：与 `data-mod-key` 同思路的无 JS 降级，`updateWaveformModeControls()` 初始化即替换 |
| nit | 空隙面板 summary 英文不翻译（既有行为）；`editor-i18n.js:2096` 旧版摘要 regex 为死代码 | **接受**：非本次回归，留待后续清理 |

## 双向验证（红绿证据）

- 移除 `cue-blocks.js` Alt 分支（`event.altKey` → `false`）重建后：`gap-range-drag.spec.mjs` 1 failed（Alt 用例红）；还原后 2 passed。
- `bindTakeButton` 临时还原为 ctrlKey-only：Cmd 用例 1 failed；还原后通过。
- 每次变异后均恢复源文件并重建 bundle。

## 平台前提复核（任务起点）

「Mac 不支持 Alt+拖动创建空隙」的前提不成立：手势入口 `cue-blocks.js:63-75` 只读 `event.altKey`，无平台分支；本机 macOS 实测 Chromium 与 WebKit 双引擎均成功创建空隙（5000–9000ms，`removed:true`），维护者真机复测亦确认 Option 可用。故本批未改手势代码，仅补回归用例与平台化文案。
