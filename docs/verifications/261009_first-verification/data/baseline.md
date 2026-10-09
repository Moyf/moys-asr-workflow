# 当前 HEAD（9b7e62b8）自动化基线 — 2026-10-09 实测

| 命令 | 结果 |
|---|---|
| `pnpm run check:editor` | 通过（Editor bundle is fresh） |
| `git diff --check` | 仅 docs/TEST_FEEDBACK_PR180.md 报 leftover conflict marker（工作区 AA 未合并文件，另一任务 WIP；已提交内容干净） |
| `ls package-lock.json` | 不存在（#186 迁移完整） |
| packageManager 固定 | package.json / website/package.json 各 1 处（pnpm@11.28.4） |

全量 Python / Node / e2e 未在本次生成清单时重跑（各 PR 提交信息已自述结果），
留给发布前统一验证；清单中如实标注。
