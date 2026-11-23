# MAW 1.x GitHub Star 提交前验证

目标：`main`；在 `045667a5` 上同步并保留原有功能改动。

## 自检发现与处置

1. `tests/test_local_editor_server.py` 原断言要求 `settingsUrl` 紧挨 `recentProjects`，加入 `githubStarUrl` 后服务测试 467 项中 1 项失败。改为单独检查新端点和最近工程字段，保留原行为断言。
2. `tests/e2e/github-star.spec.mjs` 首轮 Chromium 7 项中 4 项失败：过期的文案期望掩盖了英文感谢文案的翻译键不匹配。对齐 `web/shared/editor-i18n.js` 与模板中的中文原文，并保持浏览器用例对中英文可见文案的精确检查。

## 独立审查：两项 major、一项 minor，均已修复

1. **Launcher 文件 URL（major）**：`maw/gui_web.py` 的原始等值比较拒绝 WebView2 对含空格路径返回的 URI 显示形式。审查者用 Python.NET `System.Uri` 验证显示形式差异；`tests/test_gui_web.py` 模拟原生窗口复现后，只对匹配的 `file:` 主机、查询、片段和解码后路径放行，loopback URL 仍精确比较。保留拒绝外部 URL 和不同端口的断言。
2. **Finder 启动的 PATH（major）**：`maw/github_star.py` 原先只在 PATH 中查找，审查者模拟 Finder 最小 PATH 时未发现已安装的 Homebrew `gh`。macOS 现在在绝对 PATH 条目之后补查 `/opt/homebrew/bin` 和 `/usr/local/bin`；`tests/test_github_star.py` 覆盖候补路径、搜索顺序和非 macOS 不补查。
3. **键盘焦点（minor）**：审查者用 Chromium mock 写入后观察到焦点落回 `BODY`。`web/shared/github-star.js` 只在焦点未移往其他控件时，把焦点交给确认信息或当前界面的后备入口；Chromium 覆盖 Launcher 与 Editor 写入成功以及 Editor 写入失败的焦点去向。

在审查修复前的隔离源码副本运行新增断言：URI 显示形式、Homebrew 回退两项确实失败；Launcher 键盘写入用例在感谢区焦点断言失败。修复后的同一批断言通过。

## 验证证据

- GitHub Star、编辑器资源、Launcher bridge 和本地服务相关 Python 测试：478 项运行，1 项跳过，其余通过。相关 Node 脚本测试 5 项通过；两个 bundle 的构建及新鲜度检查、TypeScript 检查和修改文件 Ruff 检查通过。
- Chromium GitHub Star spec 7 项通过：Launcher 用 mock bridge，Editor 拦截 Star 路由；两处新增入口与前一元素实测至少 8 CSS px，截图自查了按钮可用与回退两种状态。分别在 `045667a5` 的隔离源码副本保留新用例运行负对照：Launcher 与 Editor 的首个加星按钮可见性断言都因旧实现无按钮而失败。
- 不调用真实 GitHub Star API；不将模拟浏览器结果当作原生 WebView、已认证 `gh` 或打包产物验收。维护者可按[人工核对清单](GitHubStar.checklist.md)验收回退和导航。
