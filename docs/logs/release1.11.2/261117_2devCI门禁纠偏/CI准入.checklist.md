---
task: ci-gate-correction-2dev
date: 2026-11-17
status: pending
---

# 2.0dev CI 准入远端核验

> 只验证本分支 CI 调度和交付状态；本地契约不替代远端 Actions、打包或产品人工回归。

## 实现与审查边界
<!-- id: implementation -->

有限准入和范围预览已实现，正式 release 工作流未变。完整 Editor/Windows 能力仅手动；没有新增定时或平台。独立审查仍交协调会话，不自动合并。

## 修复与提交记录
<!-- id: changes -->

当前基线 76bb330a，尚未提交/推送。目标为 2.0dev，只同步 origin/2.0dev，不合并 main。

## 自动化验证
<!-- id: automation -->

事件差异、严格计划/报告/receipt、预览评论与既有契约由定向测试覆盖。首次缺 bundle 证据已保留，准入改为明确纯单测 ID 后通过；本机 Node 低于项目下限，远端锁定版本另验。

## 人工核验
<!-- id: manual -->

- [ ] **普通文档 PR 与 push 不启动重检查**
  （操作）对目标 2.0dev 提交仅修改普通计划说明的变更，分别查看 PR 和 push 的 Actions。
  （预期）只选文档消费者；无完整 Node/Python、浏览器、FFmpeg 或 Windows 打包。
  <!-- id: docs-scope -->

- [ ] **准入拒绝不完整结果**
  （操作）在受控测试 PR 取消所选 checks，核读 Change acceptance 与工件报告。
  （预期）汇总失败而非成功；错误 SHA、漏报告或所选 skip 同样不能放行。
  <!-- id: fail-closed -->

- [ ] **辅助预览不传播但保留真实异常**
  （操作）查看 runtime 或打包变更的 Windows 预览与 PR 评论；核对归档、上传、head 和 run 信息。
  （预期）有包只在归档和上传成功时显示，取消和失败如实提示；Change acceptance 无该依赖。
  <!-- id: advisory -->

- [ ] **原完整能力仍可手动运行**
  （操作）在 Actions 查看两个 manual advisory 工作流并人工触发所需的一项。
  （预期）仍有原完整 Node/E2E 或 Windows Python/缓存/E2E/打包检查，不新增 schedule，不掩盖失败。
  <!-- id: manual-full -->

## 后续操作
<!-- id: next -->

- [ ] **核对必需状态与目标分支**
  （操作）独立审查后确认 PR base 为 2.0dev；人工将必需门禁迁移为 Change acceptance，移除旧 Editor/Windows 必需状态。
  （预期）仅同步实际目标分支，不合并 main；远端规则变更由维护者明确授权，不自动合并 PR。
  <!-- id: protection -->
