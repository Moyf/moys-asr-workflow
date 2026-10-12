# 输出文件名开关 + RTF 标签 实施记录

任务：六个转写 CLI（qwen/bcut/soniox/tencent/openai/local）统一支持 `--no-model-tag`、
`--rtf-tag`、`MAW_STAT` 行与 asr-response 写入 `_maw`。基线：`maw/output_naming.py`
只读（rtf_tag/format_maw_stat/maw_root）；不修改 MAW.spec。

## 现状事实（以代码为准，2026-09 探明）

- qwen: 默认名 `[ts]stem.{model_tag}.{speed_tag}.srt`（ts 恒在，model_tag 恒在，
  speed_tag 恒在）；print `实际 RTF: ... ({speed:.1f}x 实时)`；debug-raw
  `output_path.with_suffix(".asr-response.json")`。
- bcut: 同 qwen 结构，tag=`bcut`。
- soniox: 同 qwen 结构，tag=`soniox`。
- tencent: **无 elapsed 计时、无 speed_tag、默认名不注入任何段**
  （`input_path.with_suffix(".srt")`），仅 debug-raw 写 asr-response。
- openai: 有整体 elapsed（span 媒体准备+转写+后处理）、无文件名注入、无 speed_tag 名；
  print `({speed:.1f}x 实时)`（speed=duration/elapsed）。
- local: `default_output_path`= `<stem>.{engine_tag}.srt`；写盘集中在
  `write_local_outputs`；无 elapsed。
- 无 in-repo 消费者解析 stdout / 依赖默认文件名。GUI 永远传 `-o`，raw 由
  `gui_workflow.raw_response_path` 自行按 srt 推导，不受影响。
- `maw.output_naming` 未进入 MAW.spec 的 local-runtime data 清单 →
  `generate_subtitle_local` 不得 import 它（否则 `test_packaging_contract` 的
  local 导入闭包断言失败且 MAW.spec 不可改）。local 需内联等价 rtf/stat 格式化。

## 决策表

| CLI | 默认（无 flag） | --no-model-tag | --rtf-tag（有效 rtf） | MAW_STAT |
|---|---|---|---|---|
| qwen | `[ts]stem.qwen3-asr-api.srt` | 去 model_tag | 追加 `.0.12x` | 末尾 |
| bcut | `[ts]stem.bcut.srt` | 去 `bcut` | 追加 `.0.12x` | 末尾 |
| soniox | `[ts]stem.soniox.srt` | 去 `soniox` | 追加 `.0.12x` | 末尾 |
| tencent | `stem.srt`（不变） | 无默认段，no-op | `stem.tencent.0.12x.srt` | 末尾（新增 elapsed 计时） |
| openai | `stem.srt`（不变） | 无默认段，no-op | `stem.0.12x.srt` | 末尾 |
| local | `stem.{tag}.srt` | 去 engine_tag | 追加 `.0.12x` | 末尾 |

- tencent/openai 默认名保持原样；它们的 model 段仅当 `--rtf-tag` 触发展开时出现
  （tencent 供应商名段受 --no-model-tag 控制；openai 本无段故 no-op）。
- speed（1/rtf）保留用于既有 print 文案；文件名一律用 rtf_tag。
- `--output` 显式时：命名完全不注入；asr-response 仍 `output_path.with_suffix`。
- debug-raw（无 --output）→ `maw_root(input_path)/f"{output stem}.asr-response.json"`，
  需 mkdir parents。

## 清单

- [x] 基线测试通过（qwen/bcut/soniox/tencent/openai_asr/local_asr/cli_cache_contract，200 OK）
- [x] qwen：flag+命名+MAW_STAT+debug-raw _maw
- [x] bcut：同上
- [x] soniox：同上
- [x] tencent：加 elapsed/rtf/stat/flag/debug-raw _maw
- [x] openai：加转写计时 rtf/命名/stat/flag/debug-raw _maw
- [x] local：flag + 内联 rtf/stat + 命名（转写后决定）
- [x] 测试更新（test_qwen/test_bcut/test_soniox/test_tencent/test_openai_asr/test_local_asr + 打包契约不受影响）
- [x] 分模块验证 + 全量测试 + git diff --check

## 验证结果

- `python -m py_compile` 六个 CLI：OK。
- `ruff check` 六个 CLI：All checks passed（tests/ 被 ruff 排除）。
- 分模块：test_qwen(15) / test_bcut / test_soniox / test_tencent / test_openai_asr /
  test_local_asr / test_cli_cache_contract / test_packaging_contract … → 247 tests OK。
- 全量：`uv run python -m unittest discover -s tests -p "test_*.py"`
  → **Ran 1218 tests, OK (skipped=6)**（skipped 为既有）。
- `git diff --check`：干净。所有改动文件无 CRLF。
- CHANGELOG [Unreleased] 🔄 变更 新增 1 条。

## 未验证边界 / 说明

- tencent/local 耗时可得性：已确认两者原本都无计时。tencent CLI 现已围绕
  `transcribe()` 计时（`duration==0` 的 file_url 路径 rtf=0 → 无 RTF 段、无 MAW_STAT）；
  local 围绕 `engine.transcribe()` 计时、时长取自 `prepared_audio` 的 `duration_ms`，
  故 --rtf-tag 生效，非"不可得"。
- tencent/openai 默认名原为纯 `<stem>.srt`，保持默认不变（`--no-model-tag` 无默认段可
  剥除时为 no-op）；`--rtf-tag` 触发展开时 tencent 附带 `tencent` 供应商段
  （受 --no-model-tag 控制）、openai 只追加 RTF 段。
- local 未 import `maw.output_naming`（MAW.spec local-runtime 清单不可改/不包含该模块，
  否则 test_packaging_contract 失败），改为模块内 `_rtf_tag`/`_maw_stat_line` 保持格式一致。
- 显式 `--output`：所有 CLI 命名完全不注入、asr-response 仍 `output_path.with_suffix`；
  GUI 走 `-o`，`gui_workflow.raw_response_path` 契约不受影响。
- 浏览器交互 / 真机转写未跑（属 CI/手工验证层）。
