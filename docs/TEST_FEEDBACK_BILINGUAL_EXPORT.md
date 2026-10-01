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
