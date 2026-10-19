# Verification Checklist · 人工核对工具

用于功能交付、测试反馈修复和发布前人工验收。将实现说明、自动化验证证据与可操作的人工核对项放在一张离线 HTML 中，维护者逐项确认、记录问题，再导出结果交回开发流程。

它是独立维护工具，不属于 Launcher 或字幕编辑器。生成页自包含，无网络请求、外部字体或运行依赖，双击即可使用；自动化通过不能代替人工确认。

## 文件结构

```text
verification-checklist/
  README.md                               使用说明与导出契约
  build.py                                校验 / 生成页面 / JSON⇄MD 转换（仅标准库）
  examples/checklist.json                 JSON 授权数据示例（与 MD 契约等价）
  templates/verification-checklist.html   唯一页面模板，内含样式与脚本
```

## 生成与更新

推荐流程：AI 直接编写 **Markdown 清单**（契约见下节），脚本校验后填入统一模板生成交互页；同一份 MD 可贴进 PR 评论（渲染为带勾选框的清单），reviewer 取回原文即可重新生成 HTML。JSON 授权数据继续支持。只需 Python 标准库。

```powershell
# Markdown 授权数据 → 交互 HTML（--data 自动识别 .md / .json）
python tools/verification-checklist/build.py --data "docs/logs/release<版本>/<主题>.checklist.md" --output ".artifacts/verification/verification.html"

# 只校验不产出（agent 自查 / CI 用）；校验失败会指出行号与原因
python tools/verification-checklist/build.py --check "docs/logs/release<版本>/<主题>.checklist.md"

# JSON → Markdown（--meta 写入 front-matter；不提供 --meta 则生成无 front-matter 的评论版）
python tools/verification-checklist/build.py --to-md <清单>.json --meta task=<任务ID> --meta pr=<PR号> --meta date=YYYY-MM-DD --meta status=pending --output "<主题>.checklist.md"

# 状态追踪：汇总目录下全部 *.checklist.md 的 front-matter 状态与勾选进度
python tools/verification-checklist/build.py --scan docs/logs
```

生成前检查必填字段、字段类型、未知字段、重复字段、稳定 ID、徽标类型和表格列数（MD 与 JSON 同一套校验）；字段校验错误包含路径或行号，拒绝孤立 Unicode 代理字符及 HTML 无法保留的 NUL 字符。完整页面先写到输出目录的临时文件，再替换目标，校验或写入失败保留已有输出。所有数据文本都做 HTML 转义，不支持原始 HTML、脚本；命令只是展示，不会执行。JSON 支持 UTF-8 BOM。

兼容已有分区 HTML 输入：

```powershell
python tools/verification-checklist/build.py --title "本次功能核对" --subtitle "范围、基线与已知未验证边界" --sections ".artifacts/verification/verification-sections.html" --output ".artifacts/verification/verification.html"
```

默认将生成物放在仓库根 `.artifacts/<task-id>/`，不加入 Git；用户已指定仓库外目录时遵从指定。用户明确要求更新已有核对页时：

```powershell
python tools/verification-checklist/build.py --refresh ".artifacts/verification/verification.html"
```

更新会覆盖目标文件的页面外壳，保留页面标题、可见标题、分区内容与核对项 ID；可加 `--output` 另存。浏览器刷新后生效。同标题、同浏览器存储环境中的既有勾选与备注继续读取；迁移到别的浏览器或来源不保证共享本机存储。分段拼装的旧页面也要同步头尾分段，以免下一次拼装覆盖工具更新。

模板占位符由脚本替换；模板注释、脚本里不要出现占位符原文。

## Markdown 源格式（v2）

清单源文件是普通 Markdown，自带 YAML front-matter；它可以入库、可以整段贴进 PR 评论（HTML 注释元数据在 GitHub 渲染时不可见，任务项显示为原生勾选框），reviewer 复制原文另存为 `.md` 后用 `--data` 或 `--check` 即可校验/再生成交互页。

可以使用四反引号嵌套围栏的占位（此处保持原结构）：

````markdown
---
task: editor-burn-video        # 任务 ID（追踪用，可选）
pr: 241                        # 关联 PR（可选，整数）
date: 2026-10-15               # 创建日期（可选，YYYY-MM-DD）
status: pending                # 核验状态：pending | partial | passed（有 front-matter 时必填）
updated: 2026-10-16            # 最近更新日期（可选）
---

# 页面标题（唯一，也是 HTML localStorage 存档键）

