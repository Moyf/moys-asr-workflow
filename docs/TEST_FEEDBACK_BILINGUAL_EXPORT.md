# 双语 SRT 导出反馈（2026-10-01）

基线：`feat/ass-frame-preview`，HEAD `7e25a9e`，工作区干净。用户要求调整导出菜单，新增主副字幕上下换行的整合 SRT；截图只作为菜单视觉参考。空副轨手动编辑是建议问题，先分析并回答，不自动扩大为代码任务。

| 状态 | 类型 | 反馈 | 决定 / 验证 |
| --- | --- | --- | --- |
| 已修复 | 修改 | 副字幕导出整合进菜单，主字幕重命名，增加双语整合 SRT 与 ASS 分隔 | 保留现有入口 ID；双语开启时显示主/副/整合项与分隔线，副轨无可导出文字时相关项灰显。按两轨实际时间合并，重叠时主在上、副在下，未匹配的字幕也保留；主轨维持叠加轨与首句延长导出的既有契约。Node 350/350、Chromium ASS/叠加轨联合 38/38、Python 资产/波形 45/45 通过。新增菜单截图已自查；加入文字间距 ≥8px 断言后，菜单/空副轨/现有启用导入流程 3/3 通过。 |
| 仅说明 | 说明 | 没导入第二条字幕时是否允许手动编辑副轨 | 建议启用时创建空副轨。当前 `multiSubtitleVisible()` 还要求存在 extension track；开关只设置 enabled 并询问导入，不创建轨道，导致 lane 不显示。已有副轨右键创建/编辑/撤销能力可复用；后续实现需覆盖空轨创建、导入到已有空轨、保存重开及撤销/关闭保留数据。本轮只回答建议，未改变轨道生命周期。 |

不生成仓库便携 HTML，内联副本待发布前统一重生成；不推送或发布。测试、截图与间距验证完成后记录实际结果。

## 收尾验证

- 已修复 1 项、仅说明 1 项，无待处理、进行中或阻塞项。
- Node 350/350 通过：新增时间边界错位、多行与独立副字幕、禁用/异常时间、说话人颜色引用上下文、主轨首句延长及输入不变回归。
- Chromium 联合 38/38 通过；追加菜单间距断言后相关 3/3 通过。实际点击导出主/副/整合文件，验证内容、建议文件名、禁用字幕过滤、关闭双语显隐和空副轨灰显。菜单文字间距 ≥8px，菜单截图已检查，截图不入库。
- Python 相关 45/45；全量 1754 项，1746 通过、8 跳过。TypeScript 和 `git diff --check` 通过。
- 已手动启动空白 Server，确认只监听 127.0.0.1，HTTP 页面包含新菜单；随后关闭服务器。
- 无打包、CI 或外部播放器验证。双语时间错位时输出会按两轨边界分成多条 SRT，避免文字提前出现或延后消失；未强制绑定或修改工程时间。空副轨创建/编辑建议未在本轮实现，后续可作为独立任务。

实际命令：

```sh
UV_CACHE_DIR=/tmp/maw-uv-cache node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs
MAW_E2E_PYTHON=.venv/bin/python node_modules/.bin/playwright test tests/e2e/ass-export.spec.mjs tests/e2e/overlay-track.spec.mjs --project=chromium --workers=1
MAW_E2E_PYTHON=.venv/bin/python node_modules/.bin/playwright test tests/e2e/ass-export.spec.mjs tests/e2e/multi-subtitle.spec.mjs -g 'exports main, secondary|shows disabled secondary|offers importing|exports.*SRT' --project=chromium --workers=1
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync python -m unittest tests.test_editor_assets tests.test_waveform
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync python -m unittest discover -s tests -p 'test_*.py'
node_modules/.bin/tsc -p tsconfig.typecheck.json
UV_CACHE_DIR=/tmp/maw-uv-cache uv run --no-sync python server-editor/serve.py --blank --no-open --no-waveform --port 0
git diff --check
```

