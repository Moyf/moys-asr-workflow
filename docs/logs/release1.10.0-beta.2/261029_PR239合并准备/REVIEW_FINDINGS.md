# PR239 合并准备与复核

## 契约与范围

以 [PR311 拍板](https://github.com/Moyf/moys-asr-workflow/pull/311#issuecomment-6470711705)、已合入的 [PR312](https://github.com/Moyf/moys-asr-workflow/pull/312) 和 [PR239 最新评论及补丁](https://github.com/Moyf/moys-asr-workflow/pull/239#issuecomment-6473983880)为准。

- 版本分期为 v1 → v1.5 → v2。现结构与 `subtitle_groups` 使用 `moy.asr.project.v1.5`；未来 `tracks[]` 与 CueRef 真源使用 v2。当前导入、规范化与写入仍拒绝 v2，不为开发期旧标识提供别名。
- P0/P1 读取层继续代理原对象；main/secondary/overlay 是读取视图的角色，旧容器和绑定端点保留。P2 的统一选中、历史、命令及保存边界不在本次提前实施。
- 起点为 fork head `4b35d3f6`。维护者原补丁以 `d8eb3a76` 独立保留；合并提交 `3a5d2b66` 纳入 `2.0dev@3767e4c1`，保留 ESM 状态迁移及上游已有修复。只手动解决更新日志、日志索引及音频测试装配三处冲突。

## Findings 与处置

| 问题 | 证据与处理 | 状态 |
| --- | --- | --- |
| 副轨合并错误保留首句 speaker | 副轨单独合并及主轨联动合并副轨均从首句复制段级 speaker。Alice+Bob 或 Alice+缺失被错误标为 Alice，并可持久化后换到主轨。三条真实合并路径现在共用原主轨规则：全部一致且存在才保留；字词说话人及时间不变。新增矩阵在旧实现为 1 通过、2 失败，修复后 MASS 文件 25/25 | 已修复 |
| 合入 ESM 后测试仍按 classic 装载 | 完整 Node 首轮 1171 项中有 33 项因测试装载失败；另 2 项因沙箱拒绝 Chromium 启动而失败。读取 golden 的夹具改用生产构建器加载状态模块，保存/恢复夹具改用 ESM 初始化并补回文件读取导入。原断言、六份 golden 和用例数保留，完整复验 1171/1171 | 已修复 |
| 旧工程保存测试仍预期 v1 | Chromium 真实保存得到 v1.5，符合维护者明确契约。仅更新该断言与标题，语言、时间粒度及扩展元数据断言保留。所在文件 7/7 重验通过 | 已修复 |

独立审阅核对了完整增量、ESM 合并后的保存与状态函数体、测试装配及六份 golden。六份 golden 相对起点仅 schema 改变；没有新增字幕真源、缩减断言或跳过失败用例。未发现未处置 blocker / major。

## 本地验证

所有检查通过 `scripts/run_check.py` 保存命令、退出码、耗时和完整日志。下列 run-id 对应本地 `.artifacts/checks/<run-id>/`；远端 CI 在推送后单独核对。

| 检查 | 结果 | run-id |
| --- | --- | --- |
| 三条合并路径旧实现反例 | 主轨通过；副轨、联动副轨均因错误 speaker 失败 | `20261028T162742Z-4c8af650` |
| MASS 与合并规则 | 25 passed，0 skipped | `20261028T162807Z-c22152c8` |
| ESM 保存/轨道读取定向 Node | 51 passed，0 skipped | `20261028T163220Z-c6134dd1` |
| `node --test tests/*.mjs` | 1171 passed，0 skipped | `20261028T163258Z-a6b62c54` |
| Python 分组、边界、IO、烧录、轨道读取与 golden、资产、清单、打包契约 | 152 tests，150 passed，2 skipped；仅 Windows 无符号链接创建权限的两项 manifest 测试跳过 | `20261028T162850Z-2a6baf7c` |
| Chromium：分组、主副轨元数据、导入边界 | 首轮 23 passed / 1 failed；失败为上表已修的旧保存版本预期 | `20261028T163450Z-c9781303` |
| Chromium：完整导入文件与真实 Server 视图保存文件 | 13 passed，0 skipped；包含前述失败项复验 | `20261028T163837Z-e05fd0e1` |
| TypeScript | exit 0 | `20261028T162849Z-40ea2620` |
| Editor / Launcher 重建与新鲜度 | 两者通过；未生成便携 HTML | `20261028T162810Z-96f02d4f` / `20261028T162812Z-4b1cd4fe` / `20261028T163946Z-0929b8bc` / `20261028T163947Z-49eb293e` |
| 两份官网契约页生成对照 | 与生产同步脚本输出逐字一致；无关页面未改动 | `20261028T163918Z-1196ea6a` |
| 官网类型检查与静态构建 | 补齐本地发布页生成前置后，0 errors / warnings / hints；39 页静态构建通过，未发布 | `20261028T164115Z-376f1eba` / `20261028T164125Z-8f1fc7f6` / `20261028T164136Z-1563a83c` |

本地 Node 为 v24.19.0，Python 为 3.11.15；Node 不在项目声明的 engines 范围内，不能代替 CI 指定的运行时验证。Chromium 初次因 Windows 沙箱拒绝进程启动而未执行，允许浏览器启动后才获得上述行为结果。文档检查初次发现本地 skip-worktree 的 AGENTS.md 未落地；恢复其 HEAD 原文后通过，未修改该文件或索引标记。

最终文档、清单格式和个人路径检查随本记录一同验证。完整 Playwright、真实素材、原生文件选择器、目标剪辑软件及安装包人工验收仍未完成，沿用既有核验边界。PR 保持 Draft；推送后由维护者核对最新 CI 并合入 `2.0dev`。
