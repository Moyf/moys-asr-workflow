# Verification Checklist · 人工核对工具

用于功能交付、测试反馈修复和发布前人工验收。将实现说明、自动化验证证据与可操作的人工核对项放在一张离线 HTML 中，维护者逐项确认、记录问题，再导出结果交回开发流程。

它是独立维护工具，不属于 Launcher 或字幕编辑器。生成页自包含，无网络请求、外部字体或运行依赖，双击即可使用；自动化通过不能代替人工确认。

## 文件结构

```text
verification-checklist/
  README.md                              使用说明与导出契约
  build.py                               生成页面 / 更新既有页面
  examples/checklist.json                 AI 编写数据的完整示例
  templates/verification-checklist.html   唯一页面模板，内含样式与脚本
```

## 生成与更新

推荐流程：AI 生成 UTF-8 JSON 数据，运行脚本校验并填入统一模板，双击生成的 HTML 开始核对。只需 Python 标准库，无需安装依赖，也无需每次手写 HTML。

先用仓库内示例生成一页：

```powershell
python tools/verification-checklist/build.py --data tools/verification-checklist/examples/checklist.json --output ".artifacts/verification/verification.html"
Start-Process ".artifacts/verification/verification.html"
```

实际任务将 AI 输出保存为 JSON，再生成：

```powershell
python tools/verification-checklist/build.py --data ".artifacts/verification/checklist.json" --output ".artifacts/verification/verification.html"
```

生成前检查必填字段、字段类型、未知字段、重复 JSON 字段、稳定 ID、徽标类型和表格列数；字段校验错误包含路径，拒绝孤立 Unicode 代理字符及 HTML 无法保留的 NUL 字符。完整页面先写到输出目录的临时文件，再替换目标，校验或写入失败保留已有输出。所有数据文本都做 HTML 转义，不支持原始 HTML、Markdown 或脚本；命令只是展示，不会执行。JSON 支持 UTF-8 BOM。

兼容已有分区 HTML 输入：

```powershell
python tools/verification-checklist/build.py --title "本次功能核对" --subtitle "范围、基线与已知未验证边界" --sections ".artifacts/verification/verification-sections.html" --output ".artifacts/verification/verification.html"
Start-Process ".artifacts/verification/verification.html"
```

默认将生成物放在仓库根 `.artifacts/<task-id>/`，不加入 Git；用户已指定仓库外目录时遵从指定。用户明确要求更新已有核对页时：

```powershell
python tools/verification-checklist/build.py --refresh ".artifacts/verification/verification.html"
```

更新会覆盖目标文件的页面外壳，保留页面标题、可见标题、分区内容与核对项 ID；可加 `--output` 另存。浏览器刷新后生效。同标题、同浏览器存储环境中的既有勾选与备注继续读取；迁移到别的浏览器或来源不保证共享本机存储。分段拼装的旧页面也要同步头尾分段，以免下一次拼装覆盖工具更新。

模板占位符由脚本替换；模板注释、脚本里不要出现占位符原文。

## AI 生成用 JSON 契约

输入版本是 `maw.verification-checklist.source.v1`，与下文的核对结果导出格式不同；结果快照不能作为生成数据或进度导入。最小示例：

```json
{
  "schema": "maw.verification-checklist.source.v1",
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
          "entry": "编辑器 → 导出",
          "action": "选择 SRT 并保存",
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
| `check` | `id`、`entry`、`action`、`expected` | 自动组装「入口 → 操作 → 预期」，初始未勾选 |

除明确允许为空的字段外，字符串不能只含空白。ID 必须以 ASCII 字母开头，仅含字母、数字、`-`、`_`，分区和核对项共用全页唯一空间；不能使用模板保留 ID（如 `reset`、`toc`）、`checklist-note-` 前缀或 JS 原型属性名（如 `constructor`）。同一任务重复生成时保持标题与 ID 不变，原有本机勾选和备注才能继续读取；全新任务使用独立标题。不要按位置自动重新编号，也不要复用已有 ID 表示另一个核对项。

可将以下提示词交给 AI，并附上当前任务证据与 `examples/checklist.json`：

```text
根据已提供的任务范围、代码基线和验证证据生成核查清单 JSON。
严格遵循 tools/verification-checklist/README.md 的 source.v1 契约和示例；
只输出一个 JSON 对象，不输出 Markdown 代码围栏，不编写 HTML。
按实现/审查结论、修复记录、自动化证据、人工核验、后续操作安排分区。
说明、命令、列表和表格放在只读 blocks 中；不要把自动化通过转换成人工勾选。
人工核对项使用 check，并分别填写 entry、action、expected。
每项必须可执行、可观察，证据不足处写明未验证，不编造结果。
使用有语义的唯一稳定 ID；更新已有任务时保留标题和既有 ID。
```

## 编写核对项

分区默认依次包含：实现 / 审查结论、修复记录、自动化验证结果、人工核验、后续操作。只读内容可用 `.plain`、`.note`、`.cmd`、`table`；打勾项写清「入口 → 操作 → 预期」，已知未验证和环境性失败须明确标注。

```html
<details class="section" open id="feature-export">
  <summary><span class="sec-title">导出功能</span><span class="badge fixed">已修复</span></summary>
  <div class="body">
    <p class="note">自动化结果与未验证边界。</p>
    <div class="item">
      <input type="checkbox" id="export-01">
      <label for="export-01">进入导出 → 选择格式并保存 → 检查文件内容符合预期。</label>
    </div>
  </div>
