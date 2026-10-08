# 调研简报：MAWE 编辑器前端 ESM 化能否机械化完成

> 交接日期：2026-09-28。委托方：drunkenQCat（fork 维护者）。
> 调研问题一句话：**把 web/ 下约 170 个 classic 脚本转为真 ES Module 的过程，能否用固定脚本（codemod）机械完成，而不是逐文件手工调整？**
> 本简报自包含：不了解此仓库的 agent 应能仅凭本文 + 仓库现状开工。

## 一、背景与现状（已发生的事实）

### 架构

- `web/` 下 173 个 JS 文件，**classic script**（非模块），由清单 `web/editor-scripts.txt`（184 行，含注释）规定拼接顺序。顺序即语义：后文件可见先文件的顶层绑定（共享全局作用域）。
- **两个消费端**读同一份清单装配页面：
  - `edit.py`（纯 Python）：内联生成便携单文件 `blank-editor.html` 与 `.edit.html`，用户 **file:// 双击打开**（产品特性）；
  - `server-editor/serve.py`（纯 Python）：每次请求从 `web/` 实时渲染，http 服务；
- **file:// 下 ES modules 被 CORS 硬禁** → 便携页这一消费端必须消费「打包后的 classic 脚本」，这是整个迁移中唯一被迫引入 esbuild 的原因。

### 重构进度（全部已合并进 main @ d4e5dff2）

- #136：17k 行单体 `editor.js` 拆为 79+ IIFE 模块；#154/#155：boot 切段 + 领域目录树（`web/editor/{cues,media/waveform,ui,state,io,styles,boot}` + `web/shared/{host,utils}`）+ **宿主能力隔离**（`shared/host/{storage,files,server-api}.js`）。
- 模块系统：`window.MAWE` 注册表（version 1，`web/editor/boot/editor-runtime.js`）——`register(name, factory)` / `resolve(name, ...args)`；模块是 IIFE，依赖以**依赖袋**（对象解构参数）显式注入；对外仍保留 window 门面兼容出口（`window.AsrEditorUtils`、`MaweBoot`、`MaweHost`、`MAWE_I18N` 等）。
- #156：Store 层落地——`MaweState`（状态所有者）、`MaweCommands`（48 处字幕编辑入口事务化）、`MaweViewUpdates`（统一视图失效范围）。
- `editor.js` 已缩至 65 行 boot 引导；`web/editor/boot/` 还含 `editor-host.js`、`editor-startup.js`、`editor-globals.d.ts`（类型门，`npm run typecheck` = tsc --checkJs）。

## 二、已完成的试点（fork 分支 `esm-pilot`，drunkenQCat 远端）

分支把 **4 个模块**（`shared/host/*` 三件套 + `editor/boot/editor-host.js`）转为真 ESM，验证了嵌回机制。关键结论与产物（均在分支内）：

1. **双轨装配**：清单中原四条目替换为单个 `web/editor/boot/esm-bundle.js`（esbuild 打包的 classic IIFE，已提交）。两个消费端**零改动**——清单是纯文本文件，bundle 就是一个普通条目。页面形成双 `<script>` 轨：经典块 + bundle 块，共享全局，桥接靠保留的 `window.MaweHost` 门面。
2. **门禁**（全部非零退出语义）：
   - `scripts/esm-pilot/build-esm-bundle.mjs`：转换集 → 产物（32ms）；`buildBundle()` 纯函数导出，CLI 在 `invokedDirectly` 守卫后；
   - `tests/test_esm_bundle_fresh.mjs`：产物新鲜度逐字节比对（曾因 CLI 顶层副作用成为哑弹，已修——**导入构建脚本不得有副作用**是硬规矩）；
   - `scripts/esm-pilot/verify.mjs --baseline <ref>`：三页探针（基线 replica 页 / 正式 edit.py 页 file:// / 正式 serve.py 页 http）八项检查任一失败非零退出；
   - node 全量 375 pass / 0 fail；`test_editor_assets.py` 契约测试同步。
3. **测试加载器迁移模式**：`tests/helpers/editor-module-loader.mjs` 从 vm 拼接改为「转换集注入 bundle、其余照旧 vm 求值」；`tests/test_editor_host.mjs` 已示范终态——**直接 `import` 被测模块 + 参数注入**，测试体零改动。
4. 数据：打包 32ms；全块 minify -40%（gzip -36%）；编译期拒绝拼错导出名 31ms。
5. 报告与图：`docs/temp/ESM_PILOT_REPORT.md`、`docs/temp/ESM_PILOT_DIAGRAM.html`（分支内）。

## 三、待解问题：从 4 个文件泛化到 ~170 个文件的机械化转换

### 逐文件语义映射（已验证可行的部分）

| classic 形态 | ESM 形态 |
|---|---|
| `(function(){ 'use strict'; … })();` | 模块体（'use strict' 可删） |
| `window.MAWE.register('x', function factory(deps) {…})` | `export function factory(deps) {…}` |
| 依赖袋解构 `const { a, b } = dependencies` | `import { a } from '…'`（仅当 a 属于已转换集；否则保留 window 桥引用） |
| 门面挂载 `global.MaweXxx = Object.freeze({…})` | 保留为兼容桥（试点期间），或随消费方迁移退役 |
| 清单顺序 | import 顺序（可从清单拓扑序机械生成） |

