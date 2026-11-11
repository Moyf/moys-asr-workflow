# 1.11.2 发布前独立复核

基线：`main@5fb70d88` + 本任务未提交修改；日期：2026-11-11。

## 审查状态

独立审查完成：无 blocker / major / 实现缺陷；1 条 minor 测试覆盖缺口已补齐，1 条 nit 日志入口已同步。审查者未参与业务实施，按源码、定向生成物契约及实际测试结果核对。

## Findings 与处置

| 级别 | 证据 | 处置 |
| --- | --- | --- |
| minor | `tests/e2e/ass-export.spec.mjs:37–47` 原 reset 用例只改时长，未先开启开关，因此不能直接守住取消保留 true / 确认关闭 true。独立函数探针 `20261111T071959Z-11e78cd7/result.json` 证明实现正确。 | 已补先勾选 fad/pop、取消后仍勾选、确认后两项 false 的浏览器断言；复验结果写到账本。 |
| nit | 审查时 `docs/logs/INDEX.md` 只链接账本，新清单漏登；`20261111T071819Z-4f92ed7c/result.json` 的一条 warning 来自新清单。 | 主会话已补索引入口与复核入口；更正说明，不把本次缺入口当既有 warning。 |

## 独立核验

- Python 样式/notes 38 项、Node 默认/显式开关/标记 4 项通过：`.artifacts/checks/20261111T071657Z-2fd33c79/result.json`、`20261111T071657Z-5930b7d2/result.json`。
- 全部 20 份正式归档与版本同步通过：`20261111T071714Z-4ccaac66/result.json`、`20261111T071714Z-0ad3b84a/result.json`。
- editor / launcher bundle 新鲜度通过：`20261111T071714Z-cf8cd3c8/result.json`、`20261111T071714Z-58b900ab/result.json`。
- 只读契约探针 `20261111T071855Z-7ea8ad71/result.json`：内联 HTML 与当前渲染器内存输出完全一致，版本 1.11.2、两默认 false；发布正文包含基础正文恰好一次；1.11.0 的 7 张配图 HTTP HEAD 均 200 + image MIME，使用固定 v1.11.0 引用；UTF-8 无 BOM 与 LF 通过。
- 历史 tag 前后端与 GitHub Release API `20261111T071925Z-320837ef/result.json` 再次确认首次发布 v1.8.0-beta.1，2026-10-02。
- diff 与个人路径通过：`20261111T071819Z-6837d4d3/result.json`、`20261111T071910Z-d966321a/result.json`。
- 独立内联探针最初两次因错误要求原 bundle 原样包含于 HTML 而失败，忽略渲染器占位符替换；改为完整渲染内存对比后通过。这是审查探针错误，不是产物缺陷。
- 实施者补齐 findings 后独立审查者再次只读抽查：两条均闭环，无新增阻断；全量 Python 148 文件/3087 项和 ASS 导出整组 21 项实际报告已核对。

## 已知边界

- 用户保存过的 true 不自动迁移为 false，避免覆盖主动选择；这是维护者已告知的边界，默认修复只影响新默认或主动重置。
- 新补丁必填 release-base 由发布约定保证，不追溯要求历史无 base 的归档改写。
- 前端源码已重建 bundle，发布内联副本已统一重生成；无布局改动，ASS 表单截图自查完成。
- 旧红新绿：新增 Python / Node 默认回归真实失败并在修复后通过；浏览器 reset 与默认 ASS 导出旧逻辑 2 失败，修复后 2 通过，相关记录见账本。
- 首次全量 Python 串行超时后换受支持的按文件并行 runner，3087 项、31 skips、0 fail/error；未验证被跳过的边界，不把 skips 记为通过。ASS export 整份 spec 21 项通过，三轨目标用例 1 项通过；不代表全量 e2e。
- 本地不等于真实 CI 构建与安装包实机验收；正式发布及官网同步单独核对。

## 发布后证据

Release CI `42979113086` 三端构建与 Publish 均成功；公开 stable/latest、5 个附件大小/状态/HTTP HEAD 200、正文与生成预览一致已核对：`.artifacts/checks/20261111T073154Z-a7978610/result.json`。首次官网步骤失败但产物正确，单次独立重试 `42980521714` 后通过；本地索引/notes/详情复验 `.artifacts/checks/20261111T073600Z-ebba0af4/result.json` 通过。没有撤回安装包或修改 tag，未确证首次未生效的根因。真实 Release 浏览器验证两段标题、5 个下载入口及 7 张正文图片成功。人工安装与成片验收仍待维护者。
