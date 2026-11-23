# 编辑器原生选址：提交前独立审查

独立审查与负对照使用 `main` 的 `045667a5` 快照；提交前快进到最新 `origin/main` `2e6852d4`（#440）。Draft 仅供评估；尚未决定是否合入 main，2.0 可能弃用 Launcher 桥接。

| 等级 | 发现与证据 | 处理 |
| --- | --- | --- |
| Major | `editor-server-save.js` 在途表情包设置可在丢弃判定后才变脏；`serve.py::set_sticker_root` 可在旧工程扫描后误更新新绑定。独立 Node/Python 探针分别得到 `confirms=0, dirtyAtReload=true` 和新工程使用旧目录。 | 前端锁定新输入、等待在途设置后再判定脏状态；Server 扫描前、发布前都检查绑定。HTTP 回归修复前得 200，修复后旧操作得 409；JS 用例验证异步修改会触发确认。 |
| Major | `serve.py::commit_native_project` 只检查工程版本。媒体在准备后移走时，旧逻辑仍返回 200 并切到无媒体的工程。 | 提交前复查源媒体及实际播放文件；HTTP 回归修复后得 409，并确认未切换和未写最近记录。 |
| Minor | `editor-wiring-ass-storage.js` 独立离开保护可能在 native bind 已成功后拦下刷新；独立探针复现两个监听器判断不一致。 | 绑定前等待并保存样式库，失败时留在当前工程。JS 用例验证失败不发绑定请求。 |
| Minor | `editor-wiring-project-inputs.js` 只检查连接 Promise 是否存在；独立探针中恢复请求 403 后仍走已失效的原生入口。 | 记下恢复结果；已判定失效的会话保留浏览器选择。若点击时验证尚未结束，错误提示后下一次点击可回退。 |
| Minor | `editor-sticker-root.js` 的手填规范化会改写合法 POSIX 路径的反斜杠与末尾空白，独立 JS 探针可复现。 | 原生选择、已保存目录保留精确路径；手工输入继续沿用原规则。 |
| 验证 | `tests/test_editor_assets.py` 的旧静态断言要求直接访问 `SERVER_CONFIG.stickerRootUrl`，解构重构后实测失败。 | 更新契约断言，仍覆盖既有 Server 验证及绑定标识，并覆盖仅 Launcher 原生入口。 |

## 复证

- 在隔离的 `045667a5` 快照运行 `open-project-native.spec.mjs`：原生打开请求未出现，表情包文件夹按钮不存在，两项预期失败。当前分支的 Chromium 正向回归包含这两项。
- `scripts/run_tests.py tests/test_native_project_open.py`：8 项通过；媒体移走和旧绑定扫描两项回归在修复前实测失败（均误返回 200）。
- `node --test tests/test_project_switch_intent.mjs` 覆盖等待设置并保护未保存修改，以及 ASS 样式保存失败时不切换；两项新增用例在隔离的审查前源码上失败，修复后全过。
- 维护者本机试用反馈无问题。自动化以模拟 Launcher 代替实际系统弹窗；macOS / Linux 的系统选择器未实测。未重新生成便携 HTML 内联副本。

## 转正式审查前的补充

- 按烧录选址提示的行为，原生打开工程（含重定位媒体）及表情包目录选择，在请求期间持续显示 Toast；选择完成、取消或请求失败时收起。
- 仅在已有表情包引用且更换当前生效目录时确认。取消不发应用请求，关闭覆盖被取消时恢复勾选；确认变更也不删除原引用。
- Chromium 定向回归 5 项通过，18 项 JavaScript、36 项 Python 测试通过；相同三个新增或扩展的浏览器用例在修复前的 `df6d6d46` 快照上均失败（两处缺等待提示、一处未触发确认）。
- 独立复核未发现 blocker / major。接受的 nit：手填同一目录的不同路径写法（如末尾 `/.`）可能多弹一次确认；独立 Node 探针验证同路径原样重用不提示、等效写法会提示。取消仍无变更，确认后由 Server 按原有规则解析目录。