> 副标题一行（范围、基线、已验证证据与未验证边界）

## 分区标题
<!-- id: section-stable-id -->
<!-- badge: todo 待核查 -->

普通段落就是一个 note 块；行首恰好是 - / 1. / > / # / ``` 时写 \-、1\.、\> 转义。

- 无序列表块
1. 有序列表块

```命令块（或行内 ```命令```）```

| 表头 | 表头 |
| --- | --- |
| 单元格内 \| 需转义 |  |

- [ ] **核对项测试目的（一句话说清验证什么）**
  （操作）入口 → 具体操作步骤
  （预期）可观察的预期行为
  （说明）补充背景或边界（可选；没有补充就整行省略，不要硬加）
  <!-- id: check-stable-id -->
````

规则与边界：

- 分区必须有 `<!-- id: -->`；核对项的 ID 注释放块尾（缩进两格独占一行，GitHub 渲染不可见，保留稳定 ID 供 HTML 勾选进度持久化）。`<!-- id: -->`、`<!-- badge: -->` 之外的 HTML 注释禁止出现在内容里。
- 核对项块的字段顺序固定（操作）→（预期）→（说明）；（操作）（预期）必填，（说明）可选；目的与字段不得包含 `**`、`<!--`、换行。目的行必须以 `- [ ]` / `- [x]` 加粗短句开头，`**` 闭合后不能再有内容。
- 核验完成后：把对应项改成 `- [x]`，front-matter `status` 更新为 `partial` / `passed`，提交回文档目录——这就是状态追踪的载体（`--scan` 汇总）。
- MD v2 不支持的 source 特性：`text` 块（改用 note）、分区 `open: false`（全部展开）、多行 note / 表格单元格换行——这些仍走 JSON。
- 存放位置：`docs/logs/release<版本>/<主题>.checklist.md`，与任务台账放在一起；HTML 生成物不入库（源入库、产物再生成）。贴 PR 评论时去掉 front-matter（`--to-md` 不带 `--meta` 即可）。
- JS/HTML 工具页里「导出 Markdown / 复制 Markdown」导出的是**核对结果快照**（勾选态 `- [x]`、缩进字段块、块尾核对项 ID、备注 `>` 引用行），格式与源清单的核对项块语法对齐，但它不是可再生的源清单（无 badge/note 等只读内容）。

## JSON 契约（兼容格式）

输入版本是 `maw.verification-checklist.source.v2`，与下文的核对结果导出格式不同；结果快照不能作为生成数据或进度导入。最小示例：

```json
{
  "schema": "maw.verification-checklist.source.v2",
  "title": "本次功能核对 · 2026-10-11",
  "subtitle": "范围、代码基线、已验证证据与未验证边界",
  "sections": [
    {
      "id": "manual-export",
      "title": "人工核验：导出",
      "badge": { "kind": "todo", "text": "待核查" },
      "blocks": [
        { "type": "note", "text": "自动化通过不能代替人工确认。" },
        {
          "type": "check",
          "id": "export-srt",
          "purpose": "导出内容正确",
          "operation": "编辑器 → 导出：选择 SRT 并保存",
          "expected": "文件内容与字幕一致"
        }
      ]
    }
  ]
}
```

顶层四个字段全部必填；`subtitle` 可为空。`sections` 和每区的 `blocks` 必须为非空数组，按数据顺序显示。分区必填 `id`、`title`、`blocks`，可选 `open`（布尔，默认 `true`）和 `badge`（必填 `kind`、`text`，`kind` 为 `pass` / `fixed` / `todo`）。全部对象拒绝未声明字段。

| `blocks[].type` | 必填字段 | 可选字段 / 显示方式 |
| --- | --- | --- |
| `text` | `text` | 普通说明，换行保留 |
| `note` | `text` | 次级说明，换行保留 |
| `command` | `text` | 等宽命令块，空白原样保留，局部横向滚动 |
| `list` | `items`（非空字符串数组） | `ordered`（布尔，默认 `false`） |
| `table` | `headers`（非空字符串数组）、`rows`（二维字符串数组） | 行列数必须与表头一致；允许零行与空单元格，宽表局部滚动 |
| `check` | `id`、`purpose`、`operation`、`expected` | 可选 `note`；页面渲染为目的 / 操作 / 预期 / 说明四行，初始未勾选 |

