# 贡献指南

感谢关注 MAW（moys-asr-workflow）！

## 提交 PR 前

1. **签署 CLA**：本项目采用 [CLA Assistant](https://cla-assistant.io/) 管理。首次提 PR 时机器人会自动请求你确认，在 PR 中回复：

   ```
   I have read the CLA Agreement and agree to it
   ```

   即完成签署（一次签署，后续 PR 自动识别）。协议全文见 [`CLA.md`](CLA.md)。

   为什么需要：项目采用 AGPL-3.0 + 商业许可双许可模式，需要贡献者授权项目所有者以任意许可分发其贡献，详见 CLA.md 说明。

2. Fork → 分支开发 → 提交 PR，commit 信息用简短中文或英文说明改动实质。

## 代码风格

- Python：遵循现有代码风格；安装环境后使用 `uv run --no-sync python -m unittest discover -s tests -p "test_*.py"`。
- 前端（web/）：LF 换行，保持既有缩进风格

前端装配检查、类型检查与浏览器回归见 [开发概览](docs/DEVELOPMENT.md)。修改 `web/` 时只维护源码，内联副本待发布前统一重生成。所有文本使用 UTF-8 与 LF。

## 许可

- 提交即表示你的贡献同意按 [`CLA.md`](CLA.md) 授权
- 项目本体许可证：AGPL-3.0-only（见 [`LICENSE`](LICENSE)）
