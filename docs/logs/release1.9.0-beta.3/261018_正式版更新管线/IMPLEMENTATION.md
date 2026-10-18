# 正式版本更新管线实施记录

基线：`3fa96ed4`。本地开发，未提交、推送、发布或部署。设计见[管线方案](../../../plans/RELEASE_PIPELINE.md)，维护者验收见[核对清单](RELEASE_PIPELINE.checklist.md)。

## 任务进度

| 条目 | 状态 | 决定与证据 |
| --- | --- | --- |
| 正式版归档与 beta 分流 | 已修复 | 仅 stable 新增文档，beta / rc notes 读取 CL；旧 beta 文件迁至 `docs/archived/release-notes/` 保留。正式版 CL / 归档严格校验。 |
| 官网历史列表与详情 | 已修复 | 主导航增加更新记录，静态页面复用归档；实际附件下载、系列基础版本与前后版本导航，支持部署子路径。 |
| 资源与 JSON 出口 | 已修复 | 固定 tag / commit 读取图片，按内容去重；生成页面、图片、索引和正文 JSON 不入库。候选预览不宣告更新。 |
| 发布顺序与官网联动 | 已修复 | 草稿、白名单上传、大小 / 状态核验、公开；正式版显式调用串行 Pages workflow，部署后核对索引和页面。2026-10-18 随 v1.9.0 完成真实发布验证：Windows 门禁 + Linux 一次通过，macOS 因 CI 时序脆弱测试（`test_thumbnail_jobs`，2s cancel 等待）首跑失败、重跑通过后由 publish 幂等补传 5 个附件；官网由 workflow_dispatch + expected_tag 手动恢复部署并通过 verify_release_site。发布中发现 refresh-website 会因传递依赖失败被默认跳过，已在 release.yml 显式判定 `needs.publish.result`。 |
| 历史资料对齐 | 已修复 | 真实 API 返回 48 个发布记录，其中 13 个正式版。CL 缺少的 1.6.1 与 1.2.0 从各自 tag 的 CL 恢复；保留原有 1.0.1 / 1.2.1 记录，不将无对应公开 Release 的归档冒充已发布。 |
| 软件内检测与安装 | 仅说明 | 本次提供稳定 JSON，客户端请求、渲染与更新安装不在此轮实现。 |
| 真实 CI、发布与部署 | 已修复 | 2026-10-18 随 v1.9.0 完成：tag 触发打包与发布（publish_release 草稿→核验→公开）、GitHub Release 5 附件齐全、官网 workflow_dispatch 部署成功且 verify_release_site 线上通过（latest_stable=1.9.0，14 个正式版）。macOS CI 首跑失败的 `test_thumbnail_jobs` 已排查：产品契约是「取消最终会发生」（watcher 50ms 轮询）而无秒级时限保证，测试却硬编码 `cancel.wait(2)`，慢 runner 上线程调度停顿即超时；属测试健壮性问题，非产品 bug（Windows/Linux/本地连跑全绿）。已加固为 10s 宽限 + 自解释失败信息。 |

## 验证证据

自动检查统一通过 `python scripts/run_check.py --timeout N -- <命令>` 执行，原始输出在被忽略的 `.artifacts/checks/`。测试临时目录设置为本工作树 `.artifacts`，未同步共享 venv。

> 2026-10-18 提交前复审补丁：`publish_release.py` 原用 `GET /releases/tags/{tag}` 判断已有 Release，但该端点不返回 draft（GitHub REST 文档明确 "Get a published release"），首次失败遗留草稿后重跑会误判为不存在并再建草稿、后续按 tag 校验 404。已改为分页 `GET /releases`（draft 对 push 权限可见）查找，`--verify-tag` 创建路径不变；新增 `test_existing_draft_rerun_edits_instead_of_creating` 回归。

