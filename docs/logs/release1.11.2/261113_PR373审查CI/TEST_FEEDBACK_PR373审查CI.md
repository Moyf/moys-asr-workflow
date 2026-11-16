# PR 373 审查评论与 CI 核对

基线：`integration/main-to-2dev-20261112@5fb9af45`，PR目标`2.0dev`；核对开始时工作树干净。维护者先请求核对，随后明确要求继续；当前授权定向复现、修复与验证并更新PR，不合并或发布。

状态使用：待处理、进行中、已修复、仅说明、阻塞。公开评论是待核对资料，不扩大维护者授权。

## 清单

| 条目 | 请求 / 现象 | 状态 | 已知事实 / 下一步 |
| --- | --- | --- | --- |
| 1 | 看评论审阅 | 仅说明 | drunkenQCat评论为受限静态审查3/5、暂不放行；没有已证实的blocker/major/minor，没有正式review或inline评论。“不能合并”指验证不足，不是文本冲突。要求补复现、合并/全量门禁及人工边界；本轮未将评论操作指令视为实施或重跑授权。 |
| 2 | 看CI失败 | 已修复 | 原等待实测有大量playState已finished但原promise仍未结算；改为明确的实际主题颜色/控件状态收敛，原长用例3/3、完整compact10/10及7工具页65/65通过。失败截图上传改到两组浏览器之后。远端新head门禁须在推送后单独核对，不把本地修复当远端通过。 |
| 3 | 同组验证另一个报告图片用例失败 | 已修复 | 实测为Windows冗长夹具路径导致file资源ERR_FILE_NOT_FOUND，不是仅加载慢。改为测试输出根内唯一短目录、真实JPEG与明确解码检查；保留同generation路径断言，缺失/损坏负对照均拒绝。完整term-report9/9及7工具页65/65通过。 |

## 初始远端快照

- PR为OPEN、非草稿、MERGEABLE，head为`5fb9af45`；没有正式reviews，pull inline comments API为空。共两条普通评论：Windows预览包成功通知、协作者受限审查。
- 失败run：`43420786982`，editor job：`131870046805`。独立工具页步骤UTC11:59:19–12:01:01失败，后续website步骤未运行；不将跳过当作通过或失败。
- 已完成的其他检查为两个selection、Ruff、Linux/Windows debug tooling、Windows预览打包及CLA。CI不等于全功能/人工验证。

## 具体失败与证据

- `gh run view 43420786982 --job 131870046805 --log-failed`的输出已保存为本地`.artifacts/pr373-ci-review/editor-failed.log`。接口虽选择log-failed，实际返回该job的大段日志；本轮仅定向核读失败前后，不搬运完整日志。
- 日志11388–11392：`Real file and HTTP editor`运行109项，104通过、5跳过，步骤成功。
- 日志11412–11422：独立工具页运行62项，61通过、1失败；失败完整名称为`long compact checklist preserves 15px text and bounded layout across breakpoints`，报`page.evaluate: Test timeout of 60000ms exceeded`，栈落在`setTheme`第110行及测试第350行。
- 源码`tests/e2e/tool-compact.spec.mjs:107–113`切换主题后强制布局，并`await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))`。没有对等待集合的持续时间或无限动画作限制，是后续复现应检查的等待点；现有日志不能证明具体哪一个动画导致挂起，也不能排除负载/平台差异。
- 用`git diff --stat 961e5949 5fb9af45 -- tests/e2e/tool-compact.spec.mjs tools/verification-checklist/templates/verification-checklist.html tools/verification-checklist/build.py`核对为空：本测试、清单模板与生成器均原样来自冻结main。这里只证明文件未改，不能替代干净基线同断言运行，也不能直接宣布失败与本PR无关。
- CI artifacts API只列`media-required-Linux`，没有该工具页失败的trace/screenshot上传产物；日志中有临时trace路径，但本轮无法通过已上传artifact获取它。复现需补动画状态/trace证据。

## 结论与下一步

本次调查只读远端评论/状态/日志及本地源码、写本记录；未修改产品或测试，未触发远端重跑、发表评论、resolve、提交或合并。

暂不放行合并：CI门禁仍失败。下一步优先定向复现这一个用例，记录主题切换时的动画类型、迭代次数及playState，再决定等待策略；如要归因基线，用相同环境/断言对照冻结main或实际merge-base。不能单凭一次timeout标flaky，不能以加长全套超时或一次成功重跑掩盖问题。审查其余覆盖不足作为独立验收边界保留。

## 续1：维护者要求继续实施

