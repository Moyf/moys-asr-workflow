# 视频术语提取工具（OCR → 热词）计划

目标：游戏录像经 OCR 提取专有术语候选，AI 语义筛选 + HTML 人工确认后汇总为热词表，供 ASR 转写与后续 AI 处理使用，减少「真希→珍惜」类同音错字。

- 当前阶段：**M1 独立工具已完成**（`tools/term-extract/`，不接 Launcher、不进打包；待维护者实测）。
- 完整分支提交前复核补齐 AI 推荐、v3缓存/证据发布、扫描连续性与导出边界，实际验证及未测范围见 [独立复核](../logs/release1.11.0/261110_工具页规范同步/REVIEW_FINDINGS.md)。M1 边界不变，不扩大到后续 UI 接入。
- 完整规格、边界与合并预留点见 [tools/term-extract/SPEC.md](../../tools/term-extract/SPEC.md)。
- 依托现有能力：OCR runtime（PP-OCRv6 tiny/small）扩展 raw-blocks 通用 `scan` 模式；工具箱 AI 处理的 LLM 通道；热词校验规则。
- 后续：M2 工具箱 UI 接入 → M3「应用到热词」→ 编辑器同音可疑点校对（单独立项）。
