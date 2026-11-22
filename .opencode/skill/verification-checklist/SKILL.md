---
name: verification-checklist
description: 为 MAW 的多条改动编写维护者逐项实测的 Markdown v2 清单，校验后生成本地 HTML，并跟踪实测结果。
---

# 人工核对清单

先读[清单契约](../../../tools/verification-checklist/README.md)。改工具模板时同时读[工具目录约定](../../../tools/AGENTS.md)。根规则说明[何时出清单](../../../AGENTS.md#批量改动的人工核查清单)。

1. 写 `<主题>.checklist.md`，放到同批任务台账旁。按契约写 front-matter、稳定标题与 ID。分区保留实现与审查结论、自动化结果、人工核验和后续步骤。每项写目的、具体操作和可观察预期，已知失败或未验证层单列。
2. 在仓库根用 `python tools/verification-checklist/build.py --check "<清单>.md"` 校验。通过后用 `--data "<清单>.md" --output ".artifacts/<任务>/verification.html"` 生成，打开浏览器核对。用户指定目录时写到指定位置。源 Markdown 随任务入库，生成 HTML 放本地。现有模板与 JSON 兼容入口见契约。
3. 根据维护者确认，将源清单的对应项改为 `- [x]`，并更新 front-matter 状态。页面导出用于收集反馈快照，源文件负责重新生成与追踪。获准发布 PR 评论时可贴去掉 front-matter 的 Markdown。
4. 单次核验使用现有模板。若改共享模板，按工具 README 的回归和实际布局测量步骤验证。