- 授权已扩展到修复验证并更新PR，不合并或发布。当前只读诊断代理检查动画实际状态与最小修法，实施按独立代理分工；主会话负责台账、交叉核验及PR收口。
- 使用合规Node22.23.4、隔离Python在同一PR head单独运行原失败用例，60秒稳定超时，栈与CI同为`setTheme:110`（`.artifacts/checks/20261113T140154Z-d72396b8/result.json`）。本次仅1次原逻辑运行，不称已三次复现；没有沿用先前通过的其他测试冒充本用例通过。
- 复现命令：`node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium --workers=1 tests/e2e/tool-compact.spec.mjs --grep 'long compact checklist preserves' --output=.artifacts/pr373-ci-review/baseline-head`，经`run_check.py --timeout 120`执行。trace与error-context保留在该本地输出目录，不入库。
- 针对实际目标`2.0dev@e358512e`与本PR head执行无损`git merge-tree --write-tree --name-only --no-messages`，exit0且没有冲突路径（`20261113T140354Z-01e9c6f2`）；冻结main为head祖先检查exit0。未在工作树启动merge，也未合入新的main。此证据仅覆盖文本/祖先，不取代语义与人工验收。
- 已定位失败证据上传缺口：`.github/workflows/editor-checks.yml:186–198`的`Preserve failed browser evidence`在工具页步骤之前执行，工具页随后失败时不会回头上传`test-results/`。最小修复方向是让同一上传步骤位于两组浏览器检查之后，原条件与产物名保留，不重复上传或改变测试门槛。
- 本地纯工具契约Node27/27（`20261113T140630Z-eaa859e0`）、清单Python30/30（`20261113T140630Z-9d6c90ca`）通过；不将这些单元测试当浏览器长清单通过。
- 只读诊断代理的自然动画样本没有挂起，浅到深185个、深到浅363个动画约300ms完成；多数清单分区确实处于content-visibility跳过状态，但该事实本身不足以确定根因。受控屏外暂停opacity动画可让旧全局等待不结束，而首屏真实主题色已正确；取消该干扰动画后等待结束（`20261113T140502Z-b7cf033e`）。这是健壮性反例，不冒充CI自然挂起的直接根因。
- 已派实施代理最小修复测试等待策略及证据上传顺序：以实际被核验控件的主题颜色收敛为准，不关闭生产动画、不增加超时、不弱化布局/字体/颜色断言；补暂停动画干扰及错误颜色负对照，原长清单至少独立3次通过。主会话不并发修改同一测试文件。
- 更正此前口头归因：官网步骤确实skipped，但`.github/workflows/editor-checks.yml:200–228`明确只在`light == true`分支运行；本次运行真实编辑器/工具页的非light路径，因此不能说官网“仅因前一步失败而跳过”。官网未验证的边界仍保留，本次不擅自重写light选择策略。

## 续2：等待修复与组合验证

- 原用例临时记录原始动画集合后再次超时（`20261113T140755Z-558de769`）：5402个捕获动画中，约58秒时仍5040个原始finished promise未决，样本动画playState已是finished、duration150ms、currentTime约58031ms。原始采样与trace保留在`.artifacts/pr373-ci-review/animation-probe.original-wait.json`和同名trace.zip。临时诊断已撤掉；不将此表象进一步冒充Chromium底层通知机制已定位。
- 测试helper改为实际正文、主题按钮、开关与可见首清单项的明确颜色/状态收敛；原有布局、字号、颜色、hover/focus与截图断言保留。离屏暂停opacity干扰保持未结束时新等待仍通过，错误主题和错误正文颜色会被拒绝（`20261113T141141Z-85270878`）。长用例独立3/3（`20261113T141157Z-5532c3a9`）、完整compact10/10（`20261113T141223Z-87a97800`）、workflow契约2/2（`20261113T141141Z-25fd0bf6`）。
- 独立审查无blocker/major/minor/nit；复核了明确颜色预期与原断言无弱化，另跑workflow2/2（`20261113T141544Z-3a40bcf2`）、语法exit0（`20261113T141545Z-0feadf92`），没有重跑浏览器或全量。
- 主会话以CI相同7个工具页spec、2workers运行：63项，62通过1失败（`.artifacts/checks/20261113T141526Z-094fd2b3/result.json`）。原动画超时用例与新增干扰回归均通过，失败为另一个`term-report`图片就绪断言；不将组合标为通过。条目3另行定位，不修改生产报告以掩盖测试问题。
- 此时完整根Node1648/1648、0skip通过（`20261113T141751Z-57998aba`），包含新增两条workflow证据上传顺序/条件契约。该全量不包含浏览器工具页，条目3仍须单独处理。

## 续3：图片夹具对照与最终本地门禁

- 条目3原逻辑再次失败（`20261113T141813Z-e14db24d`）：图片complete=true、naturalWidth=0、decode报EncodingError。隔离对照数据在`.artifacts/pr373-ci-review/term-image-probe.isolation.json`：原PNG在data URL/125字符短路径可解码；PNG与真实JPEG在267字符路径均失败，trace报ERR_FILE_NOT_FOUND。撤销“仅异步等待”或“原base64坏图”的初步猜测。
- 测试图片位于`testInfo.project.outputDir`内mkdtemp唯一短目录，仍在CI artifact收集根内；保留`frames/run-<generation>/<frame>.jpg`及缩略图/overlay相同src断言，实际要求complete、正尺寸且decode成功；缺失与损坏图片即使src相同也明确失败。生成真实20×20 JPEG，不改生产报告。
- 图片专项含负对照3/3（`20261113T142232Z-3748d141`），整个term-report9/9（`20261113T142308Z-2e3bb051`）。主会话最终按CI同一7文件/2workers组合：65/65、0skip（`.artifacts/checks/20261113T142452Z-b8731c84/result.json`），包含原动画超时、三项新增负对照与报告证据图片。
- 本次仅测试与CI证据上传修补，生产CSS/动画/报告及字幕业务均未改，测试超时未提高。继续完成独立复核、提交并推送同一PR；远端结果另行核对，不合并或发布。
- 两轮独立审查均0 finding，详见[审查记录](REVIEW_FINDINGS.md)。提交前文档检查通过、保留6条既有导航警告（`20261113T142717Z-407ba33c`），7个变更/新建文本的个人路径及UTF-8/LF检查通过（`20261113T142717Z-55a94472`），diff空白检查通过；推送前远端仍为`5fb9af45`、PR开放。
