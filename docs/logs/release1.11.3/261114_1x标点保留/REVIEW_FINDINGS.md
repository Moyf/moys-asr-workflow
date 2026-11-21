# 独立审查

基线 main `ee2fe595`，独立审查覆盖启动与全部默认值回移、配置兼容、测试及 HTML 产物契约。

结论：无 blocker / major。

- Minor：false 场景可能未验证磁盘标记；已补保存后 undefined/false 精确断言并通过浏览器回归。
- Minor：CLI 指南仍称默认删除；已更新为默认保留及显式覆盖规则。
- Minor：CHANGELOG 应说明默认值与旧配置；已补充。
- #239 的 editor-split-core clone/id 更改不是标点修复，不携带。
- 显式清理函数保留，已有 preservePunctuation 和 splitTrimSymbols 不自动覆写。
- 单 HTML 验证只是生成产物静态契约，未冒充 file:// 浏览器全交互验证。

## 验证边界

全量 Node 单元尝试：1129 pass / 43 fail。失败包含沙箱 Chromium 启动、python ENOENT、缓存访问、bundle/fixture 等环境或装配问题；没有完成基线复跑，因此不将全部失败断言为既有问题。专项 383 + 12 项通过。完整套件并非全绿。

修正解释器、生成 bundle 并解除浏览器沙箱限制后，全量 Node 重跑为 1155 pass / 17 fail。剩余 17 项均位于 `test_editor_bundle.mjs` 与 `test_web_build_artifact.mjs` 的临时构建 fixture。独立原 main 工作树生成相同 bundle 后运行这两个文件，也为 19 pass / 同名 17 fail，确认本环境的基线同样失败。未在此标点 PR 修改构建 fixture；完整套件仍不宣称全绿。

## Windows CI 后续修正

首次 Windows 打包 CI 的全 Python 3146 项只有一项失败（22 skip）：`test_core_default_call_preserves_cli_pipeline_compatibility` 仍断言默认删除文稿句号。默认保留句号是此 PR 的既定用户行为，取消操作 API 的向后兼容不要求保留旧默认删除行为，因此修正测试而非回退实现。

更新默认调用断言，并分别覆盖有/无逐字时间码；新增显式旧保留清单 `（？、！）` 仍删句号的测试，避免只放宽预期。修改前本地同一断言失败；修改后相关四个文件 108 项通过。独立审查无 blocker/major，审查者单独运行取消操作测试 10 项通过。Ruff 通过。生产代码没有变更。
