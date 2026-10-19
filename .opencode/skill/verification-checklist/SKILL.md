---
name: verification-checklist
description: 在 moys-asr-workflow（MAW）中编写「人工核对清单」并生成 HTML 工具页。当一批功能开发 / 测试反馈修复完成、需要维护者逐项人工验收（打勾、备注、忽略分组、导出结果），或用户提到"生成核对清单 / verification checklist / 人工验收页 / 核验 HTML"时使用。核心：agents 只写 Markdown 源清单（带 front-matter 状态），调用 build.py 校验并生成 HTML；MD 入库与台账放一起，HTML 不入库；页面可导出 JSON / Markdown 结果快照。
---

# 人工核对清单工具（tools/verification-checklist）

用于功能交付、测试反馈修复和发布前的人工验收：agent 编写 Markdown 清单 → `build.py` 校验并生成交互 HTML → 维护者逐项确认 → 勾选结果可再导出 JSON / Markdown。生成页自包含、双击即用、无网络依赖。

先读这两个文件（本 skill 只做摘要，冲突时以它们为准）：

- `tools/verification-checklist/README.md` — 完整契约：**Markdown 源格式（v2）**、JSON 兼容契约、front-matter、导出与刷新
- `tools/AGENTS.md` — HTML 工具页性能与测量约定
- 根 `AGENTS.md`「批量改动的人工核查清单」— 何时生成清单、分区约定

## 标准工作流（agents 只写 Markdown）

1. **写 `<主题>.checklist.md`**：YAML front-matter（`task` / `pr` / `date` / `status: pending`）+ `# 标题` + `> 副标题` + `## 分区`。完整语法见 README「Markdown 源格式（v2）」，要点：

```markdown
---
task: <任务ID>
pr: <PR 号>
date: YYYY-MM-DD
status: pending
---

# <页面标题 · 日期>

> 范围、基线、已验证证据与未验证边界

## 实现 / 审查结论
<!-- id: implementation -->
<!-- badge: fixed 只读 -->

只读说明是普通段落；表格用 | 语法；命令用 ```围栏（或行内 ```命令```）。

## 人工核验：<主题>
<!-- id: manual-topic -->
<!-- badge: todo 待核查 -->

- [ ] **核对项测试目的**
  （操作）入口 → 具体操作步骤
  （预期）可观察的预期行为
  （说明）补充背景（可选，没有就省略）
  <!-- id: topic-01 -->
```

2. **自查**：`python tools/verification-checklist/build.py --check <文件>.md`（报错带行号，改到 OK）。
3. **生成 HTML**：`build.py --data <文件>.md --output ".artifacts/<task-id>/verification.html"`，浏览器打开，**HTML 不提交**。
4. **入库**：`.checklist.md` 放 `docs/logs/release<版本>/`，与任务台账并排；随任务提交。
5. **贴 PR**：不带 `--meta` 的 `--to-md`（或手工去掉 front-matter）得到评论版；整段贴进 PR 评论——任务项在 GitHub 渲染为原生勾选框，`<!-- id -->` 元数据不可见。reviewer 复制原文存为 `.md` 后 `--data` 即可重新生成交互页。

## 语法红线（--check 会拦，但别先写错）

- 分区标题下必须有 `<!-- id: 分区ID -->`；核对项的 `<!-- id: 核对项ID -->` 放在块尾，缩进两格并独占一行；ID 全页唯一稳定。
- 核对项为 v2 块：`- [ ] **测试目的**` 加缩进两格的（操作）（预期）必填续行与可选（说明），`<!-- id: id -->` 注释放块尾；字段顺序固定；字段内禁止 `**`、`<!--`、换行。
- note 是单行段落；行首是 `-` / `数字.` / `>` / `#` / ``` 时转义（`\-`、`1\.`、`\>`）。
- front-matter：status 必填且为 pending/partial/passed；只允许 task/pr/date/status/updated。
- MD v2 不支持：`text` 块、分区 `open: false`、多行 note、表格单元格换行（这些走 JSON）。

## 核验完成后的状态回写（追踪载体）

维护者核对完（或要求 agent 代为回写）时：把对应项 `- [ ]` 改 `- [x]`，front-matter `status` 更新为 `partial` / `passed`，提交。`python tools/verification-checklist/build.py --scan docs/logs` 汇总所有清单的状态与进度。HTML 页面内也可「导出 Markdown / 复制 Markdown」得到结果快照（格式见 README），但它只含核对项，不替代源清单。

## 旧路径（仍支持，不要新用）

- `--data xxx.json`：JSON 授权数据（契约见 README），MD 出现前的格式。
- `--title/--subtitle/--sections`：手写分区 HTML 的最老路径；既有归档页（如 `docs/verifications/`）在维护者明确要求时才 `--refresh`，分段拼装页刷新后同步重切头尾。

## 改模板本身（而不是某次清单）

- 不要为单次清单改动模板结构；确需改进直接改 `templates/verification-checklist.html`，并同步 README 与本 skill。
- 模板改动后的验证：`node --test tests/test_verification_checklist.mjs`、`uv run --no-sync python scripts/run_tests.py tests/test_verification_checklist.py tests/test_verification_checklist_build.py`、e2e `pnpm exec playwright test tests/e2e/verification-checklist.spec.mjs --project=chromium`。
- 模板脚本用 `content-visibility: auto` 控制长页排版成本；改渲染路径后用压力实例实测连续 resize（单次重排 < 8ms）与滚动。后台 webview 的 rAF / longtask 测量不可靠，用同步强制重排计时。
