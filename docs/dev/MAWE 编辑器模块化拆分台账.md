---
title: MAWE 编辑器模块化拆分台账
created_at: 2026-09-10
updated_at: 2026-09-26
status: phase1-boot-slicing
audience: 执行本轮拆分的维护者与 agent
---

# MAWE 编辑器模块化拆分台账

> **状态（2026-09-26）**：模块提取已由 #136 合入，首段启动接线已由 #154 合入。
> 当前继续完成剩余接线拆分与目录分层。完整清单和验收标准见
> [接线拆分与目录分层计划](MAWE%20接线拆分与目录分层计划.md)。

## 合并后计划（PR 合入 main 之后的执行顺序）

> 维护者于 2026-09-26 调整本轮节奏：先列全量清单，剩余接线拆分与目录分层
> 在同一分支内按检查点提交，统一提一个 PR，不按接线域逐个提 PR。
> 每个区段仍单独验证、及时更新进度；巨型模块内部重构另轮处理。

### Step 1 · boot 接线连续切段（阶段一收官）

- 历史对象：2026-09-14 的 `editor.js` 剩余约 460 条顶层语句（3,074 行）。
  #136 合并后的最新 main 已增长到 8,350 行、741 条顶层语句，后续批次必须以
  当前 AST 结果为准，不再沿用旧行号和旧计数。
- 方法：指南 §6.6 连续切段——按接线域（媒体控制/键盘/导出菜单/启动序列…）
  切成 ~30 个模块；**段间顺序即注册顺序**，不做任何"合理整理"。
- 自证三判据：① AST 逐条断言顶层语句无一被切断、各段无缝覆盖全文件；
  ② 去掉段头注释按序拼回，与原文件逐字节相同；③ 从清单复刻装配拼接，
  与原文件逐语句 AST 相同。
- 本轮出口：连续区段完整覆盖，源码拼接与装配 AST 等价，入口职责清楚。
  本轮机械拆分保留声明及作用域；“顶层裸声明归零”留给后续所有权与门面重构，
  不以入口行数代替边界验收。

#### 切段进度

- 2026-09-25，第 1 段：把 `editor.js` 文件尾 98 行、26 条完整顶层语句原样移入
  `editor-startup.js`，清单保持 `editor.js → editor-startup.js → editor-onboarding.js`。
  该段负责工程时间修复、启动装配、引导桥接、末尾筛选接线和离开提醒；未引入
  命名空间或临时调用桥接。原 `editor.js` 与新两文件按序拼接逐字节相同，清单
  装配前后的顶层 AST 相同。下一批继续从 `editor.js` 尾部向前切分，避免跨越
  未拆区段改变监听器注册顺序。

### Step 2 · 目录结构化（阶段二）

- 本轮接线拆分完成后立即推进，与 Step 1 统一进一个 PR。目录采用完整计划中
  的两层领域结构；以下旧建议树保留为历史参考，不再作为逐文件迁移清单。

- 前置（在拆分之前做，顺序敏感）：
  1. `edit.py:210` 与 `desktop/src-tauri/build.rs` 的 `path.name != entry` 清单
     校验放开为：允许 `a/b.js` 相对子路径；拒绝 `..`、反斜杠、绝对路径、非 `.js`。
  2. `server-align/serve.py:52` 的 `GAP_REMOVE_CORE_PATH` 随新路径同步。
- 方法：全部模块 `git mv` 入子目录树（100% rename 证据是验收），
  `editor-scripts.txt` 同步相对路径；目录布局纯粹用于导航，**顺序仍由清单独占**。
- 建议树（在 fork 布局基础上按本仓模块命名调整）：

  ```text
  web/
    editor-scripts.txt / editor-template.html / *.css
    shared/gap-remove-core.js          # 双端共用（对齐页注入）
    editor/boot/                       # boot / runtime / utils / i18n / onboarding
    editor/state/                      # core-state / cue-panel-state / settings / history / workspaces / colors / multi-subtitle-core
    editor/dom/                        # dom / floating-panel / help-panel / theme / ninja
    editor/media/                      # media-playback / media-step / media-load / waveform-init
    editor/cues/                       # cue-panel / cue-elements / cue-events / inline-edit / selection / binding-align / search / color-filter / merge-adjacent / segment-ops
    editor/split/                      # split-core / split-context / split-trim / split-mode / add-cue / bound-drag
    editor/export/                     # export-srt / export-timeline / dynamic-exports / export-menus / sticker-otio-export / json-repair / speaker-labels
    editor/io/                         # project-load / project-save / project-media-inputs / drag-drop / loading-progress / multi-import / server-save / server-connection / workspaces
    editor/ui/                         # preview-geometry / appearance-inputs / behavior-hints / settings-panels / display-settings / sticker-root / sticker-picker / sticker-overlay / context-menus / text-process / timed-text-edit / find-replace / text-cleanup / nav-preview / timeline / hint / jkl / gap-remove-data / gap-remove-ui
  ```