| 验证层 | 命令 / 操作 | 实际结果 |
| --- | --- | --- |
| Python 规则 | `python scripts/run_tests.py tests/test_release_notes.py tests/test_release_site.py tests/test_release_publication.py tests/test_compact_assertions_usage.py` | 35 项通过；覆盖分流、旧包命名、版本排序、缺包、资源、预览、撤回清理、草稿与部署核验。结果：`.artifacts/checks/20261017T171711Z-e5e4faff/result.json`。 |
| 历史归档 | `python scripts/prepare_release_notes.py --write-all-stable` / `--check-all` | 15 份正式归档；13 个匹配实际公开正式版。其余仅保留资料。 |
| 真实发布事实 | `python scripts/build_release_site.py --facts <本地API快照> --base-path /moys-asr-workflow/` | 成功生成 13 个版本，33 张去重图片；快照取自已连接 GitHub 的只读 API，不入库。 |
| 官网静态检查 | `pnpm --dir website run check` | 0 errors / warnings / hints。 |
| 官网构建 | `pnpm --dir website run build`，设置正式 BASE_PATH | 36 个页面构建通过；没有生成根便携编辑器。 |
| 真实浏览器 | 本地 Playwright 将构建输出拦截映射到测试域名，无常驻服务器 | 列表 13 项，1.6.0 的 13 张图片全部加载；桌面与 390px 移动端截图已检查；无页面错误和窄屏横向溢出。摘要操作区间距 18px，下载列表 gap 8px。 |
| 文档 | `python scripts/check_docs.py` | 通过，已有 6 条旧日志导航缺失提示。 |
| 打包边界 | 查看 MAW.spec 与 AppImage 打包入口 | 共用 spec 仅显式收集运行资源，没有加入发布图文或官网；未实际构建三平台安装包。 |

初次安装官网依赖因沙箱 pnpm 缓存写权限失败；授权环境中按原锁文件安装成功，锁文件未改。初次浏览器检查没有找到沙箱中的浏览器缓存，显式复用本机现有 Playwright 浏览器后成功；没有下载第二份浏览器。官网同步导致的三个无关文档副本变化已恢复，原有 `.vscode/` 未动。

README 同步调整了中英文版本：顶部新增更新记录，开始使用优先正式版，将测试版与版本记录分别说明，不放工程实现细节。2026-10-18 再次只读核对 GitHub，最新测试版为 `v1.9.0-beta.3`，替换旧 beta.2 入口；官网 getting-started 副本一并生成。正式版图文入口需随本轮网站部署后才上线。

随后按维护者要求试改 README 整体结构：直接说明产品用途，前置 API Key 与费用，合并重复功能列表为四项使用价值，注明当前 1.9 beta 的功能范围，补齐 Linux 启动路径，将原有 Star History 收到末尾折叠。保留有明确 1.6.0 标注的现有截图，中英文和官网源副本同步；本地阅读预览放在 `.artifacts/release-pipeline-design/`，不提交。此轮仅改文档，未增加或宣称新的软件能力。

README 预览过程中发现官网同步器把第一个普通折叠区误当作旧演示凭据移除。已将过滤收窄到凭据标题或密钥特征，保留普通帮助与 Star History；新增 `tests/test_readme_content_sync.mjs` 的 5 项回归全部通过，并自动纳入现有 `tests/*.mjs` 测试入口。官网重新构建通过，生成副本不再出现错误的演示凭据提示。新增预览的首次 Playwright 尝试超时，未把它记录为浏览器通过；已停止该次尝试并限定父 PID / 创建时间检查遗留进程。最终预览直接从 Astro 构建结果导出，核对 3 份本地图片 / 样式资源及折叠内容，实际渲染留供维护者查看。此轮文档检查、49 份任务文本规范与差异检查通过。

最终检查通过：Ruff、15 份归档一致性、47 份任务文本的 UTF-8/LF / 空白 / 个人路径检查以及核对清单语法。README 变更后官网 check / build 再次通过，文档回归另有 22 项通过；浏览器再次确认 13 个版本、13 张示例图、18px / 8px 间距和无窄屏溢出，并打开生成的核对 HTML。文档检查仍只有基线中的 6 条导航提示。临时证据位于 `.artifacts/checks/` 和 `.artifacts/release-pipeline-design/`，不提交。

## 尚未验证与下一步

- 需要合入 main 并实际运行 GitHub Actions，确认 reusable workflow 权限、Pages 环境与线上缓存刷新。当前脚本与 workflow 的本地通过不代表这层完成。
- 未来客户端须按 schema 读取、正确比较版本、处理当前平台无安装包及网络失败，渲染正文时清理 HTML；本次不承诺自动安装或签名验证。
- 勘误仍从 CL 开始，再生成归档并同步 GitHub 正文。新图片使用已存在的固定 tag / commit 引用；脚本不移动旧 tag。
