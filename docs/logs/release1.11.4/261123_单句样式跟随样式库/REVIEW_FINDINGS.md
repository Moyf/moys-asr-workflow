# 单句 ASS 样式跟随样式库 · 提交前独立审查

- 基线：`fix/per-cue-style`，基于 `045667a5`（origin/main）加本任务全部未提交改动（2 个新文件 + 16 个修改文件）。
- 范围：编辑器单句 ASS 样式「快照 + 自动跟随」（纯函数、wiring 模块、提示与按钮、i18n、e2e 改写、文档），不改工程格式。
- 审查方式：未参与实现的独立 agent 只读审查 `git diff HEAD` 全部改动与关键调用链（editor-state / editor-commands / editor-history / storage / cue-panel / i18n），实跑单测与静态检查，并用 node 临时探针实证纯函数边界；主会话对 finding 逐条处置。维护者复核把审查代理误判为 nit 的 R1 升级回 major，另提出 R2 与两项勘误。
- 结论（维护者复核后）：修复 R1（major）、R2 后 0 blocker / 0 major；N2 / N3 / N5 / N6 接受现状或记录为后续可选项。无未处置 blocker / major。

## Findings 与处置

### R1（major，首次审查误记为 nit）：只改过名的样式，之后改内容不跟随（已修复）

- 位置：`web/shared/utils/ass-style.js` `planAssStyleCueSync` 快速路径的回退分支。raw 相等 ⟹ 键相等，但键相等 ⇏ raw 相等；回退分支当时只查 `seen`，漏了「内容键等于改动前版本」这条腿。
- 证据（维护者实测）：句子在改名前选了样式，库里只改名再改字号，`planAssStyleCueSync` 返回 `updates = 0`（应为 3）；不改名对照组为 3。触发面不边缘：右键菜单就有「重命名」，改名前选样式的句子在下一次改内容时全部变成「工程内保存」。
- 处置：回退分支改为 `raw !== entry.beforeRaw` 时计算内容键，`key === entry.beforeKey || seen 命中` 才跳过；开销不增（raw 不等时本来就要算键）。
- 双向验证：新增单测 `planAssStyleCueSync follows a content edit after a rename`，在缺陷版上真实失败（`updates = 0`，仅此 1 条失败），恢复修复后 16/16 通过。

### R2（major，维护者复核提出）：换库后会话记录不清，撤销会把句子改成别的窗口的版本（已修复）

- 位置：`seen` 只在工程加载时清空（`editor-wiring-ass-cue-sync.js` 的 `observeProjectLoad`）。重新加载与导入经 `storageService` 直接换库（`editor-wiring-ass-storage.js` 的便携 load、服务器 load、`importLibrary` 三处），不通知同步模块；而每次打开样式库窗口都会强制重新加载。
- 影响：另一个窗口改过库之后，本窗口一次无关的撤销会经 `applyHistoryRecord` 的重对齐把这些句子悄悄改成对方的版本——与「导入、重新加载不会自动变化」的文档表述相反。
- 处置：同步模块新增 `noteLibraryReplaced(previous, next)`，把内容发生变化的样式从 `seen` 删除；storage 三处换库成功后调用（保存回读不经过这里，撤销保证不受影响；内容没变也不删）。
- 验证：`planAssStyleCueSync` 等纯函数不受影响（16/16）；e2e 两 spec 复跑 23 过 1 既有 skip。逐句的撤销观感列入人工清单核验项。

### N1（nit，已并入 R1 修复）：文档措辞与实现不符

- 首次审查建议补「内容完全相同」限定；R1 修复后语义恢复为「内容相同即跟随」，`docs/user/ASS_STYLES.md` 已删除该限定句，改为「工程里与该样式内容相同的句子会立即跟随更新，即使句子快照保存时的样式名称与现在不同」。

### N2（nit）：样式库窗口打开期间，每次工程脏态事件全量计数（接受）

- `editor-wiring-ass-manager.js` 的 `onProjectDirtyChange` → `updateAssStyleProjectHint` → `outdatedCueCount`（`planAssStyleCueRefresh` 逐句 stringify）。5000 句工程在窗口打开时每次文本编辑约多 30ms；已含在实测的 30–37ms/input 内，判定可接受。后续如再优化，可按样式库 revision + segments 指纹缓存计数（2.0 前可选项）。

### N3（nit）：英文文案无单复数（接受）