- 验收：清单级全量语法测试 + 顺序断言 + Python 全量 + 探针；无行为改动。

### Step 3 · 巨型 IIFE 拆解（阶段三，按模块逐个短分支）

- 判定标准：单文件单 IIFE 且 ≥800 行才动（行数只是提示）。
- 首批候选（按 fork 顺序）：editor-utils(5.4k) → waveform(5.5k) → gap-remove-core(1.4k)
  → split-core → timed-text-edit → i18n → cue-elements。
- 标准模式：`namespace.js`（唯一所有者，块首）+ 各模块 `Object.assign` 发布 +
  可变状态 `defineProperty` 访问器 + `compat-surface.js`（块尾，按原文字面量
  重建历史出口）。**类成员用原型混入（`Reflect.ownKeys` + 描述符复制），
  禁用 `Object.assign`**。
- 验证：三层差分（结构/源码/行为）零差异 + dryrun 产物 sha256 与落盘一致；
  每块完成后差分工具公共部分若有改动需复跑已完成块。
- 第二注入方：gap-remove-core 在阶段二移动后，serve.py 注入源改为
  `read_editor_scripts_under(...)` 按清单前缀拼接 + 占位符唯一性校验。

### Step 4 · 收尾

- 对照 main 侧 40 个预存 e2e 失败（launcher 错误处理、C 合并锚点 24px、
  bcut 命名测试等）单独建 issue，与拆分无关，不在拆分分支修。
- 发布检查时统一重生成 `blank-editor.html`（本轮全程未重生成）。
- `docs/DEVELOPMENT.md` 补充 web/ 源码地图与验证命令。

### 运维备忘

- `npm install --no-save ts-morph acorn-walk`：任何 npm install 后需重装
  （--no-save 包会互相修剪）。
- 长命令防卡死：见 `docs/AGENT_LONG_COMMAND_GUIDE.md`（后台启动 + 轮询 +
  超时后清孤儿进程）。

## 并行开发经验吸收（2026-09-16，参考外部 ChatGPT 对话「AI时代大型重构并行开发经验」）

对照外部经验（Legacy Monolith Extraction + Strangler Fig 思想）与本仓三轮
main 合并的实际代价，确认四条进合并后流程的原则：

1. **迁移必须高频小粒度直接进主干**（"extract foo() → merge → extract bar()
   → merge"），禁止再出现长驻分支。本 PR 三轮合并的 33+28 处冲突与 72 项符号
   重放就是"三周拆完一次性 merge"的结构性代价。剩余阶段（boot 切段/目录化/
   IIFE 拆解）一律短分支、合完即删。
2. **冻结入口、新功能反向推动拆分**：PR 合并后 `web/editor.js` 即为冻结的
   legacy 入口——新业务代码禁止直接加入（写进 AGENTS.md）；新功能直接写进
   所属模块，让业务开发本身推动边界细化（Strangler Fig 单文件版）。
3. **符号级重放工具是结构性冲突的机械化出口**：`tools/merge-flow.mjs`
   （来自 drunkenQCat，见 `docs/dev/符号级合并重放工作流.md`）把"上游改单体、
   本仓拆模块"的冲突解决降为 REPLAY/REMOVE/KEEP 审计。注意事项：①工具从
   HEAD 读取并**回写全部模块文件**——若 git 合并已自动带入共享文件
   （editor-utils/i18n 等）的新内容，会被 HEAD 旧版覆盖，跑完必须
   `git checkout origin/main -- <共享文件>` 恢复或复查；②工具输出必须完整
   落盘（`> log 2>&1`），绝不能接 `Select-Object -First N` 提前断管。
4. **机械拆分与人工清理分开 review**（Airbnb codemod 经验）：本 PR 只做
   物理拆分，语义整理（状态所有者、单向依赖）留给后续独立 PR，降低 review
   面积。

## 评审修复轮（2026-09-16，PR #136 → 提交 a9ee20ab…72192bd1）

