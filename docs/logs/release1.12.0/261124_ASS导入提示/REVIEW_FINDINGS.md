# ASS/SSA 导入提示独立盲审

基线为 `fix/ass-import-feedback` @ `c9602cc0`，对应 `origin/main`，工程版本为 1.12.0。修复尚未提交。

## 发现与处置

- **P3，已补回归。** `web/editor/media/editor-wiring-media-inputs.js:40` 将 JSON/MOSP 选择限制在副轨。盲审发现初版 Chromium spec 覆盖了副轨接受，但跳过了主轨拒绝。同一审查员在 Node VM 用真实处理函数、后缀谓词与 i18n 字典对照，基线 6/12、修复 12/12，其中主轨拒绝 `a.JSON`、`a.mosp`，副轨接受。现已在 `tests/e2e/subtitle-import-format.spec.mjs:52` 的主轨字幕和歌词矩阵补上两种后缀。
- 审查员通读全部代码和新增 spec，`git diff HEAD --check`、`node --check` 和编辑器 bundle 新鲜度检查通过，未发现产品缺陷或阻塞项。

## 验证

- 最终浏览器用例在基线上为 3 例选择器断言失败、1 例拖放通过。恢复修复并重建后，4 例字幕选择器与拖放回归、14 例编辑器菜单与焦点回归全部通过，共 18 例。
- 复用了与 1.12.0 调查相同的合法 ASS 单事件样本。通过 ffprobe 确认 1–2 秒时间区间，实际 localhost 编辑器三个选择器均显示 ASS/SSA 格式说明。原名拖放仍显示格式不支持，SRT 正常导入。
- Node 编辑器脚本语法、装配顺序和工具单测 375 例通过，TypeScript 检查和 bundle 新鲜度检查通过。
- 选择器通过 Chromium 自动化交付文件，系统原生「所有文件」对话框、非 Chromium 浏览器、发布安装包和 Launcher 完整烧录未实测。独立版内联副本待发布前统一重生成。完整本地输出保留在 `.artifacts/ass-import-checks/`。
