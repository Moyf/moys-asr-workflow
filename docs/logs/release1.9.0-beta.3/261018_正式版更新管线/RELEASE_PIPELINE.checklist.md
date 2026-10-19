---
task: release-pipeline
date: 2026-10-18
status: partial
---

# 正式版本更新管线核对

> 正文从 CHANGELOG 单向生成；自动化通过与实际发布分层验收。

## 实现与审查结论
<!-- id: scope -->

只归档和展示正式版；beta / rc 继续使用原有测试发布能力。图片单份入库，网站与更新 JSON 是构建产物。未来软件更新提示和自动安装未实现。

## 修复与提交记录
<!-- id: changes -->

已实现归档、历史官网、去重图片、正式版 JSON、草稿上传核验和显式官网联动。补回两份有 tag 证据的历史正文。本地未提交、推送、创建 tag 或触发发布。

## 自动化验证结果
<!-- id: automated -->

Python 针对性测试 35 项、官网 check / build、Ruff、归档与文档检查、本地浏览器通过。浏览器实测摘要至操作区 18px、下载项 gap 8px；390px 无横向溢出。初次依赖安装受沙箱缓存权限影响，修复环境后通过。实际 CI、部署及三平台打包未执行，详细证据见同目录实施记录。

## 人工核验
<!-- id: manual -->

- [x] **官网只列正式版本**
  （操作）打开官网更新记录，进入 1.7.0、1.6.1、1.6.0，并查看前后版本入口。
  （预期）列表与导航没有 beta / rc，日期和内容正确，旧版图片不变成新版截图。
  （说明）2026-10-18 线上验证：index.json 14 个正式版、无 beta；1.9.0 发布后列表与导航由自动化核对（verify_release_site）覆盖。
  <!-- id: stable-history -->

- [ ] **桌面与手机图文可读**
  （操作）在桌面和约 390px 窗口打开 1.6.0，滚动完整正文和配图，查看下载区。
  （预期）图片完整、无横向溢出；文字与操作区有留白，下载项之间间距至少 8px。
  （说明）发布前已用本地 Playwright 验证（见实施记录）；线上页面留维护者抽验。
  <!-- id: responsive -->

- [x] **完整与轻量包指向真实附件**
  （操作）分别查看 1.4.0 与 1.6.0 的 Windows / macOS 下载名称及 GitHub 对应附件；检查缺失平台提示。
  （预期）旧 MAWxFF 显示为完整版，MAW 旧包为轻量版；新命名仍正确，没有不存在的下载链接。
  （说明）管线任务用真实 API 快照核对过 13 个历史版本；1.9.0 线上索引 5 个附件与 GitHub Release 实际附件一致（macOS 首跑失败、重跑后由 publish 补传）。
  <!-- id: real-downloads -->

- [x] **预览不会宣告软件更新**
  （操作）本地运行预览生成命令，查看版本页的预览标记与生成的 releases/index.json。
  （预期）候选版本可看，公开 JSON 的 releases 为空且 latest_stable 为 null。
  （说明）tests/test_release_site.py 固定该契约。
  <!-- id: preview-isolation -->

## 后续操作
<!-- id: next -->

- [x] **真实发布后官网与索引同步**
  （操作）按正常审批流程合入 main，在后续正式版发布中检查草稿、附件核验、公开、官网刷新各 job；也可先手动运行 Pages workflow。
  （预期）目标正式版出现在官网和 JSON，部署核验通过；失败时能只重跑官网任务，不要求重新打包。
  （说明）2026-10-18 随 v1.9.0 完成：publish 成功（5 附件），官网经 workflow_dispatch + expected_tag 部署，verify_release_site 线上通过。发布中发现 refresh-website 因传递依赖失败被默认跳过（macOS 首跑失败），已修复为显式判定 needs.publish.result（f4926908）；macOS 首跑失败的 test_thumbnail_jobs 已排查为测试时序脆弱（非产品 bug），加固为 10s 宽限。
  <!-- id: live-ci -->
