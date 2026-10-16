# 编辑器 ESM 单 PR 整合验收记录

基线为本地 `origin/main@2cc67041`，整合分支为
`feat/editor-esm-current-upstream`。只交付这一个分支；编辑器 197 个源码输入由
ESM 导入图装配，旧 `editor-scripts.txt`、`editor-modules.json` 和运行顺序表已退役。

## 已验证

- Node 全量 `pnpm run test:unit`：729/729。
- `pnpm run typecheck`：0 条诊断；`check:editor`、`check:launcher` 新鲜；
  `check:esm`：0 个内部裸门面读、0 个缺失导入。
- Chromium 在修复前的全量运行：825/847，22 红。该结果不能写成全绿。
  此后分别修复并单跑：工程设置撤销/重载 2/2、JKL 停止位置 3/3、
  OTIO 绝对路径 1/1、ASS 导出 19/19、ASS 帧预览 17/17、
  媒体导出夹具 52/52、AI 清理标点 10/10、装配和便携页 9/9。
- Python 全量 2340 项：最后一次运行有 2 红；其中
  `test_waveform.EditorAssetTests.test_project_waveform_survives_loading_media`
  的旧源码文本断言已更新，随后该文件 25/25 通过。剩余
  `test_thumbnails.ThumbnailIntegrationTests.test_nonzero_start_pts_is_normalized`
  仍得到 3500 ms 而非 4000 ms；缩略图实现和测试与 `origin/main` 一致。

## 对照上游的浏览器红灯

在同一 worktree 临时检出并构建 `origin/main@2cc67041`，精确重跑 14 条用例，
然后切回整合分支重建产物：其中 10 条在上游同样红（ASS 像素边界、颜色、
英文文案 2 条、多字幕旧入口 2 条、浅色主题、拖入工程、帮助浮窗、波形工具栏）。
`server-align` 的 5 条在整合分支单独重跑仍红；其源码、夹具和测试与上游
逐文件相同，属于未改动子系统。上游通过而整合分支失败的工程设置 2 条已
修复：启动时安装工程设置访问器，控件同步读取真实工程设置。JKL 测试在上游
通过，整合分支原测试失败；等待浏览器异步 seek 收束后验证停止位置，连续
3 次通过。定时文本搜索在上游通过、整合分支全量偶发红，整合分支单跑通过，
尚未证明并发条件下稳定。Launcher 取消匹配 2 条尚未在上游执行同命令对照。

本记录只证明已列的层与用例；再次全量 Chromium 尚未在最终修订上执行。
