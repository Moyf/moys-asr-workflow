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

- **PR 看板**：6 列（未分配 / Backlog / Review / Fixing / Hold / Pass），卡片可拖拽分列，也可用卡片右下角下拉选择；每次刷新拉取最新数据，顶栏可开 60 秒自动刷新。首次读取、手动及自动刷新均显示原生不定进度条与加载状态（gh 没有真实百分比），期间禁用刷新按钮、阻止重复刷新，旧卡片保留可用；四路读取全部结束后统一更新，失败保留旧数据并显示错误。
- **正文悬停预览**：悬停卡片约 300ms 显示正文浮层，鼠标移入浮层可滚动、选字；正文随 `gh pr list` 一次获取，悬停不另发请求。键盘聚焦 PR 标题也可打开，按 ↓ 进入正文阅读，Esc 关闭。支持标题、段落、列表、粗斜体、代码、引用、链接、GFM 表格和任务列表；原始 HTML 作为文本显示，不加载图片，仅显示图片说明。仅允许绝对 HTTP(S) 链接，新标签打开并隔离来源；不自动访问链接。空字符串 / 空白 / null 显示「暂无正文」，缺失或非法类型则提示重启看板服务，数据恢复后清除告警；点击标题仍在新标签打开 GitHub PR。
- **自定义状态**：即上面的六列，数据存在 `.artifacts/dev-dashboard/status.json`（git 忽略，不入库、不上传）。要调整状态集，改 `app.js` 顶部的 `STATUSES` 数组即可，server 端不限定枚举。
- **milestone 视角**：卡片显示所属 milestone；`dueOn` 两周内或已逾期会高亮；未挂 milestone 的卡片有黄色警示边，工具栏可按「未挂 milestone」筛选。
- **作者筛选**：工具栏下拉按作者过滤卡片，选项带 PR 数量（按数量降序）；作者在下次刷新后消失时自动回落「全部作者」。
- **忽略 PR**：卡片左下「忽略」按钮把 PR 从看板隐藏，工具栏「已忽略 N」开关可查看并「取消忽略」；数据存在 `.artifacts/dev-dashboard/ignored.json`（git 忽略），按 PR 号持久化，合并/关闭后条目保留，手工清理直接编辑该文件。
- **核对清单联动**：扫描 `docs/logs/**/*.checklist.md` 的 front-matter，按 `pr:` 字段挂到对应卡片；有清单的卡片显示 `pending / partial / passed` 状态 pill，点击复制清单文件路径（可交给 agent 重建交互页）；无清单的卡片提供「生成清单」按钮，复制一段现成提示词，粘贴给 Hermes 即可按 `tools/verification-checklist` 规范生成。
- **CHANGELOG 编辑器入口**：顶栏按钮在新标签打开本 server 托管的 `tools/changelog-editor/index.html`（同源，无需 file://）。编辑器里的「手动编辑」按钮依赖本 server 的 `POST /api/open-changelog`：固定调起系统默认应用打开仓库根的 `CHANGELOG.md`，不接受任何路径参数。

## 安全模型

- 只绑定 `127.0.0.1`，并校验 `Host` 头（防 DNS rebinding）；
- 静态资源只暴露面板自身文件与 `tools/changelog-editor/` 目录，禁止路径穿越；
- 服务端不保存任何 GitHub 令牌，认证完全复用本机 `gh` CLI 的登录态；
- 无认证机制，**不要**把端口转发到外网。
- Markdown 使用本地固定版本 marked 15.0.12 的词法分析，节点通过白名单构造而非注入解析器生成的 HTML；不支持 GitHub 专属扩展或原始 HTML。解析器资源缺失时显示原文并提示重启旧服务。
- 本地 `marked-15.0.12.min.js` 来自 npm `marked@15.0.12` 发布包（MIT，许可证见 `marked-LICENSE.md`）；包 SHA-512 / npm integrity 为 `sha512-8dD6FusOQSrpv9Z1rdNMdlSgQOIP880DHqnohobOmYLElGEqAL/JvxvuxZO16r4HtjTlfPRDC1hbvxC9dPN2nA==`。运行时不访问 CDN。

## 自测

```bash
node --test tools/dev-dashboard/serve.test.mjs
```

覆盖正文随列表获取、front-matter 解析、清单分组、CI 结论汇总、状态与忽略表读写（含原子写与损坏 JSON）、写端点 CSRF / 参数校验、已有实例探测（`isDashboardServing`）。

浏览器回归（需仓库开发依赖与 Playwright Chromium；不启动服务、不访问 GitHub）：

```bash
node --test tools/dev-dashboard/app.test.mjs
```

覆盖 hover / 键盘预览、空正文与外部 HTML 安全、缺字段告警与恢复、浮层内滚动、刷新与拖拽清理、窄屏与视口边缘布局，以及慢加载进度、手动 / 自动刷新重入、早失败等待其余请求、原子更新与失败保留旧数据。

## 边界说明

- 浮层不会遮挡原卡片：左右放不下时改放卡片上方或下方，并按可用空间缩短。极矮窗口没有至少 100px 可读空间时不弹出，仍可点击标题阅读 GitHub 原文。
- PR 数据每次刷新现调 `gh`，不缓存；`statusCheckRollup` 的汇总规则（成功 / 失败 / 运行中 / 无）在前端与测试中各有一份同逻辑实现，改动需两处同步。
- 状态表按 PR 号存储，PR 合并/关闭后条目保留（再开的同名 PR 依旧生效）；手工清理直接编辑 `status.json`。
- greptile 审查结论聚合、外部贡献者补审提醒等为 V2 候选项，本期未做。
