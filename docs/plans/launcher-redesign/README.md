# Launcher 改版原型

静态原型 v4，用于和维护者确认 Launcher 现代化改版的布局、配色与交互。数据都是假的，不连后端；方案与已确认的决定见 [Launcher 现代化改版设计方案](../LAUNCHER_REDESIGN.md)，实施进度见[实施记录](../../logs/unversioned/2026-10-14/LAUNCHER_REDESIGN_IMPLEMENTATION.md)。

原型只是参考，不是实现：正式代码在 `web/launcher/`，以方案文档和实际代码为准。原型中的令牌值（`tokens.css`）是讨论阶段的版本，最终品牌色见方案第 3 节（亮色 `#c84545`、暗色 `#f09a50`）。

## 文件

| 文件 | 内容 |
| --- | --- |
| `prototype.html` | 原型页面，浏览器直接打开（file://）即可 |
| `prototype.js` | 页面切换、配置抽屉、「可用于自动后处理」开关等演示逻辑 |
| `tokens.css` / `base.css` / `components.css` / `pages.css` | 原型样式：令牌、基础、组件、页面 |
| `shoot.ps1` | 用 Edge headless 批量截图；输出到仓库根 `.artifacts/launcher-redesign/shots/`（Git 忽略） |
| `shots/*.webp` | 挑选后的参考截图（原型、阶段 1 实现、编辑器配色对齐） |

页面图标直接引用仓库 `assets/` 下的 `maw-icon-rounded.png` 与 `show.webp`，不另存副本。

## URL 参数

`prototype.html?page=&theme=&state=&sheet=&set=&tool=&prov=&collapsed=1&help=1`

- `page`：`transcribe`（默认）/ `batch` / `toolbox` / `projects` / `settings`
- `theme`：`dark`，缺省为亮色
- `state`：转写页状态 `empty` / `ready` / `running` / `done` / `nokey`
- `sheet`：打开配置抽屉并定位到某一步，例如 `proofread`、`translate`
- `set`：设置页分区，例如 `llm`、`runtime`
- `tool`：工具箱当前工具，例如 `translate`、`burn`
- `prov`：识别服务商，例如 `soniox`、`openai`、`local`、`tencent`
- `collapsed=1`：窄导航；`help=1`：展开帮助菜单
