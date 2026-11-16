# PR 373 合并审阅

审查基线：`2.0dev@e358512e` → `integration/main-to-2dev-20261112@2e2e79be`。维护者授权审阅、小问题直接修复及 Squash & Merge；不包含发布、更新 main 或清理原工作树。

**结论：阻塞，暂不合并。** 两处 P1 数据安全问题及一处 P2 性能问题需要成组修复与回归；本轮仅整理 CHANGELOG 和审查记录，不直接改动实现。

## 范围与设计判断

- 这是冻结 main `961e5949` 到 2.0dev 的整合，不是重新引入旧顶层字幕数据。重点核对 v2 三轨、人物身份与颜色分离、单向绑定赋值、联动拆合、保存保护、ESM 接线及图片导出。
- 另外核对运行环境换源与 Windows 路径安全、OCR 工具发布/锁、Launcher 偏好、Server 本地接口、打包与 CI。没有逐行复核全部历史日志、官网副本、第三方压缩资源或历史便携 HTML。
- 独立审阅分别覆盖说话人/绑定编辑与保存/导出，报告以下三项 finding；主会话核读源码与实际结果，并亲自复跑越界合并的 head/base 对照。本记录不借用作者历史自审冒充本轮审阅。

## 发现与处置

| 等级 | 发现 / 证据 | 处置 |
| --- | --- | --- |
| P1 / 阻塞 | `editor-segment-ops.js:54–55` 把所有重叠至少 500ms 的副字幕收为候选，不排除绑定到未选中主字幕的条目；随后 `148–158` 改身份并清绑定 | 最小合法工程：主轨 A `[0,1000]`、A `[1000,2000]`、B `[2000,3000]`，副轨分别绑定，其中 B 的副轨为 `[1500,3000]`。合并前两条主轨会把 B 的副轨吞入 A，未选中的 B 仍在，但绑定丢失。head 探针真实失败；base 因旧身份守卫拒绝而保留原状。建议明确候选归属，不能只恢复副轨跨人一律拒绝的旧规则 |
| P1 / 阻塞 | `cue-quick-edit.js:145–148,575,584–594` 在气泡被移除时提交，并仅凭当前轨内字幕 ID 找目标；`editor-project-load.js:99–101,142` 先替换工程，再重建波形，没有丢弃旧气泡 | 实际 Chromium 模块探针中，键盘移走焦点后气泡仍在；替换同 ID 的字幕并移除气泡，`PROJECT B` 被旧气泡的 `PROJECT A` 覆盖。独立旧工程导入均可生成 `main-cue-1`。建议使用工程 session generation 保护字幕/字词的提交、导航与延迟回调，并在替换前 discard；完整应用切换入口仍需补 e2e |
| P2 / 待处理 | `editor-sticker-picker.js:207–209` 扩展整组后调用 `speaker-identity.js:19–31`，逐引用、逐绑定重复 `.some()` 扫描 | 真正改色函数的无渲染/历史替身探针：2 万对约 972ms、4 万对约 5237ms；另行计数为 2 万对约 4 亿次 ID 比较。建议一次建立轨道/字幕 ID 索引，避免同步 O(N²) 工作 |
| minor | CHANGELOG 未发布区把人物菜单布局、安装重试内部规则和根因展开成实现说明；同一能力的补修挤在长条目里 | 精简为用户可感知结果；快速编辑与透明图片导出明确列出，保留旧工程必须另存及独立入口退役提醒；已发布正文与 20 份正式归档不改 |
| 接受边界 | 全量 Node 一次出现 `test_launcher_thumbnail_lifecycle.mjs:73` 临时 WAV 清理 `EBUSY`；该测试及 Server owner helper 没有本 PR diff | 定向同文件 2/2 通过；没有更改或跳过测试，也不把该次全量计作通过。文件占用的具体来源未确定 |
| 环境边界 | Python 两项实际 Windows ACL 测试在 `winsecurity.py:124` 被拒绝 | 独立祖先权限探针确认本机用户目录存在 3 条不可信写权限；生产策略按设计拒绝，不降低安全校验或改动本机 ACL。其余通过，12 项 skip 原样报告 |
| 合并语义 | 原分支含冻结 main 的 merge 父提交，但 Squash 不会把该祖先关系带入目标分支 | 本轮未合并；后续按授权 Squash 时应保留冻结点记录，再次同步 main 必须核对已整合内容，不能假设 Git 已记录此次 main 合并祖先 |

## 本轮验证

