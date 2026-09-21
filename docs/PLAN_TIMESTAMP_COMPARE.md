# 时间码对比页面计划（tools/timestamp-compare.html）

## 背景

用户对「生成时间码」工具箱的三项反馈：

| # | 问题 | 处理 | 状态 |
|---|------|------|------|
| 1 | 【媒体来源】【视频来源】分组输入区有双层边框 | `launcher.css` 去内层框，保留拖拽高亮 | 已完成（commit `93a18d29`） |
| 2 | 字词时间码 SRT 体现不出差异，SRT 产出多余 | 「生成时间码」固定「仅工程」输出（`gui_web.py`） | 已完成（commit `d1a371d9`） |
| 3 | 需要一个页面检查生成时间码前后的字词时间码质量 | 本文 | 已完成 |

## 目标

新建 `tools/timestamp-compare.html`（独立单文件工具，风格与 `tools/compare.html` 一致）：

- 拖入 1 个 `.mosp` / `.json` 工程 → 时间码查看模式
- 拖入 2 个 → 按段序号对齐的时间码对比模式（生成时间码不改变分段，序号对齐成立）
- `.srt` 也接受，但标注「无字词时间码」，仅段级对照
- 最多 2 个文件（A/B），超出提示
- 嵌入数据支持：页面加载时读取 `window.__MAW_TS_EMBED__`，供后续「生成时间码完成后自动产出对比报告 HTML」注入

## 数据契约

- `segments[*].start/end`：整数毫秒
- `segments[*].items`：`[{text, start, end}]`，整数毫秒；可缺失或 `[]`
- 顶层 `timestamp_granularity`：`char` / `word` / `segment` / `unknown`，有则显示
- `disabled: true` 的段跳过

## 页面设计

### 结构

- topbar：品牌「MAW 时间码对比」、添加文件、清空、「只看差异」开关、「显示 items 文本」开关、文本搜索
- 卡片区：每个文件一张卡（名称、来源类型、粒度、段数、items 覆盖率、时间跨度）
- 对比摘要条（双文件时）：配对段数、段级时间一致数、items 状态分布（双侧无 / 仅A有 / 仅B有 / 词数不同 / 词时不同 / 完全一致）
- 表格：序号列 + 每文件一列；每格 = 文本、段级时间 + 偏差、items 徽章（数量）、段内相对时间条（items 色块，直观对比粒度密度）；打开「显示 items 文本」后在色块上方单独一行显示对应 item 文本，标签宽度按文本自适应
- 点击行展开 items 明细：序号 | 文本 | 各文件 start–end | Δstart/Δend（数量相等时逐项配对）
- 状态栏图例

### 差异分类（行级 chip）

- 段级 start/end 不同 → 「时间」
- items 有无不同 → 「字词码」
- items 数量不同 → 「词数 n→m」
- items 拼接文本不同 → 「文本」
- 同数量同文本但 item 时间不同 → 「词时」
- 全同 → 无标记；「只看差异」时隐藏

### 嵌入 API

```html
<script>window.__MAW_TS_EMBED__={files:[{name:"a.mosp",project:{…}}]};</script>
```

- 页面加载时自动检测并渲染；注入方需转义 JSON 中的 `</script>`（如 `<` → `\u003c`）
- 同时暴露 `window.MAWTsCompare = { state, loadProjectObjects }` 便于自动化测试

## 明确不做

- 不做文本相似度对比（`compare.html` 已有）
- 不做时间分布波形面板、缩放
- 不支持 >2 个文件
- 不引入外部依赖、不做虚拟滚动（与 compare.html 同为全量渲染）

## 实现与验证

已实现为 `tools/timestamp-compare.html`，按原数组段序号对齐，不改写输入文件；SRT 仅参与段级比较，禁用段跳过。页面同时暴露 `window.MAWTsCompare`，供嵌入报告和自动化测试使用。

1. 提取内联 `<script>` 用 Node `vm.Script` 语法检查
2. `tests/e2e/timestamp-compare.spec.mjs` 覆盖拖入/选择文件、双工程对比、单工程数据契约、嵌入数据、行展开、搜索和只看差异
3. `git diff --check`（UTF-8 / LF）

## 后续反馈（2026-09-20）

| # | 反馈 | 处理 | 状态 |
|---|------|------|------|
| 4 | subtitle 与 item 缺少 duration | 在段级时间行、item 文本标签和展开明细中显示秒级 duration；保留原始起止时间 | 已修复 |
| 5 | item 超出所属 subtitle 范围、完全没有 items 时缺少视觉提示 | 解析 item 时记录越界状态；越界使用红色样式，空 items 使用虚线/琥珀色独立样式，缺段不混入空 items | 已修复 |
| 6 | 需要只查看 empty 或越界 items | 顶部增加 items 筛选，与文本搜索和只看差异叠加；双文件任一侧命中即可保留该行 | 已修复 |

本轮验证：

- `npx playwright test tests/e2e/timestamp-compare.spec.mjs --project=chromium`：3/3 通过
- 内联 `<script>` `vm.Script` 语法检查：通过
- `node --check tests/e2e/timestamp-compare.spec.mjs`：通过
- `git diff --check`：通过

## 性能与显示反馈（2026-09-20）

| 反馈 | 处理 | 状态 |
|------|------|------|
| 调整窗口大小时页面容易卡住 | 表格行启用 `content-visibility: auto` 和 intrinsic size，时间条启用布局隔离；连续 resize 时暂时停绘制 item-label，停止后自动恢复 | 已修复 |
| item-label 背景和边缘会互相遮挡 | 去掉 label 的背景、边框和盒阴影，只保留文字阴影；越界 label 也保持同样的无底样式 | 已修复 |
| duration 只需两位小数且不显示 `s` | 统一显示为两位小数，例如 `1.00`、`0.30` | 已修复 |

## 文档

- `docs/LOCAL_ASR.md` 「生成时间码」小节提及对比页面用法
- 如有用户可感知变更，进 CHANGELOG（发布时归并）
