# Soniox 词级时间码修复审查

基线为 `main` 的 `37c11d1c`。独立审查者通读了实现、回归测试和变更记录。原版上运行 `python -m unittest tests.test_soniox`，51 项中两项按预期失败。CLI 回归实际写出的 MOSP 是 `segment` 粒度，独立空格用例得到 `onright`。

## 审查发现与处置

| 严重度 | 证据 | 处置 |
| --- | --- | --- |
| 中 | [词内合并](../../../../maw/soniox.py#L545) 中，`hel 100→220` 和 `lo 100→100` 合并后会把词尾缩回 100。补入回归后运行 `python -m unittest tests.test_soniox.WordFragmentMergeTests`，实际得到 `hello 100→100`，预期为 `100→220`。 | 合并词内片段时保留最晚结束点。 |
| 低 | [空白分隔](../../../../maw/soniox.py#L529) 原样附加连续换行，独立探针在 `generate_srt` 的同一条字幕中生成了空行。上述测试命令也检出 `"\\n\\nright"` 与预期 `" right"` 的差异。 | 独立纯空白只作为词间分隔符。 |

处置后 Soniox、断句、语言、Qwen、工程契约及重新断句共 216 项测试通过。CLI 回归注入模拟 Soniox 返回，验证两条 SRT 字幕、MOSP 词级时间码和工程契约。未复跑诊断文档的原始响应，也未调用云端或操作 Launcher。