除明确允许为空的字段外，字符串不能只含空白。ID 必须以 ASCII 字母开头，仅含字母、数字、`-`、`_`，分区和核对项共用全页唯一空间；不能使用模板保留 ID（如 `reset`、`toc`）、`checklist-note-` 前缀或 JS 原型属性名（如 `constructor`）。同一任务重复生成时保持标题与 ID 不变，原有本机勾选和备注才能继续读取；全新任务使用独立标题。不要按位置自动重新编号，也不要复用已有 ID 表示另一个核对项。

可将以下提示词交给 AI，并附上当前任务证据与 `examples/checklist.json`：

```text
根据已提供的任务范围、代码基线和验证证据，编写核查清单 Markdown 源文件。
严格遵循 tools/verification-checklist/README.md 的「Markdown 源格式（v2）」契约；
front-matter 填 task/pr/date/status（status 先写 pending），正文按
实现/审查结论 → 修复记录 → 自动化证据 → 人工核验 → 后续操作分区。
说明、命令、列表和表格是只读 blocks；不要把自动化通过转换成人工勾选。
人工核对项写 v2 块：`- [ ] **测试目的**` 加缩进续行 `（操作）…`、`（预期）…`、
可选 `（说明）…`，块尾 `<!-- id: 稳定ID -->` 注释；说明只在有真实补充时写。
每项必须可执行、可观察，证据不足处写明未验证，不编造结果。
分区与核对项使用有语义的唯一稳定 ID；更新已有任务时保留标题和既有 ID。
写完运行 build.py --check <文件>.md 自查，通过后再生成 HTML。
```

## 编写核对项

分区默认依次包含：实现 / 审查结论、修复记录、自动化验证结果、人工核验、后续操作。只读内容可用 `.plain`、`.note`、`.cmd`、`table`；打勾项按 v2 块写清「测试目的 / 操作 / 预期」，补充背景放可选的「说明」；操作中包含具体入口，已知未验证和环境性失败须明确标注。

```html
<details class="section" open id="feature-export">
  <summary><span class="sec-title">导出功能</span><span class="badge fixed">已修复</span></summary>
  <div class="body">
    <p class="note">自动化结果与未验证边界。</p>
    <div class="item" data-copy="导出内容正确（操作）进入导出 → 选择格式并保存（预期）文件内容与字幕一致">
      <input type="checkbox" id="export-01">
      <label for="export-01"><span class="item-purpose">导出内容正确</span><span class="item-line item-op"><span class="item-entry">编辑器 → 导出</span>选择 SRT 并保存</span><span class="item-line item-exp">文件内容与字幕一致</span></label>
    </div>
  </div>
</details>
```

每项必须是 `.item` 中的一对 checkbox 与 label，并属于 `details.section`。ID 全页唯一且稳定；标题用 `.sec-title` 或 summary 的直接文本，徽标用 `.badge.pass` / `.badge.fixed` / `.badge.todo`。生成器检查重复 ID、checkbox 缺 ID / label；目录、进度、SVG 折叠箭头与备注入口自动装配，不要手写重复组件。

## 维护者使用

1. 点击核对项文字或复选框确认，左栏和分区进度自动更新。分区内全部核对项已勾选时，标题栏显示淡绿色（展开、折叠均保留），与更鲜明的进度徽标区分；取消勾选或重置后恢复原色，只读分区不变色。
2. 点击每项右侧「备注」输入多行说明。输入即时保存在本机，已有备注刷新后自动展开；收起输入框不会删除备注。
3. 左栏默认选择「仅未确认和备注项」，导出未确认项与有非空备注项的并集（包括已确认但有备注的条目），并排除忽略组；也可选择「全部核对项」保留完整快照。仅含空白的备注不算有备注，备注不会改变勾选状态。 点击「导出 JSON」保存机器可读快照，或「导出 Markdown」保存人可读任务列表及备注；「复制 Markdown」复制相同范围的结果，无剪贴板 API 时尝试兼容回退。
4. 「隐藏已勾选」仅隐藏已确认项，再点击「显示已勾选」恢复；显示偏好按页面保存。进度、备注和导出范围不变，隐藏模式下「全部核对项」仍导出所有项。
5. 左栏「全勾选后自动收起」默认开启，勾选某组最后一个未确认项时自动折叠该组；开关状态按页面保存，已保存的关闭偏好继续保留。它不改变已有组的展开状态，取消勾选后可手动重新展开。
6. 鼠标悬停在含核对项分区的标题栏时，计数左侧出现「忽略」按钮：点击后整组标题变灰并自动折叠，组内项目按已处理计算（总进度、分组与目录计数同步），不再出现在「隐藏已勾选」视图和「仅未确认和备注项」导出中（即使有备注）；悬停再点「取消忽略」恢复展开与真实勾选计数。「重置勾选」会一并清除忽略状态，备注保留。
7. 「重置勾选」先要求二次确认，确认后仅清除确认与忽略状态，保留备注；取消时不改变页面与保存状态。要删除某条备注，展开后清空文字。
8. 打印时自动展开分区并显示完整备注，结束后恢复原来的折叠状态；隐藏已勾选模式下打印只含当前显示的核对项。
9. 每条核对项右侧的「复制」复制该项的目的与（操作）（预期）（说明）全文，不包含按钮、勾选状态或核验备注。浏览器不允许访问剪贴板时会提示手动选择复制。

