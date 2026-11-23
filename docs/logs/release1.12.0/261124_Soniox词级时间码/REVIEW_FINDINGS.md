# Soniox 词级时间码修复审查

基线为 `main` 的 `37c11d1c`。独立审查者通读了实现、回归测试和变更记录。原版上运行 `python -m unittest tests.test_soniox`，51 项中两项按预期失败。CLI 回归实际写出的 MOSP 是 `segment` 粒度，独立空格用例得到 `onright`。

## 审查发现与处置

| 严重度 | 证据 | 处置 |
| --- | --- | --- |
| 中 | [词内合并](../../../../maw/soniox.py#L545) 中，`hel 100→220` 和 `lo 100→100` 合并后会把词尾缩回 100。补入回归后运行 `python -m unittest tests.test_soniox.WordFragmentMergeTests`，实际得到 `hello 100→100`，预期为 `100→220`。 | 合并词内片段时保留最晚结束点。 |
| 低 | [空白分隔](../../../../maw/soniox.py#L529) 原样附加连续换行，独立探针在 `generate_srt` 的同一条字幕中生成了空行。上述测试命令也检出 `"\\n\\nright"` 与预期 `" right"` 的差异。 | 独立纯空白只作为词间分隔符。 |

处置后 Soniox、断句、语言、Qwen、工程契约及重新断句共 216 项测试通过。CLI 回归注入模拟 Soniox 返回，验证两条 SRT 字幕、MOSP 词级时间码和工程契约。未复跑诊断文档的原始响应，也未调用云端或操作 Launcher。

## 同类问题复查

适配器对照覆盖 OpenAI 兼容接口、豆包、腾讯云、必剪、FunASR、Faster-Whisper、MOSS 和 Qwen 公用断句。模拟响应的回归在旧逻辑下出现 8 项断言失败与 1 项错误，另有 Qwen 共享构建丢弃零时长句的独立红测。

| 严重度 | 证据 | 处置 |
| --- | --- | --- |
| 中 | [本地句段](../../../../maw/local_asr.py#L542) 和顶层单时间戳仍会回退到 0–2000 ms 整段字幕。独立复跑 `python -m unittest tests.test_local_asr` 时新增的三个边界用例失败，覆盖 FunASR 说话人句段、FunASR 单时间点和 Faster-Whisper 无词句段。 | 本地适配器保留有明确时间点的句段，字幕构建时扩宽，保留说话人边界。 |
| 中 | [OpenAI 句段归属](../../../../maw/asr/openai.py#L331) 的覆盖判断忽略标点，交界处的感叹号误入下一句。在词表省略非句末逗号的加测中，`OpenAiAsrTests.test_zero_width_punctuation_stays_with_its_sentence_in_mixed_response` 得到 `["Hello", " there"]`，漏掉期待的句末 `!`。 | 共享边界优先匹配原句前缀，或匹配能补齐原句词表的句尾。 |

另外给 FunASR 字符拼词补了零宽续段用例，避免把已有词尾从 220 ms 缩回到 100 ms。最终相关 485 项 Python 测试通过，包含适配器、断句和工程契约。云端及本地模型使用模拟响应验证。
