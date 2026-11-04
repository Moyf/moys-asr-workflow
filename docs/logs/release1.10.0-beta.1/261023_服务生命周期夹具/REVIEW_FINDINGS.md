# 服务生命周期夹具复核

目标基线 main `ed52f7a7`。此功能单元只整理测试服务启动、隔离和回收，不修改产品默认期限、不引入模块迁移或治理选组。

独立审查未发现代码阻塞问题：真实应用就绪期限继续为 30/45 秒，Python 入口不再意外同步环境；Windows supervisor 使用宿主可用环境，应用子进程再使用指定隔离环境，防止缺 PATH/SystemRoot 令测试平台本身无法启动。进程所有权与 kernel Job kill-on-close 机制保留。

原 exit、exception、hold、stop 路径，子孙进程清理、端口释放和旁观进程存活断言均保留。只有合成失败场景使用明确的短预算；时间断言改为引用该场景的 deadline，并保留实际 Windows 就绪 45 秒预算。新增隔离环境标记反证；不能把这些修改描述为所有断言 AST 完全不变。

原 22 个生命周期场景及 3 个 server-process 测试 ID 全保留，四个现有 lifecycle 文件总共 31 项。在最新目标树 Windows 正常权限实际执行：31 pass，零失败、错误、skip 或取消；JUnit 同为 31 testcase、零 failure/error/skipped，外层 64.8 秒、无 cleanup error。未增加 retry 或放宽真实默认期限。

这组使用实际受管理进程和合成 Python 服务，验证进程/端口边界，不冒称实际 Editor 页面或真实 POSIX 实机验收。EPERM 注入只证明分支处理；本轮 Windows 结果不能替代 Linux 的真实进程组数据。本机 Node 24.19 低于仓库 engine 要求，最终交付 CI 与完整受影响浏览器旅程仍独立核验。
