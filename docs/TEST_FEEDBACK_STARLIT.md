# starlit 桌面版反馈处理记录

本记录只覆盖本轮截图反馈；截图中的文字和系统菜单仅作为现象证据，不扩大修改范围。

## 处理清单

| 编号 | 范围 | 反馈摘要 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | MOSE / Electron 菜单 | 默认 File / Edit / View / Window 菜单不跟随 MAWE 软件主题，且编辑器已有自己的主题感知工具栏 | 修改 | 已修复 |
| 2 | MOSE / Windows 图标 | 打开的 EXE 和任务栏图标显示为黑色或缩放后不可辨识 | 修改 | 已修复 |
| 3 | MOSE / 新手引导 | 每次随机 localhost 端口启动后都重复弹出快速上手 | 修改 | 已修复 |

## 处理记录

- 1：在 Electron 就绪阶段移除默认应用菜单；保留 Windows 原生标题栏，页面内继续使用 MAWE 自己的工具栏与主题切换。
- 2：Electron Builder 改用包含多种尺寸的 `assets/maw.ico`，避免单张 500px PNG 被 Windows 缩放成不可辨识的窗口 / 任务栏图标。
- 3：MOSE 的 Server 页面通过 `/api/settings` 将 `completed/skipped` 写入用户级
  `%LOCALAPPDATA%\\MAW\\server-editor-settings.json`；页面启动时读取该值，不再把随机端口当成新用户。

## 验证

- 已验证：`node --check desktop/src/main.cjs`、`node --check web/launcher/launcher.js`、`npm test --prefix desktop`（17/17）、`python -B -m unittest tests.test_packaging_contract`（28/28），以及 ICO 文件头和多尺寸目录检查。
- Python GUI 测试未运行：当前系统 Python 缺少 `requests`，仓库 `.venv` 的 uv trampoline 又被本机权限拒绝；不是本次代码断言失败。
- 未验证边界：需要在 Windows 桌面上实际启动新构建的 `MOSE.exe`，确认标题栏和任务栏缓存刷新后的最终显示。
- 本项验证：`node --check web\\editor-onboarding.js` 通过；Server / 资源定向测试 4/4 通过。
  完整 Server 资源测试另有 1 个既有 `fontTools` 缺依赖错误；`blank-editor.html` 生成器可输出到临时目录，当前 worktree 产物因锁定未覆盖。
