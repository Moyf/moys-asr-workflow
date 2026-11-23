# 副字幕编辑与烧录：提交前独立审查

基线：`main`（`ce317294`）。独立审查覆盖字幕选区、主副绑定、ASS 预览与导出、烧录表单与服务参数，以及实际浏览器和原生对话框替身的验证边界。

## 已处置

1. **删除入口语义**：首次审查按旧要求指出混选时 `Delete` 会删除主轨。维护者随后明确了最终规则：`Delete` 只删除高亮选区；主轨右键仍可成对删除；副轨右键只删除副字幕并解绑。见 `web/editor/cues/editor-wiring-edit-shortcuts.js` 的 Delete 分派、`web/editor/cues/editor-segment-ops.js` 的 `deleteSegments` 和 `deleteExtensionSegments`。Chromium 负向用例 `Delete removes the full mixed selection` 在修复前确实保留了两条已选主字幕；现用例同时约束未选中的副字幕不得被误删、一次撤销恢复绑定。
2. **联动合并丢失副字幕坐标**：主轨合并的副轨产物未复制最左字幕的 `assOverride`。见 `web/editor/cues/editor-segment-ops.js` 的 `mergedExtension`。Chromium 用例 `merging bound main cues keeps extension color refs and the left cue position` 在修复前得到 `undefined`，修复继承位置后与直接合并副轨的规则一致。
3. **双列高亮与真实选区不一致**：旧版任一列选中时整行上色。见 `web/editor/cues/editor-selection.js` 的 `updateMultiSelectionClasses` 和 `web/editor.css` 的双列规则。现在只按轨道高亮对应列，保留行状态供导航使用；主轨分组与批量追加在 `editor-binding-align.js` 和 `editor-selection.js` 各批次末尾同步一次列状态。两条 Chromium 负向用例在修复前分别缺少所选列的高亮、分组选中视觉没有更新；新用例覆盖列级描边、三条高亮对应三条删除，以及分组点击和波形批选入口。
4. **人工核验前置条件**：首条主字幕需未绑定，否则成对选中可能产生四条高亮。核对清单已写明前置条件。

## 双向验证与剩余边界

- 旧版本右键批删会误删两条主字幕，新的 `right-click deletes only secondary cues` 用例在旧行为下实际失败。
- 用基线 ASS 布局源码作对照，新增坐标单测返回默认 `(960,980)` 而非 `(320,140)`；用基线烧录源码作对照，Launcher 取消选址后仍出现开工提示，新增 toast 断言实际失败。
- 本地通过的层级与操作见[人工核对清单](字幕编辑与烧录.checklist.md)。系统原生选址仍需维护者实机验证；真实 MP4 输出已测，但未取得反馈者原片，不承诺体积比例。
