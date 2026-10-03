# MAW、MAWE 与 MOSE

| 名称 | 当前定位 |
| --- | --- |
| MAW — Moy's ASR Workflow | 当前可用的转写与处理工作流，包含 Launcher、公开 CLI 与本机服务。 |
| MAWE — Moy's ASR Workflow Editor | MAW 的浏览器字幕编辑器；Server 为日常入口，HTML 为兼容入口。 |
| MOSE — Moy's Open Subtitle Editor | 后续独立编辑器方向；本工作树保留 Tauri 实验开发目录。 |

当前 `desktop/` 是 Tauri 项目，开发方式见 [desktop README](../desktop/README.md)。它不是已经交付的稳定 MOSE 产品；MAW Release 的正式编辑入口仍为 Server，MOSE 暂不随该发布流程分发，Launcher 入口隐藏。

三者共享 `.mosp` / 兼容 `.json` 工程契约。未来形态与发布时间不作承诺；历史设计和其他开发分支的状态不能代替本工作树的实现。

保留原始媒体与工程最利于后续迁移。SRT、Resolve JSON、保留区域 JSON 和 `.workspace.json` 分别是交付、交换或配置文件，不能代替字幕工程。契约见 [JSON_SCHEMA](../JSON_SCHEMA.md)。
