# tools/ 目录指导（HTML 工具页性能与测量约定）

本目录存放独立小工具（如 `verification-checklist/`）。这类页面会被
维护者在真实浏览器里长时间交互，性能问题（窗口缩放卡死、滚动卡顿）一旦带入模板，
每次生成都复现。本文记录已踩过的坑与对应约定，改 HTML 工具页前后都过一遍。

## 窗口缩放卡死：整页逐帧重排是根因

现象：连续横向拉伸窗口（如 1800→800px）时页面完全冻结。

机制：resize 的每一帧浏览器都要重算样式 + 重排版。默认排版成本是 **O(整页长度)**
——清单越长（几百个打勾项、几十张表格），每帧重排越贵（实测 900 打勾项时单帧
14–43ms），拖动速率 30–60 事件/秒直接把主线程吃满。`max-width` 居中布局只能
掩护到内容开始收缩的宽度，往下全中招。

修复约定（verification-checklist.html 已落地）：

1. **离散大块内容加 `content-visibility: auto` + `contain-intrinsic-size`**：
   屏外分区整体跳过排版与绘制，resize 成本从 O(整页) 降到 O(视口)
   （实测同一页面 43.3ms → 2.1ms）。适合清单分区、卡片列表这类天然分块的结构。
   - `contain-intrinsic-size` 用 `auto <估计高度>`：`auto` 让浏览器记住真实
     渲染尺寸，估计值只影响首次滚动；
   - **必须加 `@media print` 覆盖为 `content-visibility: visible`**，否则打印时
     屏外内容整段丢失；
   - 屏外元素的 DOM 仍可查询与操作（勾选持久化、目录进度统计不受影响）。
2. **根滚动条禁用全局 `scroll-behavior: smooth`**：它作用于所有程序化滚动
   （脚本 scrollTo、锚点、未来扩展），高频程序化横向滚动会逐帧动画叠加。
   平滑滚动只在确有交互收益处用 JS `scrollIntoView({ behavior: 'smooth' })`
   显式触发，并尊重 `prefers-reduced-motion`。
3. **宽内容在所在分区内自滚动，不撑破页面**：长命令/宽表格用
   `overflow-x: auto` 容器承接，页面级永不出现横向滚动条。

## 测量方法的坑（Paseo/后台 webview）

- **后台 webview 的 rAF 与定时器会被冻结/节流**：依赖 rAF 的帧耗时测量、
  "滚动 60 帧计时" 在后台标签全部失真——读数可能显示"单帧数秒""0 帧渲染"，
  都是假象。Frame 级测量必须在真实前台浏览器做。
- **可靠且后台可用的替代：同步强制重排计时**。改容器宽度 → `void root.offsetHeight`
  强制同步布局 → `performance.now()` 计时，遍历一组宽度（要覆盖媒体查询断点
  附近，如 980px 上下）。它能给出"单次 resize 事件的排版成本"，足以定位与验收。
- `PerformanceObserver('longtask')` 在后台标签同样不可靠（条目延迟/缺失）。
- 验收线：连续 resize 场景下单次重排应 < 8ms（60fps 帧预算的一半）。

## 模板维护的既有约定（延续根 AGENTS.md）

- 占位符原文只出现在真实替换点，注释与脚本里不得复现（全局替换会误伤）；
- 模板位于 `verification-checklist/templates/verification-checklist.html`，用途、生成与
  更新命令见 `verification-checklist/README.md`；默认生成物放仓库外，维护者明确要求
  更新既有核对页时同步应用模板。改动后用一份含长命令、宽表格、数百
  打勾项的压力实例实测 resize 与滚动，再交付。
