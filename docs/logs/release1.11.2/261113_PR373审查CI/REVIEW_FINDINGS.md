# PR 373 工具页 CI 修复独立审查

基线 `5fb9af45`，仅检查本轮测试等待、图片夹具、CI上传顺序与新增回归；不是整个P1整合的重新全面审查。

## 主题等待及证据上传

独立审查0个blocker/major/minor/nit。`tool-compact.spec.mjs`以明确的真实computed颜色/开关状态收敛，不仅判断data-theme；没有弱化原样式、hover/focus、15px字号、尺寸、断点、溢出或截图。硬编码预期与现行共享主题和OCR对照一致，清单专有检查仅在有可见项目时执行。屏外暂停干扰、错误主题及错误正文颜色负对照有效。

`editor-checks.yml`失败证据上传位于两组浏览器之后，保留failure/non-light条件和原artifact契约；第一组失败时第二组仍按既有成功条件跳过，上传可执行，第二组失败同样能上传。

审查者独立执行workflow2/2（`20261113T141544Z-3a40bcf2`）及语法（`20261113T141545Z-0feadf92`），diff检查通过；未独立重跑浏览器。原始5402动画、5040未决promise样本支持等待策略存在故障，但不声称已确定Chromium底层通知机制。

## 报告图片夹具增量

独立增量审查0 finding。唯一短目录仍在project.outputDir内、保留真实generation相对路径；JPEG依赖Pillow在CI dev组已准备。缩略图及overlay都要求精确src、complete、正自然尺寸和decode成功；missing/corrupt负对照明确拒绝，未改生产报告代码。

隔离数据支持本次Windows冗长文件路径加载失败，不能推断所有Chromium版本都有同一固定路径上限。修复只保证测试夹具可访问，不代表生产报告的长路径能力已改变。审查者回读图片3/3和完整term-report9/9；独立语法（`20261113T142504Z-992e568f`）、diff检查通过，未重跑浏览器或全量。

## 最终本地验证与边界

实现者/主会话的实际结果：旧长清单60秒红；修复后同用例独立3/3、完整compact10/10；旧图片用例红，修后完整term-report9/9；最终CI同组7文件/2workers共65/65（`20261113T142452Z-b8731c84`）。根Node1648/1648（`20261113T141751Z-57998aba`），纯工具Node27/27与清单Python30/30。

本轮代码可放行，无未处置finding。远端CI须推送后核对，不将本地Windows结果当Ubuntu结果；整个P1的逐项人工、真实宿主/媒体/剪辑软件/跨平台与原环境skip边界继续保留。