## 空副轨续作（2026-10-01）

用户追加授权实现空副轨，完成后提交并更新/创建 PR。当前 HEAD `25de666`，工作区干净。远端没有该分支，也没有对应 PR；完成后新建 PR。

| 状态 | 问题 | 决定 / 验证 |
| --- | --- | --- |
| 已修复 | 启用后创建空副轨，支持手动新增和编辑 | 启用操作与空轨创建共用一次撤销；旧工程已开启但缺轨时补齐空轨，沿用现有轨道契约。Chromium 新增用例实际创建、保存文本、撤销/重做验证通过。 |
| 已修复 | 可选导入入口、空轨保存/重开/关闭/撤销 | 双语设置加入导入入口，保留启用时快速导入询问，选否仍启用空轨；空轨导入保持轨道 ID，撤销恢复为空。实际保存 JSON、重开空轨和手动字幕、关闭重开不重复建轨、旧工程缺轨补齐均已通过 Chromium 验证。 |
| 进行中 | 提交并创建 PR | 功能与验证已完成，正在提交和创建 PR；不合并或发布。 |

阶段验证：Node 350/350；TypeScript 通过；Python 1754 项（1746 通过、8 跳过）。新增空轨浏览器用例各 1/1 通过；导入入口相邻文字距离 ≥8px。截图自查发现新手引导遮挡区域，已在新增用例关闭引导并重拍，继续运行多重字幕与 ASS 联合回归。首次手动编辑测试错误使用 Esc（现有行为为取消内联编辑），已改为 Ctrl/Cmd+Enter 保存，没有修改既有快捷键语义。

用户追加要求保留原快速导入弹窗：副轨为空时启用会询问导入，选否仍启用并显示空轨，选是打开文件选择器；已有副字幕时重新启用不再询问。已恢复该流程并新增实际确认/导入测试，前一轮联合回归因需求变更主动中止，重新运行最终代码。

最终联合回归首轮 106/107 通过，唯一失败是旧多重字幕 ASS 用例仍要求 CSS 字号直接等于 ASS 字号 × 舞台比例，未计入本分支字体行框校准。已改为验证合理字号范围和主副 75% 比例，保留边距、颜色与 ASS 输出的精确断言；继续复验。全量 Node 首轮因沙箱禁止 Chromium 启动与 uv 默认缓存写入失败，授权执行并指定临时缓存后 421/421 通过。localhost Server 实际启动，HTTP 200 且包含最终空轨/快速导入源码，检查后已停止。

空副轨阶段收尾：最终 Chromium 联合 107/107 通过，含快速导入肯定/否定两路径、可选导入、手动创建/编辑、撤销/重做、保存重开、旧工程缺轨恢复及现有多重字幕交互。新增空轨/菜单截图已自查，间距断言通过。用户追加 ASS 蓝字入口 UI，见 `TEST_FEEDBACK_ASS_UI.md` 续作；一起完成后提交和创建 PR。

最新验证：ASS 蓝字入口及实际帧 Chromium 12/12，全量 Node 421/421、Python 模板资产 23/23、TypeScript 和 diff 检查通过。Python 全量此前在同次续作运行 1754 项（1746 通过、8 跳过）；之后仅改前端模板/样式/接线，并已复验相关模板契约。无功能未完成项，等待 Git / PR 收尾；无打包或外部播放器验证，内联副本待发布前统一重生成。

整批续作完成：最新Node422/422、Python1755项（1747通过/8跳过），空副轨完整联合回归均通过；其余新增ASS需求与集中浏览器验证见ASS UI反馈记录。准备提交后同步主分支并创建PR。

最终主分支同步后：Node431/431；Python1763项（1755通过/8跳过）；Chromium157个不同测试已通过（联合156/157，异步布局等待修正后唯一失败项连续3/3通过）。功能已提交906d234，无功能待处理项；准备推送并创建PR。
