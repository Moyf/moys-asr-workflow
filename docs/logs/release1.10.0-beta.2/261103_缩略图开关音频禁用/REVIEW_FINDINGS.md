# 独立自审：缩略图开关音频禁用与文案精简

- 日期：2026-11-03
- 分支 / 提交：feat/keyframes-copy-and-audio-disable @ e56270dc（基线 main@f3f45273）
- 审查方式：未参与实现的独立 subagent 通读全部 diff 与相关源文件、测试，并实际运行验证；实现者仅答疑。
- 结论：**放行**。无 blocker / major；2 条 minor、3 条 nit，处置见下表，不静默丢弃。

## 审查者实际执行的验证

- `node --test tests/test_launcher_keyframes_toggle.mjs` → 6/6 通过。
- `run_check.py -- python -m unittest tests.test_thumbnail_cache tests.test_thumbnail_media_cache` → 55 通过（含新增音频回归 2 条）。
- `run_check.py -- python -m unittest tests.test_gui_web.LauncherAssetContractTests` → 60 通过。
- `node scripts/build-launcher.mjs --write` + `--check` → bundle 构建通过且新鲜。
- `git diff --check` + CRLF 扫描 → 干净，全部 LF/UTF-8。
- 全仓 grep 旧文案（排除 docs/logs）→ 仅 CHANGELOG 基础条目（行为描述仍准确）与 `media_cache.py:152` 编辑器侧 docstring（仍准确）命中，无残留。

## 重点核查（无问题方面摘要）

- 调用时序：mediaPath 无持久化恢复路径；picker/drop 全走 `setMedia`，手输走 input 监听，预设应用与开关 change 原有调用覆盖，batch 不回写表单。
- Windows 路径：`ext()` 字符类排除 `\/` 且 `toLowerCase`，vm 测试用 `D:\Demo\song.mp3` 实测。
- payload 语义：`formPayload` 未改；预设 collect/apply 与 batch 读同一 `.checked`；后端早退在两阶段之前，unavailable 清单只打日志无错误，快速测试限长不受影响。
- 测试有效性：三层（vm 源码级、embed 管道级、probe 守卫级）各司其职，断言 probe 恰好一次、零解码、零落盘。

## Findings 与处置

| 级别 | 位置 | 问题 | 处置 |
| --- | --- | --- | --- |
| minor | `web/launcher/forms/launcher-form-sync.js:47-48` | 禁用判定是纯扩展名启发式：`VIDEO_EXTS` 之外的路径（如 `.mpg`、含视频流的 `.ogg`）一律视为音频禁用；若保留勾选，后端 probe 仍会生成画面缓存，UI「置灰=不生效」的暗示与实际行为相反。与音轨字段既有启发式同源 | **接受的风险**：探测式禁用会引入异步竞态，审查者亦认为可接受；已在启动器指南注明按扩展名判断的语义由文档兜底，动态 title 留待后续迭代 |
| minor | `web/launcher/launcher.css:1086-1093` | 注释写「整块置灰」，但规则只覆盖 `.check-field`，下方 `.hint` 未灰；同文件 `.auto-step-row.batch-unavailable`（:1133-1136）是连 hint 一起灰的先例 | **建议下轮随手修**：把 `.unavailable .hint` 纳入规则或修正注释措辞；维护者指示本轮冻结代码，未改动 |
| nit | `tests/test_thumbnail_media_cache.py:52` | docstring 称「经视频探测早退」，但该用例 mock 了 `build_base`，实际只验证 unavailable 清单的下游管道；真正的探测早退由 `test_thumbnail_cache.py:76` 覆盖 | **接受**：记录在案，docstring 收窄留待下次触碰该文件时一并处理 |
| nit | `tests/test_launcher_keyframes_toggle.mjs` | 未覆盖大写扩展名与正斜杠路径（`ext()` 实际已正确处理） | **接受**：可补一例 `D:/Demo/SONG.MP3` 防回归，不阻塞 |
| nit | `launcher-form-sync.js`（UX） | 音频禁用态无「为什么禁用」的就地说明，用户只能查指南 | **设计取舍**：`generate_keyframes_title` 补音频场景一句属后续打磨，本轮不做 |

## 人工核验待办

见同目录《缩略图开关音频禁用.checklist.md》（pywebview 实机观感、真实音频转写链路、预设共存等 5 项，全部待核）。
