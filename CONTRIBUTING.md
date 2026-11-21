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
3. 按[根 AGENTS 的 PR 规则](AGENTS.md#pr-与发布)同步实际目标仓库与分支。

## 开发与验证

代码沿用所在模块的风格，文本使用 UTF-8 与 LF。环境准备、源码装配和分支支持范围从[开发概览](docs/INDEX.md#engineering-development)进入。常用本地入口在[调试工作流](docs/engineering/DEBUG_WORKFLOW.md#开发入口与-bundle)。

验证按改动选择，先确认[本地选测计划](docs/engineering/DEBUG_WORKFLOW.md#本地按影响选测)。文档规范、检查和官网同步步骤见[文档约定](docs/README.md#提交与验证)。

## 许可

- 提交即表示你的贡献同意按 [`CLA.md`](CLA.md) 授权
- 项目本体许可证：AGPL-3.0-only（见 [`LICENSE`](LICENSE)）