运行位置为独立审阅工作树，源代码保持 `2e2e79be`；仅 CHANGELOG 与本审阅记录有待提交文档修改。Python 只读复用同锁文件的整合环境，未同步共享环境。Node 为本机 22.23.2，低于仓库声明的 22.23.4 下限；本地结果是补充证据，不冒充合规版本 CI。

下表短 ID 对应本地 `.artifacts/checks/<ID>/result.json`，原始日志与截图不入库。

| 层 | 命令 / 结果 | 证据 ID |
| --- | --- | --- |
| 构建 / 类型 | `node scripts/build-editor.mjs --write`、`node scripts/build-launcher.mjs --write`、`node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json` 均通过 | `20261116T030656Z-45f2f91a`、`20261116T030657Z-84f913fa`、`20261116T030658Z-4307ed9e` |
| 根 Node | `node --test tests/*.mjs`：1648 项，1647 通过、1 失败、0 skip；失败见上表 | `20261116T030723Z-59cd01ed` |
| Node 定向复验 | `node --test tests/test_launcher_thumbnail_lifecycle.mjs`：2/2 通过，不替代全量 | `20261116T030925Z-a9dd441b` |
| Python 全量 | `python scripts/run_tests.py`：3347 项，2 errors、12 skip，其余通过；两项 ACL 失败见上表 | `20261116T030656Z-e0482ce5` |
| ACL 诊断 | 只读调用真实 `_validate` / `_descriptor`，用户目录祖先拒绝与测试一致；没有修改权限 | `20261116T031252Z-5c244709` |
| Chromium 业务 | `editor-feedback-layout.spec.mjs --grep 'main assignment\|main-led\|speaker'`：4/4；覆盖身份标签、主轨权威合并、单向绑定、撤销重做与真实 Server 保存重开 | `20261116T030857Z-e19391db` |
| Chromium 布局 | 同 spec `--grep 'waveform gaps\|row heights'`：2/2；深浅主题、单/多行、低行高与字词码；实测相邻轨距 3px、主轨 outline 2px | `20261116T031047Z-3423cadc` |
| 截图核读 | 已核读九色菜单、身份覆盖提示、深色多行波形和浅色设置面板；截图留在忽略的 `test-results/` | 对应上述两次 Chromium 运行 |
| 文档 / 归档 | `python scripts/check_docs.py` 通过（6 条既有日志导航警告）；`python scripts/prepare_release_notes.py --check-all`：20 份通过；工具文档新鲜度通过 | `20261116T030857Z-562a4af4`、`20261116T031210Z-39d085ec`、`20261116T030859Z-327ef16e` |
| 空白 / 脱敏 | `git diff --check`、`python scripts/check_personal_paths.py --diff-ref origin/2.0dev` 通过 | `20261116T031210Z-1e3d58ed`、`20261116T031210Z-6685c9e3` |
| 远端代码 head | `2e2e79be` 的 Ruff、双平台 Debug tooling、Editor、Windows 预览打包、selection 与 CLA 全绿 | Actions `43442993489`、`43442993555`、`43442993548` |
| 独立定向 | 保存/导出相关 JS 49/49；说话人相关 JS 20/20。独立审阅者部分组合因其进程未配置依赖路径而未执行，不当成产品失败；主会话完整环境的结果单列如上 | `20261116T030624Z-019f862a`；说话人审阅回报 |
| 越界合并反证 | 实际 merge 函数 + 真正 v2 校验器；head 合并误吞副轨，断言失败；base 拒绝且保持绑定。主会话独立复跑同样结果 | `20261116T031509Z-5d84de4d`、`20261116T031509Z-332f74bc` |
| 跨工程气泡 | 实际 Chromium + 真实 popup 模块；焦点转移后气泡保留、DOM 移除触发旧文字覆盖 | `20261116T031309Z-6c2d8107`；ID 碰撞 `20261116T031203Z-3fe957b4` |
| 改色性能 | 真实改色函数，渲染/历史使用替身；无计数器耗时与有计数器的复杂度验证分开 | `20261116T031318Z-41d3ea7b`、`20261116T031222Z-e90786c6` |

## 未验证边界

真实剪辑软件导入、云 ASR、真实模型安装、长媒体连续播放和完整跨平台人工验收未在本轮执行。2.0 不重生成旧独立 HTML，不发布安装包。原工作区未提交内容保持不动。

## 下一步

先明确并修复联动合并的候选归属与快捷编辑的工程会话隔离，再补真实应用回归：未选中主轨及其绑定不变、字幕/字词气泡切工程不串写、撤销重做与磁盘保存重开。性能项补大工程复杂度守门。三项处置后重新审阅，当前不得 Squash & Merge。
