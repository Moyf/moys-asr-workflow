---
task: fcp7-image-formats
pr: 353
date: 2026-11-08
status: pending
---

# PNG 与 WebP 图片字幕格式核验

> PNG 默认保留，WebP 显式可选；图片字幕运行时移除 Pillow。自动化与实际程序包结果不替代目标剪辑软件的导入验收。

## 实现与审查结论
<!-- id: implementation -->

图片格式由导出面板选择。旧调用省略 imageFormat 时仍生成 PNG，旧素材包保持原状。FFmpeg 完成透明恢复、编码、Alpha 检测与像素哈希；Python 继续去重、合并和发布。独立复审发现的一处文档格式残留已修复，无未处置 blocker/major。

## 修复与提交记录
<!-- id: changes -->

当前修复见同目录 TEST_FEEDBACK_FORMATS.md，提交和 fork CI 结果在该账本持续更新。内联副本待发布前统一重生成。

## 自动化验证结果
<!-- id: automation -->

通过的命令包括 scripts/run_tests.py tests.test_fcp7_png tests.test_fcp7_png_api tests.test_packaging_contract、Node 单元套件、两个 FCP7 Chromium spec，以及正式 MAW.spec 打包。实际排除 PIL 的 EXE 已启动并经浏览器导出两种格式；PNG/WebP 字节头、VP8L、先前包保留、英文提示和至少 8 px 间距均通过。结果 ID 与未测边界见反馈账本；全量套件与三端 CI 分开记录。

## 可选的目标软件核验
<!-- id: target-editors -->

- [ ] **PNG 导出包继续适用于原有工作流**
  （操作）本机 Server 打开测试工程 → 更多导出 → FCP 7 XML → 透明 PNG 字幕 → 导出；在原有剪辑软件或脚本中读取新包。
  （预期）素材仍为 .png，字幕时间、透明度、动画和多轨重叠符合工程；旧导出包仍可使用。
  （说明）既有 VEGAS 14 的 PNG 导入已有历史验证，本项用于维护者可选复核本次格式选择层。
  <!-- id: target-png -->

- [ ] **支持 WebP 的目标程序可读取新增格式**
  （操作）同一面板显式选择透明 WebP 字幕 → 导出；用支持静态 WebP 的目标程序导入该包。
  （预期）素材为 .webp，manifest 标记 webp，时间线与 PNG 版本一致。
  （说明）用户允许本机 VEGAS 14 的 WebP 导入跳过；不支持该格式时跳过本项并保留说明，无需安装或修改该剪辑软件。
  <!-- id: target-webp -->

## 后续步骤
<!-- id: next-steps -->

cat fork 专用 tag 用于运行三端构建；它不代表上游正式发布。目标软件实测如有新结果，再回填本清单与反馈账本。
