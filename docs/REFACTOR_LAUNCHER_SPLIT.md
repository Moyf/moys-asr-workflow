# Launcher.js 拆分重构（第一阶段）

状态图例：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。
本文件是重构过程的进度账本，每完成一步立即回写，不要留到全部结束。

## 背景与目标

`web/launcher/launcher.js` 已增长到 4745 行 / 378KB / 191 个顶层函数的单 IIFE，
其中 `STRINGS` i18n 表占第 4~1278 行（约 27%）。参照 Editor 已完成的两阶段重构路径，
对 launcher.js 做第一阶段机械等价拆分。

已与维护者确认的决策：

- 范围：仅 launcher.js；`postprocess.js`（2766 行）与 `batch.js`（415 行）留到下一批。
- 加载方式：Editor 同款 bundle（清单 + esbuild 装配 + 提交产物），index.html 引 bundle。
- 模块形态：第一阶段 classic IIFE（实际为共享作用域裸声明，同 Editor classic 模块），
  机械等价拆分，不做引用改写、不上 ESM 工厂；工厂化留第二阶段。

## 事实基线（2026-10-10 勘察）

- launcher 由 pywebview 以 `file://` URI 直接加载 `web/launcher/index.html`
  （`maw/gui_web.py` `launcher_url = paths.launcher_html.resolve().as_uri()`），
  无便携内联产物需求，但 bundle 仍按 Editor 约定提交进仓库。
- `batch.js` / `postprocess.js` 是 bundle 外的 classic script，经
  `window.MAWLauncher.translate/errorText/appendLog/callBackend/confirm/onBatchModeChanged`
  反向调用 launcher；挂载点在 launcher.js 的 `bridge()`。第一阶段保留源内挂载不动。
- Editor 装配机制：classic 模块是裸顶层声明，按清单原序拼进 `initializeLegacy()`
  共享函数作用域（TDZ 语义保留）；ESM 工厂经 `window.MAWE.register` 注入；
  `scripts/build-editor.mjs` 的 `compileSources(root, files, modules, read, options)`
  已参数化，可被 launcher 构建器复用。
- 验证资产：e2e 有 `launcher-error-context` / `launcher-file-errors` /
  `launcher-interactions` / `launcher-zoom` 四个 spec；
  Python 侧 `tests/test_launcher_batch.py` 只测后端逻辑，与本次 JS 改动无关。
- `scripts/refactor-tools/split-cluster.mjs` 等历史工具绑定 `web/editor.js`，
  不直接适用；launcher.js 是单 IIFE，采用行区间切割（不改写引用）即可，
  因为拼接后所有声明仍在同一共享作用域，语义与原 IIFE 一致。

## 任务清单

| # | 任务 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 建立任务记录文档 | 已修复 | 本文件 |
| 2 | 装配基础设施：`web/launcher-scripts.txt`（初始仅含 launcher.js）+ `scripts/build-launcher.mjs`（复用 build-editor 的 compileSources）+ package.json 脚本 + index.html 改引 bundle + 产物 + 单测 | 已修复 | commit 1 |
| 3 | 机械拆分：行区间切割 launcher.js 为领域模块 + 清单更新 + bundle 重建 | 待处理 | commit 2 |
| 4 | AST 等价审计：原 launcher.js 语句序列 vs 拆分后拼接语句序列 | 待处理 | 一次性审计脚本 |
| 5 | 清单测试：launcher 版 syntax / order 单测 | 待处理 | 参照 editor 同名测试 |
| 6 | 验证：`pnpm run check:launcher` + 相关单测 + e2e launcher specs + 手动 serve 冒烟 | 待处理 | e2e 遵守防挂起纪律 |
| 7 | 收尾：CHANGELOG 条目 + 人工核查 checklist HTML（放 %TEMP%，不提交） | 待处理 | |

## 验证记录

### 任务 2：装配基础设施（commit 1）

改动：

- 新增 `scripts/build-launcher.mjs`：复用 `build-editor.mjs` 的 `compileSources`，
  读 `web/launcher-scripts.txt` + `web/launcher-modules.json`（format 1，当前
  `modules: []`、`externalBridges: []`），esbuild 装配 + minify + trace 钩子，
  meta 记录每个源文件 sha、configHash 与两个构建器的 builderHash。
- 新增产物 `web/launcher/boot/launcher-bundle.js`（278KB）+ `.meta.json`，提交进仓库。
- `index.html` 改引 `boot/launcher-bundle.js`；`batch.js` / `postprocess.js` 不动。
- `package.json` 新增 `build:launcher` / `check:launcher` / `watch:launcher`；
  CI `editor-checks.yml` 加 `pnpm run check:launcher`。
- 新增 `tests/test_launcher_script_syntax.mjs`（清单语法）与
  `tests/test_launcher_bundle.mjs`（产物一致性 + 结构标记）。

验证（全过）：

- `node scripts/build-launcher.mjs --write && --check`：`Launcher bundle is fresh`。
- `node --test tests/test_launcher_script_syntax.mjs tests/test_launcher_bundle.mjs`：3 pass。
- `pnpm run typecheck`：过。
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_bundle.mjs`：7 pass。
- `pnpm exec playwright test --project=chromium tests/e2e/launcher-interactions.spec.mjs`：51 passed（2.3m，file:// 直开，无 serve 残留）。

已知边界：

- `tests/test_gui_web.py` 有 10 处直接读 `launcher.js` 源码断言；拆分 commit 时
  统一改为按清单拼接全集断言（当前 launcher.js 仍在清单内，不受影响）。
- bundle 行为等价性目前由 e2e 冒烟覆盖；拆分 commit 将补 AST 级等价审计。

## 拆分簇规划（待细化）

按功能域初步分簇（切割时按符号锚点定位行区间）：

1. boot：IIFE 壳剥离后的常量区（1279~1550）+ `state` + 模块级 let（1551~1576）
2. i18n：`STRINGS` zh/en（4~1278）
3. mock-api：`mockApi`（1578~1850）
4. labels：EN 文案映射表（PROVIDER/MODEL/LANGUAGE 等，1880~1955）
5. errors：错误报告/诊断/复制（1855~2071 + 2095 起 error* 函数）
6. server-monitor：服务器状态监控
7. theme-zoom：主题 + 缩放
8. bridge：`bridge` / `waitForBackend` / `revealLauncher` / `injectEmojiFont`
9. form-sync：`sync*` / `render*` 表单域
10. presets：预设管理（preset* / AsrPreset）
11. local-models：本地模型 / 运行时 / OCR / 对齐模型
12. audio-tracks：音频轨探测
13. media-drop：媒体选择 / 拖放
14. settings：设置面板
15. notify：通知 / 批量完成
16. startup：`init` / `handleBackendEvent` / 尾部语句

实际簇边界以切割脚本输出为准；宁可簇少而大，不为凑数硬切。
