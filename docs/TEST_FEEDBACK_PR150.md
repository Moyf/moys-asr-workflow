# PR #150 审查修复记录

## 问题与处理

| 问题 | 状态 | 处理结果 |
| --- | --- | --- |
| 覆盖预设时写入失败可能破坏旧文件 | 已修复 | 在目标目录创建单个临时文件，写入、flush/fsync、关闭后 os.replace；失败清理临时文件，清理错误不覆盖原始异常。无需创建临时子目录。 |
| 工作流文档缺失 Qwen-Audio 3.1 与方言参数 | 已修复 | 恢复模型及 --keep-dialect 说明，保留预设章节，移除重复标题。 |
| 最终代码回归 | 已修复 | 完整 Python、前端基础、预设浏览器与 Ruff 检查通过。 |
| 远端 CI / 打包 | 仅说明 | 本地回归不能替代远端 CI；推送后查看对应提交的检查结果，未进行本地打包。 |

## 修改区域

- `maw/asr_presets.py`：安全覆盖保存；`tests/test_asr_presets.py`：正常覆盖、部分写入失败、fsync 失败及替换失败，验证旧预设完整可读且清理临时文件。
- `tests/test_asr_presets_browser.mjs`：明确断言载入预设后切换供应商的语言恢复，以及模型说明和价格的独立渲染。
- `docs/WORKFLOW.md`：恢复上游说明；`CHANGELOG.md`：整合进识别预设条目。

## 验证

- `.venv/Scripts/python.exe -m unittest discover -s tests -p test_asr_presets.py`：10 项通过。
- `node --check web/editor.js`、`node --check web/waveform.js`、`node --check web/launcher/launcher.js`：通过。
- `node --test tests/test_editor_utils.mjs tests/test_waveform_js.mjs`：334 项通过。使用可写的 `UV_CACHE_DIR` 和 `UV_NO_SYNC=1`；初次运行 4 项因 uv 缓存权限失败。
- `node --test tests/test_asr_presets_browser.mjs`：通过。通过 `MAW_TEST_PLAYWRIGHT` 指向已安装 Playwright、`MAW_E2E_CHROMIUM_PATH` 指向本机 Chrome，无需新增依赖。
- 额外浏览器检查：Qwen、Soniox、OpenAI 模型说明与价格，以及 OpenRouter / 自定义地址切换，通过，无页面脚本错误。
- `.venv/Scripts/python.exe -m ruff check`：通过。
- `git diff --check`：通过。
- 完整 Python 初次运行 1686 项，15 项错误、12 项跳过；解除测试目录访问限制后剩 7 项错误，定位到 Windows 默认 GBK 与子进程 UTF-8 输出不一致，以 `PYTHONUTF8=1`、`UV_NO_SYNC=1` 在正常本机权限下运行 `.venv/Scripts/python.exe -m unittest discover -s tests -p "test_*.py"`：1686 项中 1674 通过、12 跳过，无失败。

## 验证边界

失败场景使用故障注入，未模拟实际断电或网络盘 ACL；原子替换不代表所有文件系统下的断电持久性保证。未修改前端产品源码、未重生成 blank-editor.html，未运行全部 E2E 或本地打包。远端检查结果需对应最终提交另行确认。
