# 测试夹具组合：独立复核

基线 main `ed52f7a7`。独立 Astra 未参与实现，回查 H/L/C 实际调用、原断言与本轮收据。产品及夹具组合没有未处理的 blocker/major，允许 Draft 交付；Windows 符号链接及新增远端消费者必须由本 PR CI 实际执行后才可宣布通过。

| 边界 | 审查结论与证据 |
| --- | --- |
| 真实服务与合成期限 | 应用默认 30/45 秒保留，短预算只用于合成失败场景。原进程归属、退出清理、端口释放、旁观进程存活保留；Windows 正常权限四文件 31/31。180 秒外层预算用于扩大的原集合，未放宽单例服务契约。 |
| 环境隔离 | cue-scroll 的 supervisor 使用宿主环境，应用仍清空后按指定环境重建；源码入口 no-sync。未推广为所有 helper 白名单化，通用 helper 默认 frozen 行为保留。 |
| Launcher 发现 | helper 触发真实 ready listener，不置换桥方法或时钟。完整 11 spec、96/96，零 skip/retry；包含原生 1800ms 回退、晚到 host、主题 reload、真实 plain/timed 取消和重启。 |
| 缓存分层 | 51 个原 ID 及原断言保留，真实 SQLite/ZIP/revision/namespace、冻结样本及独立真实生成仍存在。假源禁止意外解码，取消 worker 在 patch 恢复前关闭；原 30 分钟生成与粗 mip 保障保留。 |
| Windows 本地权限 | 51 run 零失败/错误，namespace 因 symlink 权限跳过，required 返回 1；其余 50 项实际执行。未增加 N/A 或用 Linux 代替该项。 |
| 同一次完整报告 | 原 Windows 完整 Python 只运行一次。报告核对四模块、namespace、三个真实生成方法，拒绝对应 test/class/module skip；允许无关类级 skip 的原 unittest 计数语义，不伪造成功事件账本。实际 workflow 检查旧红新绿，17 个必要场景通过。 |

原有 Windows/Ubuntu 调试矩阵扩为完整四 lifecycle 文件，指向 setup-python 的实际解释器。Preview 的 test 组仅 NumPy，锁仅增加组 metadata，没有包版本改动；离线锁检查通过。主线原全量测试方式和 lite 不捆绑 FFmpeg 的检查保留。

主线原 CI 不自动执行这 11 个 Launcher spec。新增 Windows Chromium 门禁只承接 4 个关键消费者，完整 JSON、失败 trace 与有界日志保留；明确区分本地 96 项和远端 4 项，不宣称原生 pywebview 或全平台验收。JSON 检查拒绝 skip、expected failure、flaky 与重试，不能仅凭进程返回 0 放行。

Node 24.19 低于声明 engine，本地结果不能代替合规 exact-head CI。人工清单保持未勾选；Linux/macOS 全量维护及治理 PR 的完整迁移不在本交付内。首次打包契约 35 项中 1 项命令子串失败，等价参数顺序调整后仅定向通过该项，未伪装成整组重跑成功。
