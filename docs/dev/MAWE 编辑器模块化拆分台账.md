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

- （待基线跑完填写）

## 批次记录

| # | 日期 | 内容 | 验证 | 提交 |
| --- | --- | --- | --- | --- |
| 0 | 2026-09-10 | 安全网：`scripts/refactor-tools/` 8 件、`tests/test_editor_script_order.mjs`、`tests/test_editor_script_syntax.mjs`、acorn devDep | Node 286 pass；Python 1454 OK；顺序断言在平铺现状上通过 | （本提交） |

## 已知风险与特例

- `gap-remove-core.js` 被 `serve.py` 作为第二注入方按路径读入：其内部一旦拆块，
  注入源必须改为按清单前缀拼接（外部指南 §6.7），否则对齐页静默损坏。
- boot 接线（editor.js 尾部顶层语句）不做命名空间化，按"连续切段 + 顺序不变 ⇒
  拼回逐字节不变"处理，段间顺序即注册顺序。
- e2e spec 经 `page.evaluate` 直访页面全局：模块化后需 `fix-e2e-globals.mjs`
  按导出表 AST 级改写（预计数百处）。
