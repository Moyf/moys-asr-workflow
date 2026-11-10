# PR 正文悬停预览：独立审查与验证

基线：`main` / `cedb5bfd`；开始时工作树干净。本次只改维护者 PR 看板，不改编辑器 / Launcher，不生成便携 HTML；尚未提交。

## 范围与决定

- `gh pr list` 一次获取 `body`；hover 使用已返回的数据，不增加网络请求。
- 全看板共用一个正文浮层，长正文局部滚动；键盘支持标题聚焦、↓ 进入阅读和 Esc 关闭。
- 纯文本保留换行，不渲染外部 HTML / Markdown，不加载外链图片；完整富文本仍通过原标题去 GitHub 阅读。

## 审查条目

独立审查者未参与实现，先通读全部 diff 和新增测试，再用真实 Chromium 路由夹具复现；没有修改源码。原始证据留在本地 `.artifacts/checks/20261110T034245Z-ee961c48/output.log`，共享记录只保留脱敏结论。

| 条目 | 等级 | 状态 | 证据与处理 |
| --- | --- | --- | --- |
| 浮层遮住原标题且 Esc 后原地重开 | major | 已修复 | 1000×700 / Backlog、360×640 长正文：旧定位向上钳制后覆盖原标题，实际点击新标签数为 0；Esc 后 450ms 又显示。原始输出第 3–6 行。现改为在整张卡片外定位并按可用空间压缩高度；Esc 后需鼠标坐标真正改变才解除 hover 抑制。真实命中、卡片与浮层不相交、实际新标签点击与 Escape 持续关闭测试均通过。 |
| Tab 聚焦屏外标题时预览被自动滚动关闭 | minor | 已修复 | 1280×800 / Pass：Tab 后 `scrollLeft=612`，标题仍聚焦但浮层隐藏；按 ↓ 能重开。原始输出第 7–8 行。现聚焦后在下一动画帧显示，先处理焦点引发的自动滚动；待执行帧也随 hide 取消。真正 Tab 导航回归通过。 |

两项修正均有新增回归先红后绿证据；独立审查者已用原场景复验，**无未处置 blocker / major，无新增发现**。1000×700 与 360×640 均实际命中原标题并打开 1 个新标签，Esc 后 450ms 仍关闭；Pass 列 Tab 自动横滚至 `scrollLeft=612` 后预览可见，↓ 可进入正文。独立证据：`.artifacts/checks/20261110T035132Z-6adb9d58/output.log` 第 3–8 行。

## 已有验证

- `node --test tools/dev-dashboard/serve.test.mjs`：22/22 通过；新增取数用例已在未请求 `body` 的旧逻辑上真实失败。
- 首批 `node --test tools/dev-dashboard/app.test.mjs`：5/5 通过；无功能时 5 项均真实失败。独立审查指出此覆盖仍漏掉实际链接点击与真正 Tab 到屏外卡片，已新增两项：旧实现 2 项真实失败（`.artifacts/checks/20261110T034922Z-9e0e34a7/result.json`），修正后完整 **7/7** 通过（`.artifacts/checks/20261110T035029Z-5548b21e/result.json`）。
- 实际取数函数：当前 10 个 PR 均返回字符串正文，只记录数量，不落盘正文。
- 文档检查通过，6 条既有日志漏登记警告；发布归档 18 份与 release notes 回归 16/16 通过。CHANGELOG 使用仓库既有「未发布」标题，不改历史归档。
- 文档回归 `scripts/run_tests.py tests/test_docs_check.py`：22/22 通过（`.artifacts/checks/20261110T035227Z-073a2a83/result.json`）。10 个改动文件（含新测试与审查记录）的 UTF-8/LF、个人路径检查通过；`git diff --check` 通过，结果分别为 `.artifacts/checks/20261110T035227Z-f5149712/result.json`、`.artifacts/checks/20261110T035227Z-67a70cbb/result.json`。
- 宽屏 / 窄屏 / 矮窗与深浅色截图已自查；100 卡片只有一个正文 DOM。同步容器宽度重排 35 样本，中位数约 0.1ms，P95 / 最大约 0.2ms；标题与提示实测间距 10px。定位修正后的三种尺寸截图已更新并自查，窄屏浮层在原卡片上方，标题与动作均可见。

命令均经 `scripts/run_check.py` 执行；原始输出和截图仅在被忽略的 `.artifacts/`。服务端结果为 `.artifacts/checks/20261110T033556Z-338ba1d8/result.json`；文档检查为 `.artifacts/checks/20261110T035122Z-9d2ee468/result.json`。本次未创建 commit、tag 或 PR，未 push。