- 「1 cues in the project differ…」「Updated styles for 1 cues」。与既有数值正则规则（`${n} styles · …`）一致，i18n 无单复数基础设施，属既有模式延续。

### N4（nit，已并入 R2 修复）：导入 / 重载后 seen 不清空的时序语义

- 首次审查判定「可接受的语义模糊」；维护者复核指出影响被低估（打开样式库窗口即强制重载，撤销即触发），升级为 R2 修复。本条保留编号作勘误记录。

### N5（nit）：测试覆盖缺口（记录，不阻塞）

- rename-only 后句子下拉仍选中库样式，仅内容键单测间接覆盖（R1 修复已补「改名后改内容跟随」直接用例）；seen 跨工程清空无直接断言；reapply 只测了 undo，redo 与命令取消共用同一 `applyHistoryRecord` 入口、风险低。后续补测可选项，不阻塞本次。

### N6（nit）：`assStyleSnapshotKey` 已无生产消费方（保留）

- 全仓仅剩定义与导出表；唯一调用点已改用 `assStyleContentKey`。保留导出兼容便携页 / 外部消费，2.0 格式改造（Issue #434）时顺带清理。

## 审查者已核实、无需处置的维度

1. 纯函数边界：空库 / null / 缺 id / 空组均安全返回（探针实测）；`normalizeAssStyle` 键序固定；raw 快速路径方向正确（raw 相等 ⟹ 键相等，跳过安全），raw 不等的回退分支缺陷见 R1（已修复）；`builtin` 字段两侧同用默认 fallback，不会假分叉。
2. wiring 顺序：`afterLibraryEdit` 在 `setAssStyleLibrary` 之后、`syncAssStyleManager` 之前；seen 记录先于 apply；`reapply` 位于 `reconcileSegmentsDirty` 之后、`renderAll` 之前且 `invalidate:false` 避免重入；脏标记经 `changes.projectImportDirty` setter 与保存簿记闭环。换库清理见 R2（已修复：storage 便携 load、服务器 load、`importLibrary` 三处成功后调用 `noteLibraryReplaced`，保存回读不经过）。
3. 回归：`syncCueAssStyle` 内容键只影响改名分叉语义，「工程内保存」路径仍由 e2e 覆盖；删除样式的句子不再计数属设计决定 5；i18n 动态 textContent 走既有 MutationObserver 翻译链，旧文案全仓无残留。
4. 登记：`editor-modules.json`（cue-sync 先于 manager 初始化）、`editor-scripts.txt`、`editor-dom-panels.js`、`editor-globals.d.ts`（`MaweAssCueStyleSync?`；多余的 `MaweCuePanel` Window 声明已删，代码改用裸名走既有 `declare const`）、`observeProjectLoad` 可用性均确认；`MaweCommands.run` 第三参多出的键被 capture 安全忽略。
5. 测试：单测 10 例覆盖三轨跟随 / 改名不跟随 / 改名后改内容跟随（R1）/ 会话外旧句 / seen 命中与未命中 / 删除样式 / 新建复制，并断言纯函数不改写句子；e2e 含跟随、提示与按钮显隐、间距实测 ≥8px、三轨、undo 保持；e2e 改写未弱化关键覆盖；双向验证（R1 缺陷版上新用例失败）成立。
6. 仓库约定：UTF-8 无 BOM、LF、`git diff --check` 干净、CHANGELOG 条目格式与归属正确、无个人路径、`blank-editor.html` 未重生成、bundle 新鲜。

## 审查者运行记录

- `node --test tests/test_ass_cue_style_sync.mjs tests/test_ass_cue_style.mjs`：首次 15/15；R1 修复后 16/16。
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`：2/2 通过。
- `pnpm run check:editor`：bundle fresh；`pnpm run typecheck`：exit 0；`git diff --check`：干净。
- 主会话另行完成：chromium e2e `warma-i18n` 9 过、`warma-presets` 14 过 1 既有 skip（合计 23 过 1 skip）；5000 句性能探针 30–37ms/input（优化前 128–153ms）、下一帧 0–10ms（临时用例，跑后已删）。

## 遗留提醒

- 本分支 HEAD（045667a5）是 main 的祖先：提 PR 前需 fetch 并合并目标分支、解决冲突。
- 人工核验项（真实工程的跟随 / 按钮 / 撤销 / 导入观感）见同目录 `单句样式跟随样式库.checklist.md`；自动化通过不代替人工确认。
- 2.0 存储改造（工程内样式表 + 引用）见 Issue #434，N2 / N6 的根治都在那一步。
