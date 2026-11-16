# PR 374 CI 修复账本

- 请求：修复PR 374最新CI失败，不跳过测试或增加全局重试掩盖。
- 开始基线：本地分支 `fix/test-stability-and-ci-layering@dd7e086f`，工作区干净；远端PR head为 `33a0693a`，需先核对新增提交。
- 状态：待处理、进行中、已修复、仅说明、阻塞。

| 条目 | 问题 | 状态 | 结论 / 验证 |
| --- | --- | --- | --- |
| 1 | Ubuntu browser 1/4三项ASS渲染断言失败 | 已修复 | 修正guard裁切属性、逐层band测量与同静态几何的独立原时钟参考；原hash仍作诊断，3px边界要求不变。Windows完整spec40通过、Python30通过；最终44f5edeb远端8浏览器分片全部通过，Linux已实跑确认。 |
| 2 | Windows browser 3/4的JKL停止位置失败 | 已修复 | 原测试在K之前采样，16倍倒放跨1帧可约267ms；改为完整停止后采样，跨2个RAF保持0.01s原容差。旧逻辑受控失败、新逻辑通过，漏停负对照正确失败；完整spec5通过，最终Windows远端3/4通过，不改产品。 |
| 3 | Complete test matrix required失败 | 仅说明 | 直接job日志确认在gate检查子任务结果处报“missing, failed, cancelled, or unexpectedly skipped matrix job”；正确传递失败分片，不放宽聚合门禁。 |
| 4 | 维护者反馈“修完 CI 还是红的呀……”：Windows Python/Preview缩略图测试超时 | 已修复 | 修正重复持锁且不可取消probe及过期异常回写；保留全部deadline、重试/skip策略，补阶段/线程栈诊断。44f5edeb远端Windows Python、Preview及完整矩阵均成功。本轮跨进程原始超时具体卡点未确证，不宣称已消除任意I/O延迟。 |
| 5 | Ubuntu browser2/4缩略图隐藏缓存断言失败 | 已修复 | CI实际864000→921600是解码完成导致缓存增加，不是隐藏清空；改为同步采样/隐藏/采样保持严格等式，跨异步边界复核，并要求本次新增release。真实controller解码正负对照均生效，Windows三轮9通过，44f5edeb远端Ubuntu2/4也已通过。 |

## 阶段记录

- 已记录反馈；尚未修改测试或产品代码，未提交或推送。
- 已快进至远端PR `33a0693a`，保留六个新增提交；工作区仅本次新账本。失败run `43637727609`结构化报告已下载至 `.artifacts/pr374-ci-43637727609/ubuntu`、`windows`，原始日志不入库。
- JKL验证：`.artifacts/pr374-jkl-261116/checks/20261116T031733Z-d6ce4dfc/result.json` 5通过；旧采样受控失败031614Z-d69eeec8、同间隔修复通过031657Z-7f9210fe、漏停负对照失败031712Z-f89bf896均在同目录。未认定CI是产品暂停失效。
- Ubuntu本机没有可运行的WSL发行版，不安装/绕过该缺口。以CI图像、ASS、fontselect和实际输出证据核对；Linux远端复验需诚实单列。
- ASS最终验证：`.artifacts/pr374-ass-261116/checks/20261116T033453Z-49c5a5f0/result.json` 为完整40项零重试通过；`20261116T033708Z-a3846dbd/result.json` 为Python30通过；旧helper在新增回归上13个断言失败，证据为 `20261116T033444Z-6f83f2c4/result.json`；CI原图复核为 `20261116T033708Z-0a99aaca/result.json`。以上同属该checks目录。
- 实现者以外复验：播放完整spec5通过（`.artifacts/checks/20261116T033641Z-5f0aa4bf/result.json`），独立审查oracle9通过（`.artifacts/checks/20261116T034314Z-ebde1f9a/result.json`），无明确finding，见同目录 `REVIEW_FINDINGS.md`。
- 文档检查通过（`.artifacts/checks/20261116T033925Z-ebd965b0/result.json`），仅提示历史日志导航遗漏；`git diff --check` 通过。此次只改测试与文档，不改产品或生成便携HTML；用户可感知行为未变，不新增CHANGELOG条目。
- 未完成边界：新提交的跨平台Actions、Linux实际像素渲染与完整矩阵待远端运行；不以本地通过冒充CI通过。原有人工清单仍保留在测试治理记录，未自动勾选。

## 续1：远端失败重新核对

