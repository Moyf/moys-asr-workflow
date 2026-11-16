# PR 看板 GitHub 配置同步：需求核对

基线：`main` / `cedb5bfd`；开始时已有正文预览、进度条及其测试 / 文档 WIP，另有其他任务的日志索引改动，均保留。本主题单独记账，不混入正文预览反馈。

状态仅用 `待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。先核对实际 Project 字段、现有能力与权限，再确定实施范围；不把能力询问自动扩大为远端数据修改，不创建 Issue / commit / PR / push。

## 问题清单

| 条目 | 需求 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | 用户希望在本地 PR 看板直接维护 Milestone，以及 `https://github.com/users/Moyf/projects/4` 上的 Priority 等常用配置，并同步回 GitHub。 | 待处理 | 授权阻塞已解除，19 个真实字段和项目可更新权限已核对；同步编辑功能尚未实现。本轮响应“授权了，你试试”仅做只读验证，未实际写入或修改项目定义。后续按真实字段接入，保留六列本地状态，不擅自映射覆盖 Project Status。 |
| 2 | 用户完成授权后要求重试访问。 | 仅说明 | `gh project view` / `field-list` 均成功；只读 GraphQL 返回 `viewerCanUpdate=true`，仓库角色为 ADMIN，OAuth scopes 包含 project。证明权限配置已就绪，但没有用远端 mutation 冒充“测试”，实际写回仍未验证。 |

## 阶段记录

### 初始范围

- 本轮先只读核实可行性与需要维护者决定的边界，不修改远端 Project、PR 或权限。
- 仓库当前只能读取 milestone，并保存本地自定义 status / ignored；没有 PR 元数据或 Project 字段的远端写入端点。

### 续 1：权限阻塞与建议范围

- 诊断命令通过 `run_check.py --timeout 45 -- node .artifacts/dev-dashboard-project/inspect-project.mjs`；本地诊断脚本完成，但 Project 与字段两项读取都失败，并非接口验证通过。证据 `.artifacts/checks/20261110T051758Z-ef10cd86/result.json`，报错为缺少 `read:project`。未读取令牌原文，也未自动改变权限。
- 由于目标包含写回，建议维护者手动执行下方命令，授权 Project 读写；不只补只读 scope。授权后仍需核实账号的项目写入权限，以及真实字段类型 / 选项。

```powershell
gh auth refresh -h github.com -s project
```

- 建议首版范围：PR 原生 Milestone / Labels / Assignees；Project 中实际存在且 API 支持编辑的 Status / Priority 等字段。字段与选项应从远端读，不硬编码成另一套本地配置；只读 / 派生展示字段不能承诺全部写入。
- 建议同步语义：刷新读取远端，用户保存指定字段时立即写回并回读确认，失败显示错误而非假成功；不是自动批量修改全部 PR，也不默认新增 webhook 或实时推送服务。
- 现有六列本地工作流先保留；是否切换成 Project Status 驱动看板列，需在字段可读后集中确认，不在缺少字段定义时猜测映射。
- 下一步仅需维护者补授权后继续只读核对；当前没有新增同步实现或远端改动，不把可行性说明标成已实现。

### 续 2：授权后只读复验成功

- 维护者明确表示已授权并要求重试。`inspect-project.mjs` 成功读取指定项目与 19 个字段，证据 `.artifacts/checks/20261110T053300Z-434b13f3/result.json`。
- 使用文件通道传递纯 GraphQL query（无 mutation），核对账号项目写入能力与字段 dataType。返回项目 `viewerCanUpdate=true`、仓库 ADMIN、OAuth scope 含 project；未读取或输出访问令牌。证据 `.artifacts/checks/20261110T053430Z-a7e1b73e/result.json`。
- 实际可编辑字段定义：Status 为 Backlog / Ready / In progress / In review / Done；Priority 为 P0 / P1 / P2；Size 为 XS / S / M / L / XL；Estimate 为 NUMBER；Start date、Target date 为 DATE；Iteration 为 ITERATION，目前没有进行中的迭代，仅有已结束历史定义。不得自动创建新迭代。
- Assignees / Labels / Milestone 属于 PR 原生元数据，需通过对应 PR 接口更新，不能用 Project 单值字段 mutation 替代；Repository、Created / Updated / Closed、Sub-issues progress 等不应统一当可编辑文本字段。
- 权限核对项终态为「仅说明」；实施项由「阻塞」转为「待处理」。本轮未增加同步实现、未写远端数据、未改变本地状态分列，也未创建 commit / PR / push。
