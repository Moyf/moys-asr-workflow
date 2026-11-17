# 2.0dev 日常 CI 准入纠偏

范围：`fix/ci-gate-correction-2dev`，基线 `origin/2.0dev@76bb330a`。本分支没有 main 的完整矩阵调度器；不移植其定时、多平台 jobs，也不修改产品源码、版本或正式发布工作流。

## 已实现

1. PR 全 base diff、push before/after 选测；普通说明轻量，真实网站/发布/工具输入运行消费者，夹具与未知/shared 路径落有限集合。
2. `scripts/ci_acceptance.py` 明确文件与 ID 准入，记录 discovery 和实际报告，汇总门禁拒绝漏项、错 SHA、取消、失败和不支持的 skip。
3. 旧完整 Editor/Windows 覆盖原位移至两个手动辅助 workflow；无新增定时、平台或完整矩阵。预览只按打包/启动/runtime 或手动触发，不附带全 Python/E2E。
4. PR 同步规则改为真实目标分支，保留 2.0 独立 HTML 退役及本地应用维护边界。

## 验收与待交接

本地正向、旧工作流负对照、报告注入和未测层记在[实施记录](../logs/release1.11.2/261117_2devCI门禁纠偏/实施记录.md)。准入清单不是“全部 Node/common 稳定”的标签；历史可靠率与完整产品行为没有本次证据。

协调会话独立审查后决定提交。提交前仅同步实际目标 `origin/2.0dev`，不合并 main。远端必需状态迁移与首次 Actions / 工件上传验证仍由维护者确认；不自动合并 PR。

后续集中报错沿用有限准入与手动巡检边界。验收用小型多组失败和前置失败场景，核对独立组实际执行、错误与退出码齐全、最终失败。报告和重跑入口见[调试工作流](../engineering/DEBUG_WORKFLOW.md#ci-范围与重跑)。
