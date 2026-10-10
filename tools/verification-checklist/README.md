# Verification Checklist · 人工核对工具

用于功能交付、测试反馈修复和发布前人工验收。将实现说明、自动化验证证据与可操作的人工核对项放在一张离线 HTML 中，维护者逐项确认、记录问题，再导出结果交回开发流程。

它是独立维护工具，不属于 Launcher 或字幕编辑器。生成页自包含，无网络请求、外部字体或运行依赖，双击即可使用；自动化通过不能代替人工确认。

## 文件结构

```text
verification-checklist/
  README.md                              使用说明与导出契约
  build.py                               生成页面 / 更新既有页面
  templates/verification-checklist.html   唯一页面模板，内含样式与脚本
```

## 生成与更新

准备 UTF-8 的分区 HTML，再在仓库根目录执行（Python 标准库即可，无需安装依赖）：

```powershell
python tools/verification-checklist/build.py --title "本次功能核对" --subtitle "范围、基线与已知未验证边界" --sections "$env:TEMP/verification-sections.html" --output "$env:TEMP/verification.html"
Start-Process "$env:TEMP/verification.html"
```

默认将生成物放仓库外，不加入 Git。用户明确要求更新已有核对页时：

```powershell
python tools/verification-checklist/build.py --refresh "$env:TEMP/verification.html"
```

更新会覆盖目标文件的页面外壳，保留页面标题、可见标题、分区内容与核对项 ID；可加 `--output` 另存。浏览器刷新后生效。同标题、同浏览器存储环境中的既有勾选与备注继续读取；迁移到别的浏览器或来源不保证共享本机存储。分段拼装的旧页面也要同步头尾分段，以免下一次拼装覆盖工具更新。

也可手动复制模板，替换 `{{TITLE}}`、`{{SUBTITLE}}`、`{{SECTIONS}}`；标题和副标题需要 HTML 转义。模板注释、脚本里不要出现这些占位符原文。

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

维护模板后同步更新明确指定的旧页面；不改 MAW 的 `blank-editor.html`。保留 `content-visibility` 优化、打印覆盖与局部宽内容滚动，长清单压力检查和间距实测遵循上级 `tools/AGENTS.md`。
