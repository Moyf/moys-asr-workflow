---
name: verification-checklist
description: 在 moys-asr-workflow（MAW）中生成或更新「人工核对清单」HTML 工具页。当一批功能开发 / 测试反馈修复完成、需要维护者逐项人工验收（打勾、备注、忽略分组、导出结果），或用户提到"生成核对清单 / verification checklist / 人工验收页 / 核验 HTML"时使用。覆盖 tools/verification-checklist 的生成命令、分区与打勾项写法、占位符与存储规则、既有页面刷新约定。
---

# 人工核对清单工具（tools/verification-checklist）

用于功能交付、测试反馈修复和发布前的人工验收：把实现说明、自动化验证证据与可操作的人工核对项放进一张自包含离线 HTML，交维护者逐项确认。生成物双击即用，无网络请求、无运行依赖。

先读这两个文件（本 skill 只做摘要，冲突时以它们为准）：

- `tools/verification-checklist/README.md` — 使用说明与 JSON 导出契约
- `tools/AGENTS.md` — HTML 工具页性能与测量约定（窗口缩放卡死的根因与修复约定）
- 根 `AGENTS.md`「批量改动的人工核查清单」— 何时生成清单、分区约定

## 文件结构

```text
tools/verification-checklist/
  README.md                               使用说明与导出契约
  build.py                                生成页面 / 刷新既有页面（仅标准库）
  templates/verification-checklist.html   唯一页面模板（样式与脚本内嵌）
```

## 生成与刷新

在仓库根目录执行（Python 标准库即可）：

```powershell
# 生成新清单：分区 HTML 需先写成 UTF-8 文件
python tools/verification-checklist/build.py --title "本次功能核对" --subtitle "范围、基线与已知未验证边界" --sections "$env:TEMP/verification-sections.html" --output "$env:TEMP/verification.html"

# 维护者明确要求更新既有核对页时，用最新模板刷新外壳（保留标题、分区内容与核对项 ID）
python tools/verification-checklist/build.py --refresh <既有页.html>
```

生成物放在仓库外（如 `%TEMP%`），用浏览器打开，**不提交进仓库**。例外：`docs/verifications/` 下已被跟踪的归档页，在维护者明确要求时才 `--refresh`；分段拼装的旧页面（`parts/00-head.html` + 各分区 + `99-tail.html`）刷新后必须同步重切头尾分段，再校验按文件名顺序拼装结果与整页一致。

## 编写规则

分区标准写法：

```html
<details class="section" open id="feature-export">
  <summary><span class="sec-title">导出功能</span><span class="badge fixed">已修复</span></summary>
  <div class="body">
    <p class="note">自动化结果与未验证边界。</p>
    <div class="item">
      <input type="checkbox" id="export-01">
      <label for="export-01">入口 → 操作 → 预期。</label>
    </div>
  </div>
</details>
```

- 每个打勾项必须是 `.item` 内的一对 `checkbox + label`，属于某个 `details.section`；ID 全页唯一且稳定（勾选与备注按 ID 持久化，改 ID 丢进度）。建议按来源命名，如 `p191-01`。
- 分区顺序约定：实现 / 审查结论（只读）→ 修复与提交记录 → 自动化验证结果（写明命令与已知环境性失败，不用自动化冒充人工层）→ 人工核验打勾项 → 后续操作步骤。
- 打勾项写成可操作步骤（入口 → 操作 → 预期行为）；间距类验收必须写实测要求（如 `getComputedStyle` 的 marginTop、相邻元素实际像素距离 ≥ 8px），不能凭截图目测。
- 徽标：`.badge.pass`（通过）`.badge.fixed`（已修复）`.badge.todo`（待办 / 阻塞）。只读内容用 `.plain`、`.note`、`.cmd`、`table`。
- 占位符 `{{TITLE}}`、`{{SUBTITLE}}`、`{{SECTIONS}}` 原文只允许出现在模板真实替换点，分区内容、注释、脚本里不得复现（build.py 的一次性替换会被全局重替换误伤）。标题与副标题由 build.py 自动 HTML 转义；手写替换时需自行转义。
- 生成器会在写盘前校验重复 ID、checkbox 缺 ID / label，失败即退出。
- 所有文本 UTF-8 + LF。

## 维护者侧能力（写清单时可依赖，无需自建）

- 勾选与备注按页面标题存 localStorage（标题即持久化身份，改标题丢进度）；「重置勾选」清空勾选与忽略、保留备注。
- 每项可填写多行备注；左栏可切换「全部核对项 / 仅未确认项」导出 JSON（备注原样保留），可「隐藏已勾选」。
- 含核对项的分组悬停标题出现「忽略」：整组变灰折叠、计数按已处理、不进入未确认视图与导出；「全勾选后自动收起」勾完最后一项自动折叠该组；全部确认的分组标题呈淡绿色。
- 打印自动展开全部分区并显示备注，结束后恢复。

## 改模板本身（而不是某次清单）

- 不要为单次清单改动模板结构；确需改进直接改 `templates/verification-checklist.html`，让后续复用受益，并同步更新 README 与本 skill 提及的行为。
- 模板脚本用 `content-visibility: auto` 控制长页排版成本；改后用一份含长命令、宽表格、数百打勾项的压力实例实测连续 resize（单次重排 < 8ms）与滚动，再交付。注意后台 webview 的 rAF / longtask 测量不可靠，用同步强制重排计时。
- 模板改动后的验证命令：

```powershell
node --test tests/test_verification_checklist.mjs
uv run --no-sync python -m unittest discover -s tests -p test_verification_checklist.py
```
