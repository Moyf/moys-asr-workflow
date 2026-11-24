# PR 看板合并状态：验证与独立审查

## 改动与验证

- 用 `gh pr list` 同批返回的 CI 与合并字段替换卡片原先按 milestone / 手动 Pass 判定的边框；分列、忽略与筛选照旧。CI 失败优先标红，CI 已通过但有合并冲突标黄，确认可合并标绿。
- 负对照：在应用黄边规则前执行 `node --test --test-name-pattern '^合并状态' tools/dev-dashboard/app.test.mjs`，CI 已通过但冲突的卡片仍为 `merge-error`，新断言失败。
- `node --test tools/dev-dashboard/app.test.mjs tools/dev-dashboard/serve.test.mjs`：44 项通过。Chromium 覆盖刷新、精简、筛选、深浅主题和 320/375/414/768/1280px，精简卡片标题与操作间距均为 8px。截图在本地 `.artifacts/dev-dashboard-preview/merge-*.png`。
- Chromium `tool-compact.spec.mjs` 的 `dashboard compact shows only title` 用例通过，实测拖拽以外的下拉分列、忽略/恢复和重载持久化。
- 只读 `gh pr list` 已确认当前仓库返回合并状态字段；以上浏览器验证使用夹具，没有尝试实际合并 PR。

## 独立审查与处置

未发现阻塞问题。审查覆盖 CI/合并优先级、GitHub 字段、请求次数、筛选及本地状态存储、文档生成与 LF。

| 发现与证据 | 处置 |
| --- | --- |
| 精简模式三色都是实线，Chromium 读取 `.card-badges` 均为 `display: none`，非读屏用户只能靠颜色辨认。 | 标题内增加精简模式专用的 `✕`、`!`、`✓`，红边仍为实线。 |
| 浅色主题原来用状态色作徽章前景，Chromium 实测红、黄、绿的文字对比分别为 3.88:1、4.35:1、3.60:1。 | 状态徽章改用标准正文前景色，保留状态底色与边框。 |
| 原测试只比较颜色差异；在浏览器内对调红绿，原断言仍成立。 | 改为对深浅主题分别验证红、黄、绿的实际边框令牌与可见符号。 |

范围：Windows Chromium 与只读 GitHub CLI；未覆盖 macOS/Linux 和其他浏览器。
