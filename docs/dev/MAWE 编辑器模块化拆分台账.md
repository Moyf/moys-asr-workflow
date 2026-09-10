---
title: MAWE 编辑器模块化拆分台账
created_at: 2026-09-10
status: in_progress
audience: 执行本轮拆分的维护者与 agent
---

# MAWE 编辑器模块化拆分台账

本台账记录在最新 `main` 上把 `web/editor.js` 平铺单体拆为特征模块的执行过程。
方法论与工具借鉴外部分支 `drunkenQCat/moys-asr-workflow:refactor/explode-js`
（其完整方法沉淀见该分支的 `docs/dev/编辑器模块化拆分指南.md`，工具在
`scripts/refactor-tools/`），在其 2026-08-31 基点之后 main 又前进了约 170 个
提交，无法直接合并其结果，故按同一方法在本仓重做。

本拆分与《MAWE 前端渐进式重构企划案》的关系：企划案 Phase 0–1（共享清单、
`window.MAWE` 注册表、兼容出口）已在 main 落地；本轮机械拆分建立物理模块
边界，是企划案后续阶段（纯逻辑抽取、Store/命令）的承载结构。

## 不可动摇的约束（全部承袭外部指南）

1. 产物是单文件 HTML；装配协议 = `web/editor-scripts.txt` 清单顺序，三方消费
   （edit.py / server-editor / Tauri build.rs）注入同一个 script token。
2. 模块系统 = IIFE + 冻结命名空间；可变状态用 get/set 访问器发布
   （`Object.freeze` 不阻止 setter 写入）。
3. 行为等价必须可证明：顺序断言 + 清单级语法 + 契约测试 + 单测 + Playwright
   失败**标题集合**比对（串行），不用"看起来没坏"下结论。
4. 每批 = 一个提交 = 一组可验证的改动；批内 4–10 个簇。
5. 管道会吞退出码：先看测试输出确认，再提交。
6. 严格模式 IIFE 会引爆 sloppy 隐式全局：每批后跑 `scan-implicit-globals.mjs`。
7. 简写属性 `{ foo }` 改写为 `{ foo: NS.foo }`；解构绑定简写一律报错人工处理。
8. 门面 setter 硬性不变量：原门面有 set ⇒ 必发布访问器对。

## 终态蓝图（参照外部阶段一终态，按本仓现状调整）

外部阶段一终态：editor.js 17,790 → 2,812 行，73 个平铺特征模块；阶段二按域
入子目录（shared/editor/server 分层）；阶段三拆巨型 IIFE + boot 连续切段。
本仓 editor.js 起点 18,523 行 / 1,398 顶层符号 / 120 个可变 let/var（外部基点
为 17,790 / 1,272，main 两周演进新增符号约 120 个，簇划分需重新核对）。

## 基线（2026-09-10，main @ bc5262cd）

| 层 | 命令 | 结果 |
| --- | --- | --- |
| Node 单测 | `node --test tests\test_editor_runtime.mjs tests\test_editor_utils.mjs tests\test_waveform_js.mjs tests\test_editor_script_order.mjs tests\test_editor_script_syntax.mjs` | 286 pass / 0 fail |
| Python 全量 | `uv run --no-sync python -m unittest discover -s tests -p "test_*.py"` | 1454 OK（6 skipped） |
| Playwright | `npx playwright test --project=chromium`（workers=1 串行） | 见下方记录 |

预存失败（拆分前就有，不修，修了会掩盖真实回归）：

- English locale covers the editor shell and recent-project setting stays first
- Help settings actions open the related waveform and media settings
- all waveform deletion scenarios
- dropping a legacy project lets the blank server take over after ID normalization
- exports source OTIO when media metadata is missing
- larger subtitle-segment overlap requires an explicit repair direction
- left and right arrows seek like the media step buttons
- media seek buttons and arrow keys use the configured seek duration
- previews text changes and applies the reported item-timing mapping
- quick start can be skipped and replayed from Help
- shows independent extension preview controls with yellow defaults
- shows the installed OCR settings hint and highlights video drops
- small subtitle-segment overlap can be auto-repaired and saved again
- waveform marquee scenarios