试点已证明：同文件内依赖、依赖袋→导入、门面桥保留、入口副作用归位（门面挂载必须移出入口，否则 tree-shaking 摇掉纯导出模块——已实际发生并被当场暴露）。

### 需要调研判定的七个难点（调研的核心交付物）

1. **注册表调用面盘点**：全部 `MAWE.register` 调用（数量、工厂签名）与**全部 `MAWE.resolve` 调用点及其参数袋内容**。依赖袋由调用方构造，静态 import 的等价物取决于每个袋里实际是什么——这是转换器最难的信息来源，需要机械盘点脚本。
2. **加载期语义保持**：清单顺序 = 顶层语句执行顺序，部分模块有**加载期副作用**（如 `editor-startup.js` 的监听器接线、立即 resolve 的 `editor-host`）。转换器必须保证：自底向上（叶子先转）批次的 import 求值顺序 ≡ 原清单顺序。需要论证「清单拓扑序 ≡ import 图拓扑序」的机械保持算法。
3. **跨模块引用改写**：模块间经 window 门面互访（`window.AsrEditorUtils.X`、裸 `MaweBoot.DATA`）。改写引擎已有实战验证的核心：`scripts/refactor-tools/scope-core.mjs` 的 `unresolvedRefs()`（eslint-scope，按词法解析全部绑定形态）与 `ns-rewrite-editor.mjs` 的改写先例。需评估：对每个待转文件，哪些自由引用该变成 import、哪些保留 window（跨轨引用）。
4. **文件分类学**：纯逻辑文件（可直接转）/ 带加载期副作用的接线文件（转但保持副作用顺序）/ 模板注入文件（`editor-boot.js` 含 `__DATA_JSON__` 等占位符，edit.py 在最终页面做字符串替换——需确认占位符在 bundle 内外均可用）/ DOM 密集文件。分类决定转换模板。
5. **e2e 与外部桥清单**：`tests/e2e/*.spec.mjs` 经 `page.evaluate` 直访 window 全局（`MAWE_EDITOR_BRIDGE` 等）。需要一份显式桥清单（哪些全局必须保留、哪些随迁移退役），机械盘点可用 acorn 扫 spec。
6. **消费端终态**：试点让两端读「bundle 条目」。终态两选项待比较：全端消费 bundle（现状外推）vs server 端原生 `<script type="module">`（http 天然支持，零产物）+ 仅便携页打包。后者影响转换器是否需要维护两种装配输出。
7. **Node 版本语义**：tests 直接 import `.js` ESM 依赖 Node ≥23 的模块语法自动检测；正式迁移需决策 web 源码目录 `"type": "module"` 或 `.mjs` 重命名，及其对两个消费端路径解析的影响。

### 建议的批次策略（已验证的安全模式）

自底向上（`shared/utils` 叶子先行），每批一个 PR；每批的守门 = node 全量测试 + `npm run typecheck` + `verify.mjs` 三页探针 + `test_editor_assets.py` 契约测试。**任何守门测试不得加豁免来变绿**（第一轮评审的方法论教训：豁免 = 调暗集成缺口的红灯）。

## 四、验收标准（调研交付物应回答）

1. 逐文件转换是否可 100% 脚本化？给出「可机械转换 / 需人工判断」的分类与占比，人工点的清单。
2. codemod 原型：输入清单+源码，输出转换后的模块与更新后的清单；至少在一个真实批次（如 `shared/utils` 的 5–10 个叶子）上跑通全部门禁。
3. 难点 1–7 逐项结论与证据。
4. 风险清单与回滚方案（每批独立可回滚）。

## 五、文件路径索引

- 试点分支：fork `drunkenQCat/moys-asr-workflow:esm-pilot`；本地工作树 `.qwen/worktrees/esm-pilot`
- 试点报告 / 说明图：`docs/temp/ESM_PILOT_REPORT.md` / `ESM_PILOT_DIAGRAM.html`（分支内）
- 作用域分析内核：`scripts/refactor-tools/scope-core.mjs`（`unresolvedRefs` / `selfCheck`）
- 引用改写先例：`scripts/refactor-tools/ns-rewrite-editor.mjs`（含 `--report` 决策报告模式）
- 三方合并重放（历史工具，含同类教训）：`tools/merge-flow.mjs`
- 类型门：`web/editor/boot/editor-globals.d.ts` + `tsconfig.typecheck.json`（`npm run typecheck`）
- 上游计划：《企划案》`docs/dev/MAWE 前端渐进式重构企划案.md`（Phase 0–6；Phase 4 已由 #156 完成）；执行台账 `docs/dev/MAWE 编辑器模块化拆分台账.md`
- 评审史（方法论教训）：PR #157 评论区（三轮：正式装配断裂 / 基线 HEAD 巧合 / 门禁哑弹）

## 六、硬约束（不可协商）

1. `blank-editor.html` 的 file:// 单文件便携性是产品特性，迁移后必须保持；
2. 两个消费端的装配行为不可静默改变（当前试点方案已做到零改动）；
3. 每批迁移必须可独立回滚；守门测试红灯只许用「接通缺口」消灭，不许豁免；
4. 提交不附 AI 署名；所有文本 UTF-8 + LF。
