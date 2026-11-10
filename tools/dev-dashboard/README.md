# MAW Dev Dashboard

维护者本地 PR 看板：把「PR → 审查 → 人工验收 → 合并 → CHANGELOG」这条流水线聚合成一个工作台。
与 `tools/` 下其他工具页同栈：Node 标准库 server + 原生 JS 静态页，无需安装 npm 运行依赖。

## 启动

```bash
node tools/dev-dashboard/serve.mjs [--port 8262] [--open]
```

浏览器访问 `http://127.0.0.1:8262/`（`--open` 自动打开）。依赖：Node ≥ 20、已登录的 GitHub CLI（`gh auth status` 可查）。

端口已被占用时不再直接报错退出：若探测到占用者是本工具的已有实例（GET `/` 含页面标记），视为重复启动，直接提示地址并按 `--open` 打开页面；若是其他程序占用，提示用 `--port` 换端口。

若提示「看板服务与页面不匹配」「正文尚未获取」，说明响应缺少有效的 `body` 字段，可能仍在运行旧后端。在原启动终端按 Ctrl+C 停止旧服务，重新运行上面的启动命令，再刷新网页。仅刷新网页或重复启动已占用端口都不会更新旧后端；页面不会为缺字段的 PR 另发补取请求。

## 功能（V1）

- **PR 看板**：6 列（未分配 / Backlog / Review / Fixing / Hold / Pass），卡片可拖拽分列，也可用卡片右下角下拉选择；每次刷新拉取最新数据，顶栏可开 60 秒自动刷新。首次读取、手动及自动刷新显示原生不定进度条（gh 没有真实百分比），期间禁用刷新按钮、阻止重复刷新，旧卡片保留可用；四路读取全部结束后统一更新，失败保留旧数据并显示错误。
- **正文悬停预览**：悬停卡片约 300ms 显示正文浮层，鼠标移入可滚动、选字；正文随列表一起获取，悬停不另发请求。键盘聚焦 PR 标题可打开，↓ 进入阅读，Esc 关闭。支持标题、段落、列表、强调、代码、引用、链接、表格和任务列表；原始 HTML 作为文字显示，不加载图片。空/空白/null 显示暂无正文，缺失或非法类型提示重启旧服务；标题仍打开 GitHub 原文。
- **自定义状态**：即上面的六列，数据存在 `.artifacts/dev-dashboard/status.json`（git 忽略，不入库、不上传）。要调整状态集，改 `app.js` 顶部的 `STATUSES` 数组即可，server 端不限定枚举。
- **milestone 视角**：卡片显示所属 milestone；`dueOn` 两周内或已逾期会高亮；未挂 milestone 的卡片有黄色警示边，工具栏可按「未挂 milestone」筛选。
- **作者筛选**：工具栏下拉按作者过滤卡片，选项带 PR 数量（按数量降序）；作者在下次刷新后消失时自动回落「全部作者」。
- **统一界面**：沿用 Launcher 的深浅主题，顶栏可切换主题与精简显示，开关复用 OCR 页样式；精简卡片只留标题、忽略/取消忽略按钮与状态选择，隐藏徽章、CI/作者/分支和核验提示，切回完整视图恢复。搜索防抖，「重置筛选」清除搜索、作者和里程碑筛选，不改变 PR 归类或忽略偏好。窄屏看板在自身容器内横向滚动。
- **忽略 PR**：卡片左下「忽略」按钮把 PR 从看板隐藏，工具栏「已忽略 N」开关可查看并「取消忽略」；数据存在 `.artifacts/dev-dashboard/ignored.json`（git 忽略），按 PR 号持久化，合并/关闭后条目保留，手工清理直接编辑该文件。
- **核对清单联动**：扫描 `docs/logs/**/*.checklist.md` 的 front-matter，按 `pr:` 字段挂到对应卡片；有清单的卡片显示 `pending / partial / passed` 状态 pill，点击复制清单文件路径（可交给 agent 重建交互页）；无清单的卡片提供「生成清单」按钮，复制一段现成提示词，粘贴给 Hermes 即可按 `tools/verification-checklist` 规范生成。
- **CHANGELOG 编辑器入口**：顶栏按钮在新标签打开本 server 托管的 `tools/changelog-editor/index.html`（同源，无需 file://）。编辑器里的「手动编辑」按钮依赖本 server 的 `POST /api/open-changelog`：固定调起系统默认应用打开仓库根的 `CHANGELOG.md`，不接受任何路径参数。

## 安全模型

- 只绑定 `127.0.0.1`，并校验 `Host` 头（防 DNS rebinding）；
- 静态资源只暴露面板自身文件、两个精确映射的共用主题资源与 `tools/changelog-editor/` 目录，禁止路径穿越；共用资源不放宽面板的 CSP；
- 服务端不保存任何 GitHub 令牌，认证完全复用本机 `gh` CLI 的登录态；
- 无认证机制，**不要**把端口转发到外网。
- PR 正文当前保留主分支的固定 marked 15.0.12 词法分析与 DOM 白名单输出；不加载图片，不自动访问链接，仅允许绝对 HTTP(S) 链接。解析器缺失显示原文与重启提示。其源为 npm `marked@15.0.12` 官方分发，MIT 许可证位于 `marked-LICENSE.md`；不访问 CDN。

## 自测

```bash
node --test tools/dev-dashboard/serve.test.mjs
```

覆盖正文随列表获取、front-matter 解析、清单分组、CI 结论汇总、状态与忽略表读写（含原子写与损坏 JSON）、写端点 CSRF / 参数校验、已有实例探测（`isDashboardServing`）。

`node --test tools/dev-dashboard/app.test.mjs` 使用 Playwright 验证主分支的正文悬停/键盘/安全、空/缺字段、刷新进度与数据一致性，不启动服务或访问 GitHub；新工具精简/主题回归见 `tests/e2e/tool-compact.spec.mjs`。

## 边界说明

- 浮层左右放不下时位于卡片上方或下方，按可用空间缩短；极矮窗口无至少 100px 可读空间时不弹出，仍可点击标题阅读原文。
- PR 数据每次刷新现调 `gh`，不缓存；`statusCheckRollup` 的汇总规则（成功 / 失败 / 运行中 / 无）在前端与测试中各有一份同逻辑实现，改动需两处同步。
- 状态表按 PR 号存储，PR 合并/关闭后条目保留（再开的同名 PR 依旧生效）；手工清理直接编辑 `status.json`。
- greptile 审查结论聚合、外部贡献者补审提醒等为 V2 候选项，本期未做。
