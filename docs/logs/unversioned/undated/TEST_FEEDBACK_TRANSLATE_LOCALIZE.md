# 翻译段本地化（波 1 增补）实施记录

任务：`.translate-{target}` 翻译文件名段按界面语言本地化。zh 界面产出
`.翻译为中文` / `.翻译为英文`（含 `.bilingual` / `.combined` 组合：段本地化、
标记保留英文点分隔）；en 界面逐字节不变。递归防护与媒体反查需同时识别新旧命名。

基线：输出文件目录重构（波 1）已完成，1236 全绿。本任务不跑 `edit.py --blank`，
不改 docs/、web/、generate_subtitle_*。

## 决策（沿用已定格式，不更改）

| 项 | zh 界面 | en 界面 |
|---|---|---|
| 纯翻译 `translate-zh` | `.翻译为中文` | `.translate-zh` |
| 纯翻译 `translate-en` | `.翻译为英文` | `.translate-en` |
| `translate-zh-bilingual` | `.翻译为中文.bilingual` | `.translate-zh-bilingual` |
| `translate-en-combined` | `.翻译为英文.combined` | `.translate-en-combined` |
| 未知 target（如 `translate-ja`） | 原样 `.translate-ja` | 原样 |
| marker / `-N` / `.postprocess` | 逻辑不变 | 逻辑不变 |

## 清单

- [x] output_naming.py：TRANSLATION_TARGET_NAMES + translate 模式 + operation_suffix 扩展
- [x] postprocess_io.py：_operation_file_token 已知判定扩展（点分隔标记保留）
- [x] postprocess_pipeline.py：_publish_final 最终译文名经 operation_suffix 拼接
- [x] postprocess.py：_reject_recursive_translation_input 同时识别 `.翻译为中文/英文`
- [x] media.py + server.rs：媒体表加中文翻译段剥离
- [x] 测试：test_output_naming / test_postprocess_io / test_postprocess.py（递归 zh 新命名）
- [x] test_postprocess_pipeline.py（zh `.后处理.翻译为英文.srt` 断言更新 + zh target 用例）
- [x] test_media.py（中文翻译段剥离断言）
- [x] 验证：目标模块测试 + 全量 discover + git diff --check

## 验证结果

- `uv run python -m unittest tests.test_output_naming tests.test_postprocess_io tests.test_media tests.test_postprocess_pipeline`：Ran 91, OK
- `uv run python -m unittest tests.test_postprocess`：Ran 77, OK
- `uv run python -m unittest discover -s tests -p "test_*.py"`：**Ran 1246 tests, OK (skipped=6)**（改动前基线 1236，本次 +10 个测试方法）
- `uv run ruff check`（改动 5 个 maw 模块 + 5 个测试文件）：All checks passed（顺手移除 output_naming 未使用的 `import os`，wave1 遗留）
- `git diff --check`：干净；改动文件无 CRLF（脚本逐字节检查）
- `cargo fmt --check`（desktop/src-tauri）：server.rs 语法解析通过（仅 lib.rs 有既存格式差异，非本改动）

## 未验证边界 / 说明

- Rust 侧仅做语法解析验证（cargo fmt）；无 target 缓存，未跑完整 `cargo build/check`，
  server.rs 编译与运行行为未在真机验证。
- 真实 GUI 界面（zh/en）的端到端人工验证未做：产物名矩阵与防护矩阵经单元测试与
  sanity 脚本锁定，未在真实浏览器/桌面启动一次完整翻译管线。
- toolbox（MAWE 内置翻译，operation `translate_zh`/`translate_en` 下划线 ID）与
  混合下划线形态（`translate_zh-bilingual`）不命中 translate-* 命名形态，两种界面
  都保持 legacy ASCII 命名（`.translate-zh` / `.translate-en-bilingual`）——这是
  决策的一部分（只变管线产物显示层，不改内部 ID），非缺陷。
- 最终译文 SRT 文件名 `clip.后处理.翻译为中文.srt` 等与 `.postprocess` 主后缀、
  `-N` marker、`.bilingual` 标记组合后可能出现既有同名冲突（`-2` 计数递增），
  语义与改动前一致。