预存 editor.js 隐式全局写（sloppy 模式雷，所属簇迁移时处理）：
`editor.js:5946 ms`、`:8393 waveformTimeMs`、`:15808 projectLoadedFromSrt`、
`:17938 requestedEnd`（行号为 Batch 1 后时点）。

## 批次记录

| # | 日期 | 内容 | 验证 | 提交 |
| --- | --- | --- | --- | --- |
| 0 | 2026-09-10 | 安全网：`scripts/refactor-tools/` 8 件、`tests/test_editor_script_order.mjs`、`tests/test_editor_script_syntax.mjs`、acorn devDep | Node 286 pass；Python 1454 OK；顺序断言在平铺现状上通过 | f669d1e7 |
| 1 | 2026-09-10 | `MaweHint`（7 符号，280 处引用改写）+ `MaweJklPlayback`（16 符号，42 处改写）；契约测试改按文件名钉 marker；新增 `probe-namespace.mjs` 无头探针 | node --check ×3 过；顺序断言过；Node 286 pass；Python 资产/打包/gui_web 320 OK；blank 临时产物含两模块、0 未解析 token；探针全绿零 pageerror | f2537d7d |
| 2 | 2026-09-10 | `MaweSettings`（52/318）+ `MaweMultiSubtitleCore`（48/363）+ `MaweGapRemoveData`（23/67）+ `MaweColors`（4/15）；调色板注入守卫手工随迁 colors 模块；契约测试断言同步（EDITOR_SETTINGS → MaweSettings.EDITOR_SETTINGS 等） | node --check ×6 过；顺序断言过；Node 286 pass；Python 1454 OK；blank 临时产物 0 未解析 token；探针全绿零 pageerror；隐式全局扫描仅 4 处误报（multi-subtitle 模块延迟写 editor.js 顶层 let，全局词法绑定合法） | （本提交） |

Batch 2 执行备注：

- 多模块批次按"最高行号优先"执行 codemod（settings → multi-subtitle → gap-remove-data →
  colors），上方区间的行号不受下方删除影响；每次运行前用 `map-fork-module.mjs` 重映射。
- `map-fork-module.mjs` 改为读工作区 editor.js（含未提交改动），不再读 HEAD。
- settings 簇与 fork 的差异：main 已把 normalize*/clamp* 收进 editor-utils.js，
  editor.js 只留别名块——别名块随 settings 模块迁移（load-time 访问
  `window.AsrEditorUtils.*`，清单序在前，安全）。

工具备注：

- `split-cluster.mjs` 报告的"editor.js 现为 N 行"不可信（按 kept 文本统计，与
  实际落盘文件有出入），以 `git diff --stat` 为准。
- codemod 每次运行会折叠 editor.js 中连续 ≥3 个空行为 2 个（`/\n{3,}/`），
  后续批次的行区间必须重新定位（`list-top-level.mjs` 输出为准）。
- 门面导出是机械版（原始符号名 + 可变状态访问器）；fork 的语义化门面
  （如 `getRate`）是他们手工精修的产物，本仓保持机械版以保证行为等价。

## 已知风险与特例

- `gap-remove-core.js` 被 `serve.py` 作为第二注入方按路径读入：其内部一旦拆块，
  注入源必须改为按清单前缀拼接（外部指南 §6.7），否则对齐页静默损坏。
- boot 接线（editor.js 尾部顶层语句）不做命名空间化，按"连续切段 + 顺序不变 ⇒
  拼回逐字节不变"处理，段间顺序即注册顺序。
- e2e spec 经 `page.evaluate` 直访页面全局：模块化后需 `fix-e2e-globals.mjs`
  按导出表 AST 级改写（预计数百处）。