## 边界

- 未执行 Firefox / WebKit、触屏、系统级拖放或 CI；合成 dragstart 不冒充系统拖放验证。
- 维护者已有服务需重启再刷新，才会请求新增的 `body` 字段。
- 极矮窗口的卡片外没有至少 100px 可读空间时不弹出预览，以保留原链接与动作；完整正文仍可去 GitHub 阅读。

## 后续实测反馈：正文状态与读取进度

需求与运行实例对照见同目录 `TEST_FEEDBACK_PR正文预览.md`。缺失 body 已不再误报为空正文；原生不定进度覆盖首次、手动与自动刷新，四路 allSettled 及 busy guard 避免过早解除加载与重入。

独立复核未参与实现；34/34 测试和反向证据已核对，针对失败路径另行真实 Chromium 复现：

| 条目 | 等级 | 状态 | 证据与处置 |
| --- | --- | --- | --- |
| 刷新期间重新打开的预览在失败收尾后遗留、遮挡标题 | minor | 已修复 | `app.js` finally 移除进度 / 调整布局前统一 `hidePrPreview()`。360×640 原失败场景曾使卡片上移 44px、浮层未动、点击无新标签，见 `.artifacts/checks/20261110T050650Z-240babc0/output.log:3-6`。新增实际点击与 hover / focus 待执行任务 3 项回归，旧逻辑全失败（`.artifacts/checks/20261110T051011Z-8db6f418/result.json`），最终 37/37 通过（`.artifacts/checks/20261110T051046Z-0a6a6ff0/result.json`）；原审查者已在宽 / 窄屏原场景复验浮层关闭、无遮挡，原标题实际打开 1 个新标签，无新增发现（`.artifacts/checks/20261110T051325Z-6f396f7c/output.log:2-5`）。 |
| 刷新快照可能覆盖刷新期间已保存的状态 | 既有风险 | 仅说明 | 独立审查在 HEAD 同样复现，非此次加载条引入；同日志第 7–10 行。本次不扩大到状态写入 / 快照一致性改造，保留后续独立任务处理边界。 |

此前旧服务未重启，PR 318 恢复曾保留为未验证；后续维护者明确授权独立窗口重启，已定点替换旧进程并验证真实接口与浏览器：9 项均返回 body、PR 318 浮层可见且正文 300 字符，无缺字段告警；状态 / 忽略文件前后哈希一致。接口证据 `.artifacts/checks/20261110T063436Z-623161dc/result.json`，页面指标 `.artifacts/dev-dashboard-runtime/preview-verification.json`。

本轮代码审查结论：无未处置 blocker / major / minor；上述既有快照风险接受为本次范围外。实际服务恢复已验证，维护者自己的人工核验仍待勾选确认。

## Markdown 预览独立复核

实现为固定版本本地 Marked lexer + DOM 白名单，不执行原始 HTML、不自动加载图片；用户已要求重启并验证真实服务加载解析器。独立审查未参与实现。

| 条目 | 等级 | 状态 | 证据与处置 |
| --- | --- | --- | --- |
| 链接目标未解码 HTML 实体 | minor | 已修复 | 原 `safeUrl` 直接使用 lexer 链接目标，`https://example.com/a?x=1&amp;y=2` 错误保留 `&amp;`，`&#x61;` 路径同理。隔离 Chromium 未访问外网，见 `.artifacts/checks/20261110T101807Z-74d43dbc/output.log:14-22,62`。现先解码后再执行严格 HTTP(S) 校验；新 Chromium 测试覆盖实体与编码危险协议，旧逻辑失败 `.artifacts/checks/20261110T102011Z-9448baf7/result.json`，最终 42/42 通过 `.artifacts/checks/20261110T102036Z-ec087a5f/result.json`。原审查者用原探针复验通过，实体编码危险协议不生成链接（`.artifacts/checks/20261110T102151Z-41911bf2/output.log:14-27`）。 |

未复现 blocker / major；原始 HTML、textarea 片段闭合、危险协议变体及远端图片的隔离安全测试未见注入或外部请求。独立审查未自行核验 vendor 的供应链字节哈希；实现报告称 npm 发布包 SHA-512 一致，保留此验证边界。真实服务已由主会话验证 PR 318 内容渲染，且用户的状态文件未变化。

独立审查复验完成，当前无未处置 blocker / major / minor；用户服务已更新，前端源码按请求实时读取，修复后刷新页面即可。
