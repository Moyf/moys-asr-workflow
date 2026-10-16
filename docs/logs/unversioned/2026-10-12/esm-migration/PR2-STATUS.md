# PR-2（全量 ESM 真化）执行状态账本

基线：feat/editor-esm-pr1-foundation（PR-1 = cherry-pick 5ba2baa1+ddb36b7a，已验证）。
分支：feat/editor-esm-pr2-full-esm。隔离副本：.worktrees/esm-full/{baseline,naive,full}（不入库）。

## 已完成（有证据）

- 转换器工厂时代适配：full-convert（61 工厂透传、consumers 幂等）、research.mjs
  （inventory/逐文件解析 ESM 感知）、full-build→生产构建器垫片、
  build-editor.mjs 终态装配 compileEsmSources（两阶段入口：全量提升→清单序
  交错执行/注册；externalBridges 经 legacyBindings 挂载）。
- 契约门禁 E1–E10：9/9 全绿（E6 = 真实 file 页 + localhost 行为探针：
  工程注入/共享状态写/导出 SRT 全过）。教训钉子：①eslint-scope 与生成器
  两轮 .next() 驱动缺一不可（漏第二轮=语句不执行，静默）；②每改
  build-editor.mjs 必须 --write 重建再跑 E4/E6；③语义夹具无
  editor-modules.json → readModules/configText 必须可选化。
- 副本 node 全量：616 项 580 pass / 36 fail（自 55 收敛）。

## 剩余 36 失败（~10 文件，类别与修法已证）

1. 直读 vm 模式（已证修法：readFileSync(web 模块)→compileEditorFixture(file)）：
   test_ai_cleanup_local_export（slice 切片段型，需手工改为整模块 bundle+断言内联）、
   test_shared_tooltip_browser、test_asr_presets_browser。
2. window.MAWE 上下文垫片：test_editor_history_gestures（12 例，MAWE 需挂
   context.window 内；补后仍有注册点需逐个对位）。
3. bundle 契约迁移（预期项）：test_editor_bundle×2（compileSources 旧装配
   断言→compileEsmSources 契约）、test_launcher_bundle×2（launcher 仍走
   旧装配，失败原因待查——疑 meta/builderHash 联动）。
4. 退役项：test_editor_script_order（import 图取代顺序断言）。
5. adapt-production-types.mjs 为上游 PR 投影钉死工具，与本线无关，跳过。

## 未跑

副本 python 全量、typecheck（含扩全图）、e2e 子集、移植回 git 树后的三线
复跑。移植清单：web/（127 转换文件+web/package.json type:module）、
scripts/esm-mechanical 四文件适配、scripts/build-editor.mjs 终态装配、
tests/（适配+-loader 修复）。bundle 不入库（PR-1 已退）。

## 第二轮进展（同日续，上下文中断前快照）

- 契约门禁 E1–E10 稳定 9/9；E5 金丝雀换为依赖闭合（/No matching export|Could not resolve|Cannot find module/）。
- copy 内 node 收敛：616 项 597 pass / 18 fail。已修复文件：
  test_editor_history_gestures(12/0，真 ESM 导入工厂 + globalThis.window 垫片 + MAWE 桩)、
  test_waveform_display_presets(7/0)、test_editor_marker_preferences(4/0)、
  test_ai_cleanup_review_fallback(2/0)、test_ai_cleanup_local_export(9/1→进行中)、
  test_editor_bundle(5/0，金丝雀换依赖闭合契约)、test_launcher_bundle(2/0)。
- 关键基建沉淀（在 tests/helpers/editor-module-loader.mjs）：
  ①工厂感知装配；②compileEditorFixture 依赖闭包（读 full-conversion.json
  connections + import 语句，递归）；③esbuild define 注入模板占位符中性值；
  ④compileEditorBundle（全清单）。
- 已知未竟（copy 内 18 失败的分布）：
  - test_ai_cleanup_local_export 9 例：单文件 fixture 的依赖闭包不可行
    （启动链 DOM 依赖横跨全清单），已试全清单 bundle 路线（vm 需补
    document/Node/NodeFilter/CustomEvent/MutationObserver/Option/…中性面，
    已补到 i18n 遍历层，差 createTreeWalker 深链），两条路线都需收尾。
    建议：该文件改为用 E6 同款真浏览器断言替代 vm 夹具。
  - test_launcher_bundle 1 例、test_editor_script_order（退役项）等同前账。
- 集成树（本分支）web/ 未移植——移植前适配测试必然红（editor-sources.txt /
  full-conversion.json 仅存在于 copy）。移植即：copy 的 web/ + tests/ +
  scripts/esm-mechanical 四文件 → git 树，随后三线复跑。

## 下一步（新会话接手清单）

1. copy 内收尾 test_ai_cleanup_local_export（二选一路线）与 launcher_bundle 余项。
2. copy 内跑 python 全量（MAW_ESM_PYTHON 同 venv）与 typecheck（扩 include 到
   全部 ESM 文件；预期 235 类诊断，按研究报告处置）。
3. 移植：cp -r copy 的 web/（排除 bundle 产物）与 tests/ 覆盖本分支，三线复跑。
4. 全绿后提交推送，PR 描述按本账本展开。

