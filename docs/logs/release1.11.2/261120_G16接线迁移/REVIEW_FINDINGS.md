# G16-B/G/D 独立自审

审查者未参与实现。审查覆盖源码、测试、装配清单、经典门面和工程/媒体切换。无新增 blocker、major 或 nit。

- 对照 `58b408e4` 的 AST，G 与 D 共 11 个新 init 保持原位。118 条监听器的数量、顺序及绑定调用一致。媒体输入的一个目标改从静态 DOM getter 读取，与原门面指向同一 DOM 对象。
- 生产源码已无 `MaweKeyboardGuards` 消费者。贴纸、去空隙导出和烧录门面均有活跃消费者。独立 Node 用例 11/11（`.artifacts/checks/20261120T115628Z-9990422a/result.json`）。
- 副字幕文件解析等待中切换工程时，旧字幕可在新工程弹出导入确认，用户仍需确认才会写入。入口见 [媒体输入接线](../../../../web/editor/media/editor-wiring-media-inputs.js#L31)，读当前副轨见 [多字幕导入](../../../../web/editor/io/editor-multi-import.js#L76)。用实际接线源码控制解析 Promise 并推进工程 generation，基线和当前都复现（`.artifacts/checks/20261120T115756Z-ae45f73f/result.json`）。迁移保留原有行为，此竞态尚待单独修复。
- 主任务的负向验证覆盖提前捕获播放器、错误保留观察目标和绕过烧录绑定检查。变更恢复后的验证及既存失败见 [实施记录](IMPLEMENTATION.md)。

PR 415 的辅助 CI 修复另经独立审查。v2 校验要求 `items` 为数组，保留合并已生成的空数组符合该约束。点击和字幕分组用例继续检查焦点、滚动定位、历史、保存重开和导出。无新增 blocker、major 或 nit。
