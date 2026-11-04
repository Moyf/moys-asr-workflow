# Gap 播放修复独立自审

范围：`codex/fix-gap-playback-head`，基线 `f3f4527`；产品代码、测试、CHANGELOG、指南和核验清单。

## 发现与处置

| 编号 | 等级 | 证据与影响 | 处置 |
| --- | --- | --- | --- |
| R1 | P2 | `editor-gap-playback.js` 初版在确认事件来自当前播放器前清除 waiting；旧播放器迟到的 playing 能替新播放器安排缓冲期间的门控。独立 VM：`.artifacts/checks/20261103T133959Z-49d2aef5/result.json`，旧事件前 timers=0，之后 timers=1 | 已修复：先检查播放器身份；新增旧事件回归。独立复跑 30/30：`.artifacts/checks/20261103T134148Z-991cdb83/result.json` |
| R2 | P1 | `seeked` 后立即开门不保证旧 PCM 队列排空；真实 Worklet 首个非零采样与开门同为 0.92s：`.artifacts/checks/20261103T134538Z-d60bb2ee/result.json` | 已修复：内部暂停、seek、门控下排空旧音频再续播；用户暂停与定位取消旧续播。最终真实音频三场景重复两次 6/6，最大残留采样为 0 |
| R3 | 已知边界 | 既有音频路由只支持 blob 或同源 Server 媒体；直接相对地址 / file 地址的便携页面不具备新门控 | 接受当前范围：保留原有 seek 预览，不扩展来源权限；指南、PR 和人工清单披露 |

## 最终证据

- 单元 / 脚本 / 波形回归：452/452，`.artifacts/checks/20261103T135350Z-5b6529a2/result.json`。
- 浏览器真实音频：6/6，`.artifacts/checks/20261103T135352Z-0f896b98/result.json`；包含默认增益首次建图和原声试听对照。
- 旧代码对照：同一音频输出断言真实失败，`.artifacts/checks/20261103T133448Z-04a8b612/result.json`。
- 产物新鲜度与 TypeScript 已通过；便携 HTML 内联副本待发布前统一重生成。

最终独立结论：**PASS**，没有未处置 blocker / major。审查者独立复跑领域测试 32/32、`git diff --check` 通过：`.artifacts/checks/20261103T135649Z-9e9d9a06/result.json`。原片人工实听仍待维护者核验。

## PR 327 回修复核

- 独立审查验证了播放条、步进、波形和标记共用定位入口，以及试听、量化落点和相邻 Gap 的原有行为。
- 复核发现定位到媒体末尾也会触发待续播。Chromium 中，暂停后定位到 `duration` 会令 `ended` 为真，随后调用 `play()` 会跳回零点。待续播现在在末尾结束交接并释放门控，新增回归在补入保护前失败。
- 最终回修独立复核 **PASS**。Gap 与试听测试 17/17，`git diff --check ff24ccfa` 通过。原片实听仍待核验。
