# RTF 文件名撤销 + 组合标记本地化 波 5 实施记录

任务：撤销「RTF 进文件名」全部功能（A），同时把双语/合并文件名标记本地化（B）。
基线：输出文件目录重构（波 1）+ RTF 重命名（波 2）+ 翻译段本地化（波 4）已完成，
1246 全绿。本波不跑 `edit.py --blank`，不改 docs/、CHANGELOG.md（波 5 收尾统一更新）。

## 决策（用户明确，不更改）

### A 撤销 RTF 文件名
- 六个转写 CLI 删除 `--rtf-tag` 参数 + 文件名 rtf 段拼接（恢复模型段+可选时间戳），
  保留 `MAW_STAT rtf=` 输出行、`实际 RTF:` 文字打印、rtf/speed 变量计算。
- local CLI 同样删 `--rtf-tag` 与内联 `_rtf_tag`；`_maw_stat_line` 保留。
- GUI：删除 run_transcription 的 MAW_STAT 解析 + srt/mosp/html 重命名块；
  EffectiveConfig/effective_config 删 `attach_rtf_rate`；gui_web 删下发与 save_prefs 键；
  前端删 checkbox/STRINGS/回填/监听；`.env.example` 删键。
- output_naming 删 `rtf_tag`（`format_maw_stat`/`parse_maw_stat` 保留）。

### B 组合标记本地化（zh 界面）
| 内部 operation | zh 界面 | en 界面 |
|---|---|---|
| `translate-zh` / `translate_zh` | `.翻译为中文` | `.translate-zh`（逐字节） |
| `translate-zh-bilingual` | `.翻译为中文.双语合一` | `.translate-zh-bilingual`（逐字节） |
| `translate-zh-combined` | `.翻译为中文.整合` | `.translate-zh-combined`（逐字节） |
| `translate-en-*` 同构 | `.翻译为英文.*` | `.translate-en-*`（逐字节） |
| `translate_zh-bilingual`（下划线 base + 连字符标记，工具箱） | `.翻译为中文.双语合一` | `.translate-zh-bilingual`（legacy ASCII 清洗，逐字节 = 改动前） |
| 终稿双语后缀 | `.后处理.双语合一` | `.postprocess.bilingual`（逐字节） |
| 未知 target（`translate-ja` / `translate_ja_bilingual`） | `.translate-ja` / `.translate-ja-bilingual` | 同左（逐字节） |

- marker 常量（`BILINGUAL_ARTIFACT_MARKER`=bilingual）内部 ID 不动；递归防护 pattern
  扩展为同时识别 `bilingual` 与 `双语合一`；媒体反查表（media.py + server.rs）增加
  `.双语合一`/`.整合` 剥离（中段与终端两种形态）。

## 清单（状态）
- [x] output_naming：删 rtf_tag + __all__/docstring；translate 模式双分隔符 + 标记显示名
- [x] 6 个 CLI：删 --rtf-tag 参数与拼接段（保留 MAW_STAT/实际 RTF）
- [x] gui_workflow：删 MAW_STAT 解析重命名块与函数、清理 import
- [x] gui_config / gui_web / web/launcher(index.html+launcher.js) / .env.example：删键与 UI
- [x] 测试删减：CLI(--rtf-tag) / gui_workflow(RTF 重命名) / gui_config / gui_web / launcher_batch
- [x] postprocess_pipeline：bilingual_suffix 经 translation_marker_name 本地化（ui_language 传入已确认，run_postprocess_pipeline → _publish_final 链路）
- [x] postprocess.py：BILINGUAL_ARTIFACT_PATTERN 识别 bilingual 与 双语合一；命名路径由
      _operation_file_token（postprocess_io）覆盖，run_llm_postprocess merge_bilingual 不变
- [x] media.py + server.rs：反查表加 `.双语合一`/`.整合`
- [x] postprocess_io：_operation_file_token 与 output_naming 对齐 + docstring
- [x] 测试：output_naming / postprocess / postprocess_pipeline / postprocess_io / media
- [x] 全量 discover + node --check + git diff --check + 无 CRLF 检查 + ruff

## 验证结果（原文）
- `uv run python -m unittest discover -s tests -p "test_*.py"`：
  `Ran 1238 tests in 33.781s / OK (skipped=6)`（基线 1246 → 删减后 1238）
- `uv run ruff check`（14 个 maw + CLI 文件）：`All checks passed!`
- `node --check web/launcher/launcher.js`：OK（NODE_OK）
- `cargo fmt --check -- src/server.rs`：server.rs 无差异；仅 lib.rs 有既存格式差异（非本改动）
- `git diff --check`：exit=0 干净；全部改动文件无 CRLF（逐字节脚本检查）

## 未验证边界 / 说明
- Rust 侧仅做 rustfmt 语法解析；无 target 缓存，未跑完整 `cargo build/check`。
- 真实 GUI / 浏览器端到端（Launcher 设置面板、MAWE 工具箱翻译）未人工验证：checkbox
  移除经 `node --check` + 静态 grep（无残留 attachRtfRate 引用）确认，命名与防护矩阵
  经单元测试 + sanity 脚本锁定。
- zh 界面终稿双语为 `.后处理.双语合一`：真实管线内 mergeBilingual 的最终发布由
  `_publish_final`（ui_language 显式）决定；中间 run 目录产物（`_merge_bilingual_subtitles`
  等，lang 走默认 config）不做最终发布断言。
- en 逐字节回归仅由单元测试锁定；未对旧版真实产物目录做整体 diff。
- `.env` 与本地媒体/个人路径未被读取/写入；测试全部 mock，不依赖真实 .env。
- docs/、CHANGELOG.md、blank-editor.html、MAW.spec、server-editor/、edit.py 未改
  （波 5 收尾统一更新）。
