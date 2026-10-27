# Launcher ESM 迁移 L00：基线锁定与台账

日期：2026-10-22
工作树：分支 `esm/launcher-l00-baseline`，HEAD `22b8718e`（origin/main tip，Merge PR #291 esm/g05-waveform-leaves）
计划来源：维护者提供的 `maw-launcher-progress.md`（toy 提交链 61fd578→e209d92，HTML 抽取实验基于 3188accf，JS 核对基于 a02a0cfd）

## 上游与 PR 核对（L00 开工条件）

- 上游 `cat`（drunkenQCat/moys-asr-workflow）`cat/main` = `b4b604a7`（doc: 更新 1.10.0-beta.1 日志基线）。fetch 时网络重置，本次未取到新提交；`cat/main` 是 `origin/main` 的祖先。
- origin/main 领先上游 68 个提交，其中触及 `web/launcher/` 的合并链：
  - `6f03b126` feat(launcher): 最近工程列表——编辑器卡片一键填入本机最近工程（PR278 相关，分支 `feat/launcher-recent-projects`，含 `9a60df7e` 忽略旧工程媒体校验响应、`7f3fabe5` 编辑器就绪后刷新）
  - `d23d543e` feat: ASS 字体名按本机别名表归一化（`fix/ass-smiley-sans-font-render`，间接触及 launcher i18n）
- 结论：计划的 JS 文件清单（18 个 classic 文件 + 2 个独立脚本）在当前主线仍然有效，但**页面与部分文件相对 toy 基线 a02a0cfd 有增量**，下表已核对。

## 文件台账（20 个 Launcher JS，当前主线 HEAD）

构建顺序以 `web/launcher-scripts.txt` 为准（18 个 classic，bundle 由 `scripts/build-launcher.mjs` 按此清单装配）：

| # | 文件 | 自 a02a0cfd 后的增量 | 迁移步骤归属 |
| --- | --- | --- | --- |
| 1 | `web/launcher/i18n/launcher-strings.js` | 有改动（i18n 文案，最近工程相关） | L02 |
| 2 | `web/launcher/boot/launcher-state.js` | 无改动 | L02/L03/L05/L08 |
| 3 | `web/launcher/boot/launcher-mock-api.js` | 有改动 | L04 |
| 4 | `web/launcher/i18n/launcher-labels.js` | 无改动 | L03 |
| 5 | `web/launcher/forms/launcher-form-base.js` | 无改动 | L02/L06 |
| 6 | `web/launcher/errors/launcher-errors.js` | 无改动 | L05 |
| 7 | `web/launcher/server/launcher-server-monitor.js` | 有改动（+11 行） | L05 |
| 8 | `web/launcher/boot/launcher-theme-bridge.js` | 无改动 | L04/L12 |
| 9 | `web/launcher/forms/launcher-form-sync.js` | 无改动 | L06 |
| 10 | `web/launcher/local/launcher-local-models.js` | 无改动 | L08 |
| 11 | `web/launcher/forms/launcher-provider-language.js` | 无改动 | L03/L06 |
| 12 | `web/launcher/presets/launcher-presets.js` | 无改动 | L08 |
| 13 | `web/launcher/forms/launcher-prefs-zoom.js` | 无改动 | L06 |
| 14 | `web/launcher/forms/launcher-media-form.js` | 无改动 | L07 |
| 15 | `web/launcher/server/launcher-media-server.js` | 有改动（+57 行，最近工程缩略图服务） | L07 |
| 16 | `web/launcher/boot/launcher-settings-startup.js` | 有改动 | L04/L07/L12 |
| 17 | `web/launcher/boot/launcher-notify-backend.js` | 无改动 | L09/L12 |
| 18 | `web/launcher/boot/launcher-wiring.js` | 无改动 | L12 |
| 独立 | `web/launcher/batch.js` | 无改动 | L10 |
| 独立 | `web/launcher/postprocess.js` | 有改动（+8 行） | L11 |

共享文件（另列，不进 20 文件数）：`web/shared/tooltip.js`（页面在 body 尾第一个加载）、`launcher.css`（有改动 +57 行）、`index.html`（有改动）。

## 页面加载契约（`web/launcher/index.html`，1673 行，609 个 id）

- head 内联首屏主题脚本（localStorage `MAW_GUI_THEME` + prefers-color-scheme，写 `data-theme`）+ 内联防闪烁样式。
- body 尾按序加载：`../shared/tooltip.js` → `boot/launcher-bundle.js`（构建产物）→ `batch.js` → `postprocess.js`。
- file:// 宿主：`maw/gui_web.py` 打开本地路径（非 HTTP），tooltip/bundle/postprocess 与 Python 桥 `MAWLauncher.onBackendEvents` 的契约在 L09/L14 再动。

## 与 Editor 计划的共享接口

- L00 基线 `22b8718e` 已包含 G02–G05；后续 G06 由 PR #297 合入，G07 由 PR #300 单独交付。Editor 的 factory 登记、init 模块与 classic 接线仍并存，登记退役按实际消费者逐批进行。
- Launcher 构建器 `scripts/build-launcher.mjs` 与 Editor 构建器共用 `scripts/build-editor.mjs` 导出的 `compileSources`。L01 在共享核心增加 `transition` 分支，由 Launcher 显式启用词法绑定；Editor 沿用既有 factory/init 分支，共享核心的变化需要同时验证两种产物及其新鲜度。
- 前端运行时共享 `web/shared/tooltip.js`，构建装配还共享上述核心；L12 时与 Editor 计划协调提取显式 start 的 tooltip 实现。

## L00 验证记录

- 工作树干净（HEAD `22b8718e`，2026-10-22 16:21 +0800），分支 `esm/launcher-l00-baseline`，含 `cat/main` 全部提交。
- `web/launcher-scripts.txt` 18 文件与目录实际文件一一对应（boot 6 + forms 5 + i18n 2 + errors 1 + server 2 + local 1 + presets 1）。
- `web/launcher-modules.json` 仍为 `{"format":1,"externalBridges":[],"modules":[]}`，符合计划预期（不是已迁移工厂表）。
- 环境复用：worktree 无本地 venv，Python 测试将设 `MAW_TEST_PYTHON` 指向主仓库 `.venv`（已验证可 `import maw`；主 venv 无 pywebview，e2e/原生窗口验证另行处理）；Node v25.8.0 / pnpm 11.28.4 可用，worktree 尚未 `pnpm install`。
- 页面实际加载产物核对：4 个 `<script src>`（tooltip、launcher-bundle、batch、postprocess）与台账一致。

## 下一步（L01）

- 完成 `scripts/build-launcher.mjs` 的词法绑定适配夹具 + `tests/test_launcher_bundle.mjs` 断言扩展。
- 先读 build-launcher.mjs 与 Editor build-editor.mjs 的现状接口，确认不破坏普通工厂分支。