维护者审查确认 4 项行为回归 + 2 项工具问题，全部修复；另用 drunkenQCat 的
`tools/merge-flow.mjs` 完成 overlay_track(#130) 合并（REPLAY 72/CONFLICT 0）。

- 六项修复：SRT 生成器、媒体尺寸采集（bindPlayerEvents×2 + loadMediaFile）、
  指纹补 media_metadata、PROJECT_NAME 归 MaweBoot 单一所有者、恢复
  waveform-deletion.spec.mjs、ruff/行尾空白清零。
- **新发现工具缺陷与修复**：`ns-rewrite-editor.mjs` 曾把局部绑定名误合规化
  （7 处局部 `start` → `MAWE_I18N.start`、2 处 `snapshotSegments`），导致
  overlay 拖动创建与定时编辑比对失效。当时用临时绑定感知审计器对全部
  72 个重放函数做 main 局部绑定 vs 本仓 NS 形态比对；参数默认值表达式的
  NS 化（8 处）为必要合规化，逐条核实。该次性脚本在合并前已移除。
- **merge-flow 使用陷阱**：工具从 HEAD 读取并回写全部 `editor-*.js`，会把
  git 自动合并带入的共享文件（editor-utils/i18n）覆盖回旧版——跑完必须对
  「main 改过、本仓没改过」的共享文件 `git checkout origin/main --` 恢复。
- 终局验证：Ruff 全过；Node 304/0；Python 1559 OK；E2E 406 用例，
  PR 43 失败 vs 纯 main(3de81a86) 44 失败，**逐 test ID 比对仅我们失败=0**，
  main 独有 1 条（OTIO metadata missing）在本树上通过。

## 第四次 main 同步（2026-09-16 晚，origin/main @ 5837aa61，6 提交）

main 并入 ASS 样式库（#135：自定义五色调色板、ASS 预览模式、样式库管理）、
叠加块行高刷新（5837aa61）、C 合并叠加路径复用（c2f12351）等。

- merge-flow：REPLAY 16 / CONFLICT 0（含 DEFAULT_EDITOR_SETTINGS、
  COLOR_PALETTE 两个变量 + 14 个函数）；24 处冲突按矩阵+重放解决。
- **merge-flow 变量重放缺陷（已修工具根因）**：`declarationRecords` 对变量
  声明的 raw 只取 declarator 文本，重放丢失 `const/let` 关键字 → 严格模式
  IIFE 下裸赋值 ReferenceError。第三轮全函数重放未触发；本轮触发两处
  （settings 的 DEFAULT_EDITOR_SETTINGS、colors 的 COLOR_PALETTE）。
  工具已改为取整条语句文本（tools/merge-flow.mjs declarationRecords）。
- **调色板家族整体迁入 MaweColors**（main #135 让调色板可变 + 带 DOM 控件）：
  COLOR_PALETTE/COLOR_BY_NAME 改 let + accessor，家族函数
  （build/rebuild/current/sync/refresh/setSubtitleColorPaletteValue）与
  7 个 DOM 常量全部归模块；入口仅留监听器接线（NS 限定）。
- **ns-rewrite 误替换重现 9 处**（同第三轮 bug：局部 `start` →
  `MAWE_I18N.start`、局部 `snapshotSegments` → `MaweHistory.snapshotSegments`）
  ——merge-flow 重建入口用 main 原文，随后 ns-rewrite 重跑时旧 bug 重现；
  第三轮的数据修复被覆盖。数据已再次修复；当时以临时绑定感知脚本 + e2e
  独有失败比对作为审计防线。工具根因尚未定位（当前文件形态下不触发，
  幂等安全），下一轮合并后必须重做等价审计。
- main 新合入 e2e 的裸全局 34 处已迁移（fix-e2e-globals 幂等重跑）。
- 维护者把 run-e2e-bg/poll-e2e 重写为三件套（maw-e2e-bg 运行目录 +
  latest.txt + summarize-e2e-report），add/add 冲突取 main 版。
- **归因（双跑）**：本树 49 vs main@5837aa61 43，交集 43；独有 6 个回归
  （overlay 拖动×2、C 合并、双击光标、ASS 说话人、禁用显示）**全部修复**
  （ns-rewrite 9 处 + e2e 迁移 34 处）；修复后单测全绿。
- **修复后全量 e2e 复跑（2026-09-16）**：409 用例 / 43 失败，与
  main@5837aa61 基线**逐项完全一致（零差异）**——我方回归清零得到最终确认。
  验证闭环完成。
- 验证状态：Ruff 全过；Node 315/0；Python 1576 OK；顺序断言过；探针零
  pageerror（连续抓到并修复三处：settings 变量关键字、appearance 跨模块
  裸调用——探针是这类加载期错误的第一道防线）。

## 第五次 main 同步（2026-09-18，origin/main @ af4fa7c1，18 提交）

main 并入：ASS 样式编辑体验打磨（074d0b5b）、字体 combobox 改版（695b422f、
39b2c105）、叠加字幕行点击设置遵循（2db86d3b）、OVL 徽标 i18n（6b32b076）、
E2E 收口（2e375f9b、813246e4）、副字幕 ASS 样式锚定（95c6f1f0）、FireRed
标点流程（dcb1f9f8）等。用户指令：**变化部分以 main 为准**。

- merge-flow：REPLAY 15 / CONFLICT 0 / KEEP 204（ASS 样式库新声明全留入口，
  待 append 扫尾归位）。入口从 main 干净重建至 9,104 行（临时态，append 后
  回落）。共享文件恢复 origin/main（editor-i18n +84、editor-utils +171、
  waveform ±7——本轮工具覆盖后按惯例 checkout 恢复）。
- e2e 全量双跑：本树 14 失败 vs main@af4fa7c1 基线 0 差异后逐个修复，最终
  本树 11 vs main@5837aa61 基线 43→**仅我们失败持续收敛至 3**。
- 已修复回归：overlay Ctrl+drag ×2、disabled subtitles、双击光标、C 合并
  （全部为 ns-rewrite 误替换复发——`MAWE_I18N.start` ×7 与
  `snapshotSegments` ×2，同第四轮根因）、e2e 裸全局 34 处、ASS requestToken
  断言 NS 化。
- **遗留 3 项（ASS 样式库交互域深层差异，待下一轮定位）**：
  1. merge join hint：spec 期望「多重字幕的设置」新文案，页面显示「双语字幕
     的设置」旧文案——origin/main 的 template:1342 也是旧文案，疑似 main 侧
     spec 先行/实现未跟上，需对照 main@af4fa7c1 的实际失败状态。
  2. keeps ASS style actions（assignment-card small 的 first() 顺序）：纯
     main 上通过、本树失败——卡片在 JS 运行时被重排或生成，attached-to-
     active-form 的实现函数需对照 af4fa7c1 排查（editor.js/editor-*.js 均
     无 ass-style-assignment-card 引用，疑在 editor-utils.js 或动态生成）。
  3. localizes approved scanned font labels：`#subtitle-font-family` 显示
     label「思源黑体」而非存储值「Source Han Sans SC」——字体映射闭包
     （subtitleFontFamilyStoredToInput/MappingOptions）已归位 appearance 模块
     并修复直调缺映射选项的问题，单测通过但 e2e 仍失败，需再查 combobox
     选项构建路径（subtitleFontFamilyComboboxEntries 已 NS 限定）。
- 验证：Node 320/0；Python 1627 OK；ruff 全过；顺序断言过；探针零
  pageerror。提交：fc51a9d6（字体域）→ bfc065be（overlay 修复）→
  c9b83d29（e2e 补齐）→ 2fd739f2（合并提交）。

### 下一 agent 待办（按优先级）

1. 遗留 3 项 ASS 域 e2e 回归定位（纯 main 对照法已证非 main 侧问题）。
2. merge-flow 的 `qualifyDeclaration` 存在与 ns-rewrite 同类的局部名误判
   隐患（参数默认值场景已验证合法，但局部绑定场景的 scope 传播需加
   acorn 级单测防护）。
3. ns-rewrite 对「函数体内 const 后在嵌套箭头函数中引用」场景的 scope
   继承需根治（数据修复已做 3 轮，工具级修复待做）。
4. 阶段一收尾（boot 切段）与阶段二/三照常推进。

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
9. **main 同步节奏**：每 2–3 批 `git fetch origin && git merge origin/main` 一次；
   冲突解决 = 把 main 对 editor.js 的改动手工搬进对应模块；合并后跑完整验证组合。
   绝不让分支长期漂移（fork 分支落后 171 提交不可合并就是教训）。

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
| 2 | 2026-09-10 | `MaweSettings`（52/318）+ `MaweMultiSubtitleCore`（48/363）+ `MaweGapRemoveData`（23/67）+ `MaweColors`（4/15）；调色板注入守卫手工随迁 colors 模块；契约测试断言同步（EDITOR_SETTINGS → MaweSettings.EDITOR_SETTINGS 等） | node --check ×6 过；顺序断言过；Node 286 pass；Python 1454 OK；blank 临时产物 0 未解析 token；探针全绿零 pageerror；隐式全局扫描仅 4 处误报（multi-subtitle 模块延迟写 editor.js 顶层 let，全局词法绑定合法） | a3e99881 + 72d4e857 |
| 3 | 2026-09-11 | `MaweDom`（327/1648，295+32 个 main 新增 DOM 常量）、`MaweCuePanelState`（10/114）、`MaweHistory`（20/121）、`MaweCoreState`（9/394）；新增 `check-test-literals.mjs` 测试字面量批量校验；契约断言同步 9 处（container/player/waveformEditor → MaweCoreState.*、DOM 常量 → MaweDom.*、push* → MaweHistory.*） | node --check ×5 过；顺序断言过（load-time 引用清单序全验证）；Node 286 pass；Python 1454 OK；blank 临时产物探针全绿零 pageerror | （本提交） |

Batch 3 执行备注：

- dom 簇实际 327 符号（fork 295），main 新增 32 个 DOM 常量全部随迁；fork 的 7 个
  旧名（subtitlePreviewSettings 等）在 main 已改名，不迁移。
- **manifest 插入顺序=执行逆序**：codemod 每次插到 editor.js 正上方，多模块批次
  中先执行的模块被后执行的挤到更早位置（本批最终序 dom→cue-panel→history→
  core-state）。契约元组以实际清单为准，勿凭执行顺序推。
- 跨模块延迟写（history 模块写 editor.js 的 lastClickedIdx 等）经共享全局词法
  环境解析，合法；扫描器的文件局部启发式对此误报，已知类别。

### Batch 4（2026-09-11）

`MaweSplitTrim`（10/10）+ `MaweSplitMode`（7/7）+ `MaweDisplaySettings`（15/27）+
`MaweSettingsPanels`（19/40，含 main 新增的编辑器设置窗口 6 符号）+ `MaweNinja`
（13/14）。验证同前（Node 286 / Python 1454 / 探针零 pageerror）。

**顺序断言首次抓到真违规并修复**：settings-panels 的 main 新增代码在加载期调用
`createFloatingPanel`（仍在 editor.js）。按 fork 方案把浮层家族整体前置——
新增 `MaweFloatingPanel` 模块（10/22：z-index 栈状态 + floatingSurfaceRoot/
IsOpen/syncLayers/bringToFront/bindActivation + createFloatingPanel），并**手工
把清单条目移到 settings-panels 之前**（codemod 只会插到 editor.js 正上方，
需要前置依赖的模块必须在跑完后手动调清单序）。editor.js:360 的 boot 注册语句
经改写为 `MaweFloatingPanel.bindFloatingSurfaceActivation` 后语义不变。

| 4 | 2026-09-11 | 五模块 + 浮层家族前置（见上） | 同 Batch 3 全套 | c0d4f8ad |
| 5 | 2026-09-11 | 十模块：`MaweMediaPlayback`(14) `MaweKeyboardTargets`(12) `MaweShortcuts`(5) `MaweMergeAdjacent`(1) `MaweAppearance`(37) `MawePreviewGeometry`(17) `MawePlaybackLoop`(13) `MaweStickerOverlay`(16) `MaweExportSrt`(12) `MaweExportTimeline`(31)，共 158 符号；codemod 新增 `symbols` 按符号名定位（行号免疫）；`gen-symbols-spec.mjs` 自动生成 spec；e2e 裸全局 `fix-e2e-globals.mjs` AST 级改写 87 处/11 文件 + 手工修 waveform-history 的 player 换装 3 处 | node --check ×11 过；顺序断言过；Node 286；Python 1454；探针零 pageerror；**全量 e2e 失败标题集合与基线完全一致（14/14，零新增零消失）** | （本提交） |

Batch 5 执行备注：

- `symbols` 定位弥补了行区间在分散符号场景的漂移脆弱性；行区间仍适用于连续块。
- `fix-e2e-globals.mjs` 的整文件绑定收集会漏改「同文件其他用例里有同名局部变量」
  的引用（waveform-history 里 4 处局部 `const player` 屏蔽了 2369-2373 的全局
  swap）——此类需人工改写为访问器形式（`MaweCoreState.player = v`）。
- e2e 全量在里程碑处串行跑，失败比对用标题集合（`%TEMP%\batch5b-e2e.json`）。

| 6 | 2026-09-11 | **main 同步**：merge origin/main（54de21c3 本地化产物命名，零冲突）；十一模块：`MaweBoot`(10/596，模板 token 数据块，清单置首) + `MaweServerSave`(27) `MaweWorkspaces`(23) `MaweProjectSave`(8) `MaweDynamicExports`(17) `MaweExportMenus`(4) `MaweProjectMediaInputs`(7) `MaweProjectLoad`(14→12) `MaweLoadingProgress`(9) `MaweMultiImport`(11) `MaweMediaLoad`(4)；e2e 二次改写 148 处/15 文件；删除 projectLoadedFromSrt 死赋值（指南 §4.5 类）；契约断言同步 ~15 处 | Node 286；Python 1458 OK；顺序断言过；探针零 pageerror；e2e 冒烟 149 过/5 失败全为基线 | （本提交） |

Batch 6 执行备注：

- **boot 修复语句必须留在 editor.js**：fork 把 `repairedGroupReferenceCount`/
  `repairedTimingCount` 两条顶层 const 并入了 project-load 模块，但它们原本位于
  editor.js 两次 `syncProjectTimebaseAndBindingOffsets` **之间**（先按 frames 同步
  →修复→再普通同步），提升到模块加载期会改变启动语义且其依赖仍在 editor.js
  （顺序断言当场拦截）。已还原到 editor.js 原位并从模块/门面/spec 中移除。
- `fix-e2e-globals.mjs` 需在每批后重跑（导出表随批次增长），幂等。
- editor-boot.js 手工调到清单首位（token 数据块先于一切消费方）。

## 第二次 main 同步（2026-09-14，origin/main @ 218ee1e0，24 提交）

main 并入 #124（字幕列表跟随/贴合边界模式/cue-list 锚点重构）、#126（波形响度
自动定标）、#107（跨工程媒体定位）、ASS 样式导出、launcher 通知等。合并要点：

- editor.js 20+13 处 delete/modify 冲突，按"已迁移区域取我方、常驻区域取对方"
  逐块解决；main 对**已迁移函数**的语义改动逐个移植进 9 个模块文件（保存指纹
  projectSaveFingerprint/inlineEditHasUncommittedText/flushInlineEditsForSave、
  播放跟随链、响度标尺 deferredReapeaksEpoch、ASS 导出选项等）。
- **合并期三类典型丢单**：① main 新增函数定义落在已搬空区域（assExportOptions/
  currentAssVideoResolution/PROJECT_NAME）；② main 新增 DOM 常量落在旧 DOM 块
  （adjacent×4、separator×2，补录进 MaweDom）；③ main 对模块内旧副本的修改
  （assignColor 的 218ee1e0 修复）。另发现并清除 6 个"main 新版回到 editor.js +
  模块旧副本"的重复声明。
- 新工具：`ns-rewrite-editor.mjs`（acorn 作用域链 NS 改写，修复了参数默认值
  误判绑定与简写属性启发式在模板串误判两个 bug）、`check-missing-symbols.mjs`
  （main 1425 顶层符号全数确认有承载）、`check-dup-decls.mjs`、`compare-fn.mjs`
  （NS 归一化逐函数对比）、`run-e2e-bg.ps1`/`poll-e2e.ps1`（后台运行+轮询，
  解决长命令假死与孤儿进程堆积问题）。

### 归因结论（对照 worktree 实测）

纯 main @ 218ee1e0 自身 e2e 失败 40 项（launcher 通知/错误处理大片、C 合并锚点
24px 漂移、bcut 默认命名测试与实现不同步等，均为 main 侧 WIP 状态）；本分支同套
件失败 43 项，其中 39 项与 main 重合，4 项我方回归（dual seam ×3 = 缺
getAdjacentBoundaryMode 选项、recolor ×1 = assignColor 修复未随迁）**已全部修复**，
回归清零。Python 1549 OK（2 失败为 main 侧预存）、Node 293 OK、探针零 pageerror。

| 8 | 2026-09-14 | 九模块：`MaweHelpPanel`(6) `MaweTheme`(1) `MaweMediaStep`(3) `MaweAppearanceInputs`(6) `MaweBehaviorHints`(4) `MaweServerConnection`(15) `MaweDragDrop`(5) `MaweStickerOtioExport`(4) `MaweJsonRepair`(5)，共 49 符号；契约断言同步 5 处（sticker-otio/server-connection/json-repair 迁移） | node --check ×10 过；顺序断言过；Node 293；Python 1549（唯一失败 = main 侧预存 bcut 测试，已在纯 main 复现）；探针零 pageerror；e2e 全量（后台模式）失败集 = main 失败集 + 0 | （本提交） |

**已知运维坑**：`npm install --no-save` 会修剪之前 --no-save 装的包（ts-morph 被
acorn-walk 安装连带清除）——每次 npm install 后重装
`npm install --no-save ts-morph acorn-walk`。长命令防卡死流程见
`docs/AGENT_LONG_COMMAND_GUIDE.md`。

### 剩余工作

- 阶段一收尾：append 模式扫尾（editor.js 剩余零散符号并入既有模块）+ boot 接线
  连续切段 + e2e 全局改写终扫。
- 阶段二：目录结构化（77→N 个 100% rename）。
- 阶段三：巨型 IIFE 拆解（utils/waveform/split/timed-edit/i18n/gap-remove 等，
  三层差分）+ 第二注入方（serve.py gap-remove 前缀拼接）。

## 阶段一模块提取完成（2026-09-14，Batch 9+10）

| 9 | 2026-09-14 | 八模块：`MaweGapRemoveUi`(37) `MaweSelection`(24) `MaweBindingAlign`(9) `MaweCuePanel`(21) `MaweCueElements`(25) `MaweColorFilter`(22) `MaweSearch`(4) `MaweInlineEdit`(12)，共 154 符号 | 语法/顺序/Python/探针全绿 | 9c09695a |
| 10 | 2026-09-14 | 六模块：`MaweSplitCore`(53) `MaweSplitContext`(1) `MaweSegmentOps`(12) `MaweCueListAnchor`(10) `MaweNavPreview`(19) `MaweCueEvents`(3)，共 98 符号；契约断言重指向 9 处 | 同上全绿 | 9c09695a |

**全量 e2e 归因**（对照 worktree）：我们 40 / 纯 main 40，失败集仅各差 1 项对向
偶发（我们多 1 条 double-click 光标用例 = 隔离时序偶发（单跑通过）；main 多
"all waveform deletion scenarios" = 同类时序偶发）。**阶段一模块提取完成：
editor.js 18,523 → 4,078 行（-78%），77 个清单条目，失败集与 main 等价。**

editor.js 余量构成：111 个顶层声明（75 函数 + 36 变量，属 append 扫尾对象）+
465 条顶层语句（= boot 接线，按指南 §6.6 连续切段处理）。

### 阶段一收尾待办（下一会话）

1. ~~append 扫尾~~ ✅ 2026-09-14 完成：editor-timeline（42 符号）、editor-speaker-labels（8）
   两个新模块 + 10 个既有模块 append 共 64 符号归位。editor.js 余 9 个顶层声明
   （boot 别名、PROJECT_NAME、boot 修复常量）。editor.js 3,074 行。
   - 教训①：append 进浮动面板模块的 load-time 实例自引用
     `MaweFloatingPanel.createFloatingPanel` 会撞上"门面未定义"——模块内自引用
     必须用裸名（探针 + 顺序断言双捕获）。
   - 教训②：`onOpen: MaweXxx.fn` 这类加载期函数引用需包成箭头延迟调用。
2. boot 接线连续切段：约 460 条顶层语句按接线域切段（三判据自证）。
3. 第二注入方核查：`server-editor/serve.py:52` 的 GAP_REMOVE_CORE_PATH 硬编码
   路径在阶段二移动 gap-remove-core.js 时必须同步。
4. 消费方子目录支持：edit.py:210 与 Tauri build.rs 的 `path.name != entry` 校验
   在阶段二前须放开（拒绝 `..`/反斜杠/绝对路径，允许 `a/b.js`）。
5. 运维：`npm install --no-save` 会互相同步修剪 ts-morph/acorn-walk——install 后
   须 `npm install --no-save ts-morph acorn-walk` 重装。
6. ~~e2e 归因~~ ✅ append 后失败集 39 ⊂ 纯 main 40（我方归零）。

| 7 | 2026-09-11 | 十模块：`MaweStickerRoot`(10/35) `MaweFindReplace`(18/18) `MaweTextProcess`(28/25) `MaweTimedTextEdit`(32/27) `MaweStickerPicker`(14/28) `MaweAddCue`(4/5) `MaweBoundDrag`(7/1) `MaweContextMenus`(8/15) `MaweTextCleanup`(5/17) `MaweWaveformInit`(2/2)，共 128 符号；契约断言同步 6 处 | Node --check ×10 过；顺序断言过；Node 286；Python 1458 OK；探针零 pageerror。**待办：本批全量 e2e 尚未跑**（先合并 main 再统一跑） | （本提交） |

Batch 2 执行备注：

- 多模块批次按"最高行号优先"执行 codemod（settings → multi-subtitle → gap-remove-data →
  colors），上方区间的行号不受下方删除影响；每次运行前用 `map-fork-module.mjs` 重映射。
- `map-fork-module.mjs` 改为读工作区 editor.js（含未提交改动），不再读 HEAD。
- settings 簇与 fork 的差异：main 已把 normalize*/clamp* 收进 editor-utils.js，
  editor.js 只留别名块——别名块随 settings 模块迁移（load-time 访问
  `window.AsrEditorUtils.*`，清单序在前，安全）。

### Batch 2 后浏览器层冒烟

`new-project / click-behavior / editor-i18n-save / keyboard-timing` 四个 spec：
58 passed / 4 failed，4 个失败全部命中预存清单（零新增回归）。
预重构 Playwright 基线 JSON 存于 `%TEMP%\baseline-e2e.json`（未入库，
失败标题集合已抄录上表）。

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

## 台账遗留 3 项处置与限定器工具链加固（2026-09-20，drunkenQCat 协作分支）

第五次同步「下一 agent 待办」逐项处置，全部有实测证据：

### ① 遗留 3 项 ASS 域 e2e 回归 → 1 项已修复，2 项为 main 侧基线失败

纯 main 对照法复跑（MAW_E2E_PYTHON 钉主仓 venv，chromium 1.62.0，workers=1）：

| 用例 | 本树 8797dec7+ | 纯 main 42656d84 | 纯 main af4fa7c1（同步基点） | 结论 |
| --- | --- | --- | --- | --- |
| localizes approved scanned font labels（multi-subtitle.spec） | ✅ pass | — | — | fc51a9d6 字体域修复已生效，**关闭** |
| merge join hint shows detected main type（cue-color-filter.spec:438） | ❌ | ❌ | ❌ | **main 侧 spec 先行**：spec 期望「多重字幕的设置」新文案，main 自己的 template:1341-1342 仍是「双语字幕的设置」旧文案，两树同源同断言失败，**非本 PR 回归，关闭**（修复归属 main） |
| keeps ASS style actions…（ass-export.spec） | ❌ | ❌ | ❌ | **main 侧 spec/实现不一致**：spec 期望首张 assignment-card 是烧录字幕文案，DOM 首张是「ASS 导出使用此方案及其动画；双语字幕的副字幕样式…」卡片，两树同断言失败，**非本 PR 回归，关闭**（台账原记「纯 main 上通过」不成立，推测当时基线失败清单未随 spec 更新刷新） |

即第五次同步后「仅我们失败 = 3」实际为「= 1」，且该 1 项已随 fc51a9d6 修复。

### ② + ③ 限定器工具链 scope 根治（两提交）

- `70fb9722`：ns-rewrite-editor 换用 eslint-scope 作用域内核（globalScope.through
  为权威未解析集），根治 for-of 头/catch 参数/嵌套块 var 提升三类局部名误改写；
  顺带修复 shorthand 双重改写损坏（acorn shorthand key/value 为两个独立节点，
  旧判定 key===value 恒 false，同 span 叠加编辑产出语法合法但语义损坏的成员链，
  重放入口实测 8 处）。重放入口 A/B：旧 2459 / 新 2451 处，8 处差异全部为旧版
  shorthand 损坏。坑：eslint-scope 的 ecmaVersion 必须传数字，"latest" 会静默
  退回 ES5 语义。
- `7f720846`：抽出共享核 scope-core.mjs；merge-flow 的 qualifyDeclaration 增加
  moduleLocalNames 豁免（模块 IIFE 顶层已有绑定的名字不跨模块限定，即遗留 ②
  的隐患本体），qualifyEntry 换核后嵌套参数/局部遮蔽不再误限定；merge-flow
  加 import 守卫并导出限定器。新增 22 个作用域回归用例，全量 node 342 pass。
  冒烟：resolve --dry-run --theirs origin/main → REPLAY 22 / CONFLICT 0。

### 工具链汇合（2026-09-22，合并上游 57ad2403 后）

上游 238fb6a7 与协作分支 7f720846 是同一病灶（MAWE_I18N.start 误限定）
的独立修复，解冲突取长补短后（2721ecc9）：

- 限定器保留 eslint-scope 精确实现：平面/全文件豁免在同一文件存在同名
  绑定时会压制所有真限定（23k 行入口里 `start` 这类名字几乎必现局部），
  scope-core 按词法解析后该限定的照常限定、该保持的保持；shorthand
  key===value 误判随文本特判一并移除（该形态会触发 applyEdits 的
  overlapping edits 报错，工具中断）。
- 吸收上游 moduleBaseSource（模块底稿优先取干净合并的工作区版本），
  该修复协作分支此前没有。
- 汇合后验证：node 全量 360 pass / 0 fail；npm run typecheck 通过；
  ns-rewrite v2 在第六次同步后的入口上改写 0 处、自检通过；此前跟踪的
  3 项 e2e（join hint / ASS style actions / 字体 label）复跑全部通过
  ——其中前两项经纯 main 对照法证实为 main 侧基线失败，已由 main
  feaf10e4 修复并随同步进入本分支，定责闭环。
