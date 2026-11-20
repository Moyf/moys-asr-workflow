# 独立审查

- 已修复：openFrame 主动调用 ensureCoverage 会替 UI 启动加载，掩盖懒加载入口回归。改为被动观察真实 UI 发起 coverage 请求，再等待 whenReady；测试不得主动加载。
- 已复核：生命周期新测试完整初始化生产模块；等待前不构建、不请求，关闭/切换后拒绝旧点击，重新打开保留正常行为。旧产品逻辑负控 4/6 失败，最终 8/8 通过。
- 独立复审：相关 Node 26/26 通过，无未处置 blocker/major。
- 接受的验证限制：云端 Chromium socket EPERM，E2E 未进入行为执行。Windows 真实扫描耗时和远程矩阵仍须核实；不能将测试分层视为已证实 CI 根因。
