# MAWE 编辑器命令面板（Command Palette）实施计划

统一检索与执行编辑器命令的入口。用户无需记住命令所在的菜单：按 `Ctrl/Cmd+K` 后即可搜索并执行；面板同时提示现有快捷键。参考 VS Code（注册表 + 分类 + 快捷键徽章）、Obsidian（`checkCallback` 可用性谓词）与 Linear/Slack/GitHub 的 `Ctrl+K` 网页惯例。

完整命令盘点见 [盘点底稿](command-palette/INVENTORY.md)。Phase 1 已实现，使用说明见 [编辑器指南](../user/EDITOR_GUIDE.md#搜索命令)。Phase 2、3 仍为计划。

## 现状事实（设计输入）

盘点基线：本 worktree（sparkles-命令面板），2026-11-18。

1. 命令入口约 180–200 个（合并去重后）：194 个固定按钮/菜单入口、65 个右键菜单项、约 109 条全局按键绑定（另约 21 条元素级、27 条编辑态内）。另有 4 类动态数量入口：最近工程、说话人子菜单、颜色筛选、左右添加字符预设。
2. 入口分三种 handler 形态：门面函数直调（约 40%，如 `MaweSegmentOps.mergeSegments`）、稳定 DOM id 按钮（约 50%，如 `#gap-remove-scan`）、运行时动态生成（约 10%）。
3. `MaweCommands.run(label, mutate)` 是**撤销事务**（快照/发布/恢复），不是命令注册表。新机制的命令 id 体系与其正交；修改工程的命令在 `run()` 内部继续走 `MaweCommands.run`。
4. 快捷键分散在约 19 个源文件的 `document.addEventListener('keydown')`，**没有集中 keymap 表**。因此第一阶段徽章只做展示，不接管按键。
5. 全局非编辑态字母键仅剩 E、P、U、Y 未占用；`Ctrl/Cmd+K` 完全空闲（全仓库唯一 Ctrl+F 在纯文本编辑弹窗内）。
6. 可复用基础设施：`MaweKeyboardTargets` 守卫判定、`MAWE_I18N.translateText`、设置搜索的「input + ↑↓/Enter 导航」现成交互（`editor-wiring-settings-help.js`）、`MaweSettingsPanels.openEditorSettingsAtTab()` / `MaweHelpPanel.openHelpAtTab()` 跳转、`MaweHint.flashHint` 反馈、localStorage 持久化先例（如 `mawe-filmstrip-mode`）。

## 命令契约

```js
// web/editor/ui/editor-command-palette.js —— 新 ESM 工厂，冻结门面挂 window.MaweCommandPalette
register({
  id: 'subtitle.merge-selected',   // 稳定 id：<领域>.<动作>；为将来用户自定义键位留路
  category: '字幕编辑',             // 面板分组，显示为「字幕编辑: 合并所选字幕」
  title: '合并所选字幕',            // 中文为 key，经 MAWE_I18N.translateText 出英文
  keywords: ['merge', '合并', 'C'], // 搜索别名：中文、英文、快捷键字面
  shortcut: 'C',                    // 仅展示徽章，不接管按键（第一阶段）
  when: () => MaweSelection.selectedIdxs.size > 1,  // 谓词，false 则列表不显示
  run: () => MaweSegmentOps.mergeSegments([...MaweSelection.selectedIdxs]),
})
```

- `when` 采用 Obsidian `checkCallback` 语义：不满足即不显示（不占位、不置灰）；个别需要「可见但置灰」的命令另加 `disabled()` 字段。
- `run` 必须同步返回或返回 Promise；修改工程的动作用 `MaweCommands.run` 包裹以进入撤销历史。
- 三种 handler 形态均被容纳：门面直调、`MaweDom.xxx.click()`（合成点击，与工具栏按钮同一代码路径）、设置/帮助跳转。

## 三条注册通道

| 通道 | 用途 | 时机 |
|---|---|---|
| 静态集中定义（`editor-command-defs.js`，按分类分区） | 约 90% 固定命令，一处盘点、易于审查与测试 | 启动时批量注册 |
| 领域动态注册（`register()/unregister()`） | 条件存在的功能命令，如「交换主副字幕」随副字幕轨启停 | 领域 wiring 内调用 |
| 惰性 provider（`registerProvider(() => defs)`） | 数量不定的动态入口：最近工程、说话人分配、颜色预设 | 每次打开面板时求值 |

## UI 与交互

1. 入口：`Ctrl/Cmd+K`（全局，含文本编辑焦点内；输入法组词中放行——沿用 cue-quick-edit 的 `isComposing` 守卫先例）＋ 工具栏可见的「搜索命令」按钮。部分浏览器可能保留该组合键，遇到冲突可点击按钮。
2. 结构：复用设置搜索的输入框和结果列表。用上下方向键、`Home` 和 `End` 选择命令，按 `Enter` 执行。打开时记住焦点，按 `Esc` 关闭后恢复焦点。样式基调对齐设置窗口，遵守 UI 间距约定（实测 ≥ 8px）。
3. 空查询：最近使用（localStorage `mawe-command-palette-recents`，只存命令 id 不存工程内容）+ 少量高频建议。
4. 搜索：subsequence 模糊匹配 `title/category/keywords`，中英文与快捷键字面皆可命中；后续可加拼音首字母。
5. 执行反馈：执行后关闭面板；命令自身的 `MaweHint.flashHint` 即为结果反馈。
6. 条目右侧展示快捷键徽章（第一阶段为纯展示，教学面定位）。
7. 面板打开期间，键盘事件不会落到编辑器的全局监听器；搜索框仍可正常输入、组词和编辑。Phase 1 不在已有模态弹窗上叠加命令面板，避免打断正在进行的编辑。

## 分期

### Phase 1 —— 最小可用（registry + 面板 + 高频 40 命令）

命令全部为低风险 handler（门面直调或稳定 id 点击），不依赖复杂 `when`：

| 分类 | 命令（徽章） |
|---|---|
| 文件与工程（8） | 新建工程、打开工程、保存工程（Ctrl+S）、另存为（Ctrl+Shift+S）、导入媒体、导入字幕、导入歌词、导出工程 |
| 播放（6） | 播放/暂停（Space）、后退、前进、跳到开头、跳到结尾、全屏（Home/End 随编辑器焦点改变行为，不标徽章） |
| 视图与工具（11） | 选择工具（V）、分割工具（R）、多行波形、单行波形、双语字幕、重叠字幕、字词时间码（Q）、标记编辑（M）、列表跟随播放、编辑布局、工作区选择 |
| 面板与批量（7） | 静音空隙、标记与区段、拼合字幕、延长字幕、工程音量、纯文本编辑、字幕处理 |
| 设置与帮助（8） | 工程设置、全局设置、设置：拆分合并、设置：播放预览、帮助、帮助：快捷操作、快速上手、编辑设置 |

J/K/L 三键不进 Phase 1：其行为内联在 keydown 处理器中且随模式变化，无干净门面，待 Phase 2 抽取。

验收门槛：`Ctrl+K` 打开/搜索/执行/Esc/焦点恢复正常；空查询显示最近使用；徽章正确；中英文切换即时生效；新增模块登记三处（`web/editor-modules.json`、`web/editor-scripts.txt`、HTML 模板块）并重建 bundle；间距实测；截图自查。

### Phase 2 —— 编辑命令全量

字幕编辑（拆分/合并/删除/颜色槽/表情包/启用禁用/调整时间/左右添加字符）、双语与绑定（G/Shift+G/H/交换/导入副字幕）、导出全量（SRT/ASS/OTIO/FCP7/Lottie/绿幕/烧录/去空隙系列）、波形外观动作（振幅/缩放/适配）。此期命令普遍带 `when()`（选中数、副轨启用、已绑定、有媒体等），盘点底稿的「生效条件」列即谓词输入。

验收门槛同 Phase 1，另加：`when` 过滤与实际可用性一致（对照右键菜单显隐）；改工程命令全部进入撤销历史（`Ctrl+Z` 可回退）。

### Phase 3 —— 动态与进阶

惰性 provider（最近工程、说话人分配、颜色筛选）、frecency 排序、拼音首字母、为用户自定义键位预留的 id 稳定化审计。

## 非目标与边界

- 不接管、不迁移任何现有按键绑定；keymap 集中化是独立后续项（届时命令 id 已就位，可逐条对接）。
- 不改动 `MaweCommands` 事务语义。
- 不在面板内做参数化命令（带输入的命令打开其原生弹窗，如拆分弹窗）。
- 设置项本身（toggle/输入框）不进面板，只提供「跳转到设置项」命令。

## 文件落位与测试

1. 新增 ESM 模块：`web/editor/ui/editor-command-palette.js`（registry + UI 工厂）、`web/editor/ui/editor-command-defs.js`（静态命令定义，按分类分区）；登记 `web/editor-modules.json` 与 `web/editor-scripts.txt`；HTML 模板加面板容器与工具栏入口按钮；CSS 走编辑器现有样式约定。
2. 构建验证：`node scripts/build-editor.mjs --write`、`pnpm run check:editor`、`node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`。
3. 单元测试：registry 为纯工厂可直调（参照 `createEditorCommands` 的测试方式）；对页面/内联脚本的成员断言继承 `tests/compact_assertions.py` 的 `CompactContainerAssertions`。
4. e2e：新增单 spec（`-g` 过滤运行），覆盖打开、搜索、执行、Esc、焦点恢复；遵守 e2e 运行纪律。
5. 手动验收：`uv run --no-sync python server-editor/serve.py --blank`，实测间距数据、中英文切换、截图自查涉及区域。
6. 用户可感知，发布时登记 CHANGELOG（【🚀 全新特性】或【✨ 提升】由维护者判断）。