</details>
```

每项必须是 `.item` 中的一对 checkbox 与 label，并属于 `details.section`。ID 全页唯一且稳定；标题用 `.sec-title` 或 summary 的直接文本，徽标用 `.badge.pass` / `.badge.fixed` / `.badge.todo`。生成器检查重复 ID、checkbox 缺 ID / label；目录、进度、SVG 折叠箭头与备注入口自动装配，不要手写重复组件。

## 维护者使用

1. 点击核对项文字或复选框确认，左栏和分区进度自动更新。分区内全部核对项已勾选时，标题栏显示淡绿色（展开、折叠均保留），与更鲜明的进度徽标区分；取消勾选或重置后恢复原色，只读分区不变色。
2. 点击每项右侧「备注」输入多行说明。输入即时保存在本机，已有备注刷新后自动展开；收起输入框不会删除备注。
3. 左栏选择「全部核对项」或「仅未确认项」，点击「导出 JSON」。备注不影响确认状态，未确认即 checkbox 未勾选。
4. 「隐藏已勾选」仅隐藏已确认项，再点击「显示已勾选」恢复；显示偏好按页面保存。进度、备注和导出范围不变，隐藏模式下「全部核对项」仍导出所有项。
5. 左栏「全勾选后自动收起」开启后，勾选某组最后一个未确认项时自动折叠该组；开关状态按页面保存。它不改变已有组的展开状态，取消勾选后可手动重新展开。
6. 鼠标悬停在含核对项分区的标题栏时，计数左侧出现「忽略」按钮：点击后整组标题变灰并自动折叠，组内项目按已处理计算（总进度、分组与目录计数同步），不再出现在「隐藏已勾选」视图和「仅未确认项」导出中；悬停再点「取消忽略」恢复展开与真实勾选计数。「重置勾选」会一并清除忽略状态，备注保留。
7. 「重置勾选」仅清除确认与忽略状态，保留备注；要删除某条备注，展开后清空文字。
8. 打印时自动展开分区并显示完整备注，结束后恢复原来的折叠状态；隐藏已勾选模式下打印只含当前显示的核对项。

存储失败时页面明确提示，请立即导出留存；即使本机存储不可用，当前页面仍能勾选、填写备注与导出。JSON 是核对结果快照，本工具暂不提供导入或跨设备同步。导出文件含你填写的备注，分享前检查内容。

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
        { "id": "export-01", "text": "入口 → 操作 → 预期", "confirmed": false, "ignored": false, "note": "尚待人工核验" }
      ]
    }
  ]
}
```

`scope` 为 `all` 或 `unconfirmed`。`summary` 的前三项始终统计整页，`ignored` 为被忽略分组的核对项数，`unconfirmed` 为既未确认也未被忽略的项数，`exported` 为实际导出项数；每项含 `ignored` 布尔字段标记所在分组是否被忽略。`scope` 为 `unconfirmed` 时忽略分组的核对项不导出。只导出核对项及其分区标题，不导出只读报告、表格或个人文件路径。筛选后没有核对项的分区省略，核对项文字规范化连续空白，备注保留原始换行和空白。没有可导出的项目时按钮禁用。时间为 UTC ISO 8601，下载文件名包含范围与日期。

## 修改与验证

生成器定向测试（包括 JSON 校验、文本转义、BOM、输入文件保护与旧页刷新）：

```powershell
python scripts/run_tests.py --pattern test_verification_checklist.py
```

安装仓库 Node 开发依赖与 Playwright 浏览器后，运行生成页回归（只打开本地文件，不启动服务；可用 `MAW_E2E_PYTHON` 指定 Python）：

```powershell
pnpm exec playwright test tests/e2e/verification-checklist.spec.mjs --project=chromium
```

维护模板后同步更新明确指定的旧页面；不改 MAW 的 `blank-editor.html`。保留 `content-visibility` 优化、打印覆盖与局部宽内容滚动，长清单压力检查和间距实测遵循上级 `tools/AGENTS.md`。