---

# PR-2 终态（2026-10-13 收尾，取代上文所有中间快照）

## 验收锚点（更正叙事）

- 迁移前基线：**616 collected / 616 pass / 0 fail**。行为等价迁移 = 满分必须仍是满分；此前文中「55/36/18」皆为迁移过程自分数，非出发状态。
- 现状：node **606/606 pass**（606 = 616 − order 退役 1 − ai_cleanup vm→e2e 迁移 9；断言无静默丢失，全部有去处）。

## 最终验证矩阵（git 工作树实测；副本实验仅作过程证据）

| 层 | 结果 |
| --- | --- |
| node 全量 | 606/606 |
| 装配契约 | 9 项有效通过，E7 已退役（FULL_ROOT=git 树，BASELINE_ROOT=隔离副本 baseline） |
| typecheck | 110 存量基线 / 新增 0（scripts/typecheck-baseline.mjs） |
| Python | 2140 OK / 21 skip（与 main 基线一致） |
| e2e | waveform-history+click-behavior 89/2*、i18n-save+ass-export+drop+new-project+keyboard 88/0、multi-subtitle 81/0、ai-cleanup-retention 9/9 |
| e2e 基线比对 | *两失败在纯 main@a34d502a 同样红 → 迁移零回归 |

## 评审五条的落实对照

1. 停止假 DOM 膨胀 → ai_cleanup 9 例迁 e2e 真页面（spec 保留全部业务断言）；identity+隐式门面预挂把其余夹具桩压到个位数方法级。
2. 加载器确定性 → 单清单 editor-scripts.txt + 直接 import 闭包（清单序）；full-conversion.json/editor-sources.txt 退出测试输入；递归闭包教训已入注释。
3. 选择性移植 → 127 文件逐文件核对入树（排除产物）；tests 适配同样按漂移清单移植。
4. 类型门分类 → 模板层 64 setter 摘除（函数声明，逐名验证无写点）；Window/Element/Node 过渡索引签名；schema 字段补全；110 存量入基线（含词典 TS1117 跨对象 merge 不可静态去重的实测记录）；package-lock 清除。
5. 完整门禁 → 上表；「9/9 + E7 退役」措辞与逐层位置标注已执行。

## 目标边界（说准）

本 PR 证明全部源码可机械转 ESM 并由 esbuild 终态装配、三消费端行为等价全绿；仍保留 MAWE 注册表、依赖袋、兼容访问器门面与 110 条类型基线——它们属企划案 Store/命令阶段与词典人工清理，后续批次处理，不混入本迁移。

---

# 评审第二轮（2026-10-13）：可重放性与产物卫生

## 结论

评审三缺口全部落实；「从干净基线一键重现 PR2 当前结果」现在成立。

## 逐条落实

1. **转换器可重放（评审缺口 1）**
   - 根因实测：`typecheck-fixups` B 段的顶层 AST 扫描看不到生成器
     内部的函数声明——64 处 setter 摘除实为收尾期逐文件手工补丁，
     导致 12 个文件不可重放。账本此前「模板层同步修改」的表述
     与事实不符，已更正。
   - 修复：规则内化进 `full-convert.mjs`——函数声明只发布 getter
     （`mutable: false`），并加 eslint-scope 写点守卫（任一 classic
     文件对函数名的写入引用即硬失败；负控夹具验证生效）。
   - 新增 `scripts/esm-mechanical/replay-verify.mjs`：PR1 分支
     `git archive` 提取 → full-convert → 与提交的 188 个清单文件
     逐字节比较 → **ok: true（188/188，548 跨文件引用一致）**。
   - `typecheck-fixups` B/C 段退役（B 无效、C 与提交内容不一致且
     TS1117 已入基线），保留 A 段（输出逐字节不变）；教训写入注释。
2. **实验产物出库（评审缺口 2）**
   - `full-baseline-probe.html`/`full-current-probe.html`/
     `full-browser-verdict.json`/`hoisting-probe/`/`live-binding-probe/`
     共 17 个文件移出 Git；E6/E8/E9 测试运行时自生成，路径入
     `.gitignore`。注：根目录写这些探针的 `scripts/verify-editor.mjs`
     是上游 #181 既有工具（本分支未改），其产物路径未动。
3. **类型门局限（评审缺口 3，如实标注而非抵赖）**
   - 基线 110 条构成：TS2339×39、TS1117×29（词典跨对象 merge，
     静态去重会改运行时值——实测记录在案）、TS2353×15、其余 27 条
     分散；其中 TS2448（`cursorOffset` 先用后声明）确属值得单独
     核查的真代码味，已列入后续批次。`editor-legacy-dom.d.ts` 的
     索引签名是过渡放宽，文件头注明终态方向（消费侧精确 cast）。

## 第二轮验证（转换器改动后复跑）

| 层 | 结果 |
| --- | --- |
| replay-verify | 188/188 逐字节一致（PR1 基线重放） |
| 装配契约 | 9/9（FULL_ROOT=git 树） |
| node 全量 | 606/606 |
| typecheck | 110 基线 / 新增 0 |