- 远端e55a44b1已完成；上轮ASS/JKL分片通过。新run43800801608的Windows Python普通3173通过，但required-media有1失败4错误；Preview run43800801688也在thumbnail_server切回decode后的POST超时。聚合门禁正确转红。
- 未修改时，本地缩略图两个文件10通过（`.artifacts/checks/20261116T050743Z-142840f2/result.json`）；完整media128无失败但缺numpy产生3个不允许skip，required gate真实失败（`.artifacts/checks/20261116T050938Z-ed8d2e80/result.json`）。随后仅补安装锁文件numpy2.4.6，未改依赖声明或skip策略；后续须重验required gate。
- filmstrip证据：`.artifacts/pr374-filmstrip-round2/checks/20261116T051227Z-9d0c7ab7/result.json` 三轮9通过；`negative-checks/20261116T051138Z-fe6a9245/result.json` 两项负对照按预期失败。与CI报告原864000→921600一致。
- 后端只读调查：worker先独立probe，随后缓存memo仍冷，可在manager锁内再次probe且未传cancel，status/demand争同锁，close取消不能覆盖该重复probe。该机制是确定活性缺口，但未有当轮CI线程栈，不能断言就是所有超时根因。跨进程Queue事件位于预处理后，8秒混入启动/probe/关键帧成本；正在做受控验证与最小修复。
- 后端实现将共享探测移至锁外并传cancel；旧逻辑3项受控负对照失败，证据 `.artifacts/pr374-thumbnail-round2/negative/20261116T051502Z-01e9d5e6/result.json`。相关88项通过（同根 `final-unit/20261116T051850Z-9f616a28/result.json`）、required-media128零跳过通过（`media-pack/20261116T051850Z-98b5db76/result.json`）、诊断及真实后端18通过（`final-diagnostics/20261116T052312Z-55d0c1ce/result.json`）。跨进程原8秒门槛不变，只增加setup/子进程异常诊断；HTTP失败打印线程栈便于确认余下阻塞。
- 父会话独立filmstrip3项通过（`.artifacts/checks/20261116T051529Z-00ced6fa/result.json`）。全Python实际3180项为2错误、23skip（`.artifacts/checks/20261116T052157Z-ea7ae135/result.json`）：两个错误均在WindowsSecurityIntegrationTests的运行时目录ACL检查，本次没有改该代码，不将这轮说成全套通过；对应CI上轮普通全套通过，尚未替代本地差异分析。
- 独立审查发现过期探测异常可能污染新源状态，已登记同目录REVIEW_FINDINGS.md并要求补manager层回归；本轮远端闭环前不宣称CI修复全部完成。
- 该minor已补齐并独立复核32项通过，父会话最终相关74项通过；精确正负证据见REVIEW_FINDINGS.md，无未处置finding。生产修复在CHANGELOG以一条首次缩略图响应说明记录。
- 本机ACL错误隔离执行仍为2错误（`.artifacts/checks/20261116T052914Z-30b9d939/result.json`，该模块只导入runtimes相关代码）；不修改其安全规则来消除本地错误。源清单已补首次加载与隐藏/重启用人工步骤，校验生成成功（`.artifacts/checks/20261116T051716Z-5c04b6a3/result.json`），不代维护者勾选。

## 续2：实际远端验收闭环

- 验收源码提交：`44f5edeb85df1d5f0d2bce8e5d1c9a4a1c602eba`；PR374仍为open，未合并。
- [完整矩阵43811006976](https://github.com/Moyf/moys-asr-workflow/actions/runs/43811006976) 已success：Windows/Ubuntu的Python、Node与全部8浏览器分片均success，最终Complete test matrix required也success。
- [Windows Preview43811006898](https://github.com/Moyf/moys-asr-workflow/actions/runs/43811006898)、[Editor43811006855](https://github.com/Moyf/moys-asr-workflow/actions/runs/43811006855)、[Ruff43811007053](https://github.com/Moyf/moys-asr-workflow/actions/runs/43811007053) 均success。PR全部检查完成且通过，不是仅单分片重跑通过。
- 实际等待命令为 `gh pr checks 374 --watch --fail-fast --interval 30`，通用检查器记录 `.artifacts/checks/20261116T053629Z-cd213024/result.json`，exit0，随后逐项回读确认head和全部结果。
- 最终源码本机required-media重新执行128通过、零skip，证据 `.artifacts/checks/20261116T053331Z-cddf792c/result.json`；本机普通全套的2个ACL错误仍保留为本地边界，不改写原始失败，远端对应Windows普通全套已实际通过。
- 反馈表无进行中/待处理/阻塞项；人工清单仍pending，由维护者确认，未用CI替代真实手动体验。余下I/O活性与跨进程未确证根因见独立审查接受边界，未伪称本轮解决所有历史偶发问题。