存储失败时页面明确提示，请立即导出留存；即使本机存储不可用，当前页面仍能勾选、填写备注与导出。导出的 JSON / Markdown 是核对结果快照，本工具暂不提供导入或跨设备同步。导出文件含你填写的备注，分享前检查内容。

## 核对结果 Markdown 格式

「导出 Markdown / 复制 Markdown」产出与结果 JSON 同构的可读副本：

- `# {标题} · 核对结果` + 引用行元信息（副标题、导出范围、时间、总计/已确认/忽略/未确认/导出数）。
- 每个含核对项的分区一个 `## 分区标题`（被忽略的分组在 `scope: all` 导出中标注「（已忽略）」）。
- 核对项按源格式输出为 `- [x] / - [ ] {目的}` 加缩进字段块（（操作）（预期）（说明）逐行），块尾 `<!-- id: 稳定ID -->`，多行备注紧跟缩进引用行 `  > …`（逐字保留）。
- 与源清单的核对项块语法对齐，但它不含 badge / note 等只读内容，**不是**可再生的源清单；把它转回 HTML 请用源 `.checklist.md`。

## JSON 结果格式

```json
{
  "schema": "maw.verification-checklist.v1",
  "title": "本次功能核对",
  "subtitle": "范围、基线与已知未验证边界",
  "exportedAt": "2026-10-09T00:00:00.000Z",
  "scope": "unconfirmed",
  "summary": { "total": 2, "confirmed": 1, "ignored": 0, "unconfirmed": 1, "exported": 1 },
  "sections": [
    {
      "id": "feature-export",
      "title": "导出功能",
      "items": [
        { "id": "export-01", "text": "导出内容正确\n（操作）编辑器 → 导出：选择 SRT 并保存\n（预期）文件内容与字幕一致", "confirmed": false, "ignored": false, "note": "尚待人工核验" }
      ]
    }
  ]
}
```

`scope` 为 `all` 或 `unconfirmed`，后者沿用既有字段值，现在表示「未确认项 ∪ 有非空备注项」，仍排除忽略组。`summary` 的整页统计不受导出范围影响：`confirmed` 为已勾选数，`ignored` 为被忽略分组的核对项数（两者可能重叠），`unconfirmed` 为既未确认也未被忽略的项数，`exported` 为实际导出项数；每项含 `ignored` 布尔字段标记所在分组是否被忽略。只导出核对项及其分区标题，不导出只读报告、表格或个人文件路径。筛选后没有核对项的分区省略，核对项文字规范化连续空白，备注保留原始换行和空白。没有可导出的项目时按钮禁用；新增或清空备注会立即更新按钮可用状态。时间为 UTC ISO 8601，下载文件名包含「全部」或「未确认和备注」范围后缀与日期。

## 修改与验证

生成器定向测试（JSON/Markdown 授权契约、往返、转义、front-matter 校验、scan、输入文件保护与旧页刷新）：

```powershell
uv run --no-sync python scripts/run_tests.py tests/test_verification_checklist.py tests/test_verification_checklist_build.py
```

安装仓库 Node 开发依赖与 Playwright 浏览器后，运行生成页回归（只打开本地文件，不启动服务；可用 `MAW_E2E_PYTHON` 指定 Python）：

```powershell
pnpm exec playwright test tests/e2e/verification-checklist.spec.mjs --project=chromium
```

维护模板后同步更新明确指定的旧页面；不改 MAW 的 `blank-editor.html`。保留 `content-visibility` 优化、打印覆盖与局部宽内容滚动，长清单压力检查和间距实测遵循上级 `tools/AGENTS.md`。
