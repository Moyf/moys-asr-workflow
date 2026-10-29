# MAW Dev Dashboard

维护者本地 PR 看板：把「PR → 审查 → 人工验收 → 合并 → CHANGELOG」这条流水线聚合成一个工作台。
与 `tools/` 下其他工具页同栈：Node 标准库 server + 原生 JS 静态页，零 npm 依赖。

## 启动

```bash
node tools/dev-dashboard/serve.mjs [--port 8262] [--open]
```

浏览器访问 `http://127.0.0.1:8262/`（`--open` 自动打开）。依赖：Node ≥ 20、已登录的 GitHub CLI（`gh auth status` 可查）。

## 功能（V1）

- **PR 看板**：6 列（未分配 / Backlog / Review / Fixing / Hold / Pass），卡片可拖拽分列，也可用卡片右下角下拉选择；每次刷新拉取最新数据，顶栏可开 60 秒自动刷新。
- **自定义状态**：即上面的六列，数据存在 `.artifacts/dev-dashboard/status.json`（git 忽略，不入库、不上传）。要调整状态集，改 `app.js` 顶部的 `STATUSES` 数组即可，server 端不限定枚举。
- **milestone 视角**：卡片显示所属 milestone；`dueOn` 两周内或已逾期会高亮；未挂 milestone 的卡片有黄色警示边，工具栏可按「未挂 milestone」筛选。
- **核对清单联动**：扫描 `docs/logs/**/*.checklist.md` 的 front-matter，按 `pr:` 字段挂到对应卡片；有清单的卡片显示 `pending / partial / passed` 状态 pill，点击复制清单文件路径（可交给 agent 重建交互页）；无清单的卡片提供「生成清单」按钮，复制一段现成提示词，粘贴给 Hermes 即可按 `tools/verification-checklist` 规范生成。
- **CHANGELOG 编辑器入口**：顶栏按钮在新标签打开本 server 托管的 `tools/changelog-editor/index.html`（同源，无需 file://）。

## 安全模型

- 只绑定 `127.0.0.1`，并校验 `Host` 头（防 DNS rebinding）；
- 静态资源只暴露面板自身文件与 `tools/changelog-editor/` 目录，禁止路径穿越；
- 服务端不保存任何 GitHub 令牌，认证完全复用本机 `gh` CLI 的登录态；
- 无认证机制，**不要**把端口转发到外网。

## 自测

```bash
node --test tools/dev-dashboard/serve.test.mjs
```

覆盖 front-matter 解析、清单分组、CI 结论汇总、状态读写（含原子写与损坏 JSON）。

## 边界说明

- PR 数据每次刷新现调 `gh`，不缓存；`statusCheckRollup` 的汇总规则（成功 / 失败 / 运行中 / 无）在前端与测试中各有一份同逻辑实现，改动需两处同步。
- 状态表按 PR 号存储，PR 合并/关闭后条目保留（再开的同名 PR 依旧生效）；手工清理直接编辑 `status.json`。
- greptile 审查结论聚合、外部贡献者补审提醒等为 V2 候选项，本期未做。
