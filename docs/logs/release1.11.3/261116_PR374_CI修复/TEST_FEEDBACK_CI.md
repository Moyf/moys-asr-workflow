# PR 374 CI 修复账本

- 请求：修复PR 374最新CI失败，不跳过测试或增加全局重试掩盖。
- 开始基线：本地分支 `fix/test-stability-and-ci-layering@dd7e086f`，工作区干净；远端PR head为 `33a0693a`，需先核对新增提交。
- 状态：待处理、进行中、已修复、仅说明、阻塞。

| 条目 | 问题 | 状态 | 结论 / 验证 |
| --- | --- | --- | --- |
| 1 | Ubuntu browser 1/4三项ASS渲染断言失败 | 已修复 | 修正guard裁切属性、逐层band测量与同静态几何的独立原时钟参考；原hash仍作诊断，3px边界要求不变。Windows完整spec40通过、Python30通过，Linux待新CI验证，不能视为远端已通过。 |
| 2 | Windows browser 3/4的JKL停止位置失败 | 已修复 | 原测试在K之前采样，16倍倒放跨1帧可约267ms；改为等待真实reverse/frame/pending完整停止状态后采样，并跨2个RAF保持0.01s原容差。受控旧逻辑失败、新逻辑通过，漏停负对照正确失败；完整spec5通过，不改产品。 |
| 3 | Complete test matrix required失败 | 仅说明 | 直接job日志确认在gate检查子任务结果处报“missing, failed, cancelled, or unexpectedly skipped matrix job”；正确传递失败分片，不放宽聚合门禁。 |

## 阶段记录

- 已记录反馈；尚未修改测试或产品代码，未提交或推送。
- 已快进至远端PR `33a0693a`，保留六个新增提交；工作区仅本次新账本。失败run `43637727609`结构化报告已下载至 `.artifacts/pr374-ci-43637727609/ubuntu`、`windows`，原始日志不入库。
- JKL验证：`.artifacts/pr374-jkl-261116/checks/20261116T031733Z-d6ce4dfc/result.json` 5通过；旧采样受控失败031614Z-d69eeec8、同间隔修复通过031657Z-7f9210fe、漏停负对照失败031712Z-f89bf896均在同目录。未认定CI是产品暂停失效。
- Ubuntu本机没有可运行的WSL发行版，不安装/绕过该缺口。以CI图像、ASS、fontselect和实际输出证据核对；Linux远端复验需诚实单列。
- ASS最终验证：`.artifacts/pr374-ass-261116/checks/20261116T033453Z-49c5a5f0/result.json` 为完整40项零重试通过；`20261116T033708Z-a3846dbd/result.json` 为Python30通过；旧helper在新增回归上13个断言失败，证据为 `20261116T033444Z-6f83f2c4/result.json`；CI原图复核为 `20261116T033708Z-0a99aaca/result.json`。以上同属该checks目录。
- 实现者以外复验：播放完整spec5通过（`.artifacts/checks/20261116T033641Z-5f0aa4bf/result.json`），独立审查oracle9通过（`.artifacts/checks/20261116T034314Z-ebde1f9a/result.json`），无明确finding，见同目录 `REVIEW_FINDINGS.md`。
- 文档检查通过（`.artifacts/checks/20261116T033925Z-ebd965b0/result.json`），仅提示历史日志导航遗漏；`git diff --check` 通过。此次只改测试与文档，不改产品或生成便携HTML；用户可感知行为未变，不新增CHANGELOG条目。
- 未完成边界：新提交的跨平台Actions、Linux实际像素渲染与完整矩阵待远端运行；不以本地通过冒充CI通过。原有人工清单仍保留在测试治理记录，未自动勾选。
