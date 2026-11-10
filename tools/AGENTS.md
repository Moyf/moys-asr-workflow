# tools/ 目录指导（HTML 工具页设计、性能与测量约定）

本目录存放独立小工具（如 `verification-checklist/`、`term-extract/`）。这类页面会被
维护者在真实浏览器里长时间交互，性能问题（窗口缩放卡死、滚动卡顿）一旦带入模板，
每次生成都复现。本文记录已踩过的坑与对应约定，改 HTML 工具页前后都过一遍。

## 设计与交互：必须先读 TOOL_PAGE_GUIDE.md

**新建或修改任何工具页（确认页、核对页、对比页、审阅页、仪表盘）前，必须先读
[TOOL_PAGE_GUIDE.md](TOOL_PAGE_GUIDE.md) 并遵循。**它规定了配色令牌（与 MAW Launcher
一致、深浅双主题）、页面骨架与窄屏底栏、卡片信息分层、整行点击热区、分组、筛选、
选择与导出、图片弹层、键盘审阅、精简显示、模板实现陷阱和浏览器验证流程，末尾有交付前
自查清单。交付时按清单逐项自查，并把截图与探针结果记入任务台账。

要点速记（细节与理由以 TOOL_PAGE_GUIDE.md 为准）：

- 配色照搬 Launcher 令牌（深色橙 / 浅色红强调），必须同时有深色和浅色，样式里不出现裸色值；
- 主操作一步可达：卡片**整行可点**勾选，分组头**整条可点**折叠，导出栏常驻并能预览；
- 勾选状态存在唯一的 `Set` 里，筛选重建后保留；预览与导出同源；不用 `alert()`，用 toast；
- 窄屏导出栏用单行底栏，不把桌面面板堆到页面底部；
- 缩略图写宽高且只约束一个方向（同时约束两个方向会把图压扁）；
- Python 字符串里的模板要双写 JS 反斜杠，测试里对生成页脚本跑 `node --check`；
- 交付前完成浏览器截图（深 / 浅 / 窄屏 / 弹层）、交互探针、溢出检查和重排计时。

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

- 生成核查清单时优先编写 Markdown v2 源文件，再用 `verification-checklist/build.py --check <清单>.md`
  校验、`verification-checklist/build.py --data <清单>.md --output <HTML>` 自动套用模板；JSON 保留兼容入口。
  数据契约、完整示例和 AI 提示词见该工具 README.md，不要每次手写分区 HTML。
- 占位符原文只出现在真实替换点，注释与脚本里不得复现（全局替换会误伤）；
- 模板位于 `verification-checklist/templates/verification-checklist.html`，用途、生成与
  更新命令见 `verification-checklist/README.md`；默认生成物放根 `.artifacts/<task-id>/`，不提交；维护者已指定仓库外目录时遵从指定。维护者明确要求
  更新既有核对页时同步应用模板。改动后用一份含长命令、宽表格、数百
  打勾项的压力实例实测 resize 与滚动，再交付。
