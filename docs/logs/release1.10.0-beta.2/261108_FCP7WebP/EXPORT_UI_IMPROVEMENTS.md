# FCP 7 XML 导出弹窗改进

以 PR 353 最新提交 `41bced05` 为基线整合。保留该版本经维护者纠正的 PNG 默认、WebP 可选及 FFmpeg 无 Pillow 渲染；未覆盖此前工作。

| 条目 | 状态 | 处理 |
| --- | --- | --- |
| 图片生成进度 | 已修复 | 显示任务百分比对应的进度条，其他状态隐藏 |
| 名称、描述和按钮 | 已修复 | 菜单统一为 FCP 7 XML；图片模式按钮为导出 XML + 图片 |
| 范围、时间线、帧率与字幕轨 | 已修复 | 范围和时间线改为单选，帧率与字幕轨并排 |
| 图片尺寸及动态字幕宽高 | 已修复 | 图片预设与自定义尺寸传入渲染，修复动态字幕自定义行的隐藏样式 |
| 选择图片 XML 保存路径 | 阻塞 | 尚未实现；图片模式仍在工程旁生成独立目录。浏览器文件句柄不提供绝对路径，需后续设计安全的多文件保存及目标软件可用的引用 |
| 新增：导出形式与字幕轨默认值 | 已修复 | 「字幕形式」改为「导出形式」，顺序为 FCP7XML 工程（默认）、WebP、PNG；「全部字幕轨」默认选中且不再因缺少副轨/叠加轨被禁用 |
| 新增：弹窗顺序与标题 | 已修复 | 「输出范围」移到「导出时间线模式」下方；窗口标题固定为「FCP 7 XML 工程和字幕导出」 |
| 新增：结果与布局 | 已修复 | 状态文字回到 12px；成功行绿色文案 + 「点击打开导出文件夹」，由服务端一次性任务接口打开本次发布目录，不接收前端任意路径；时间线与帧率区增加间距 |
| 新增：OGraf / Lottie 导出弹窗 | 已修复 | 字幕轨与帧率并排、时间线改单选，默认仍为原始时间线，导出语义不变 |

## 验证

- Chromium：`tests/e2e/fcp7-png.spec.mjs` 与 `tests/e2e/fcp7-export.spec.mjs` 共 17 项通过，包含 PNG/WebP 文件头尺寸、原生文字、取消、进度显示、自定义尺寸、英文及间距；结果 `.artifacts/checks/20261108T080047Z-eb92b715/result.json`。前一轮新增进度用例错误地对 progress 元素调用 toHaveValue 而失败（16 通过、1 失败，`20261108T075754Z-0177d42f`）；改用读取 progress.value 后整组复跑通过。
- Node：`tests/test_fcp7_png.mjs tests/test_fcp7_png_client.mjs` 12 项通过；结果 `.artifacts/checks/20261108T075223Z-7c57c872/result.json`。
- Python：`scripts/run_tests.py tests.test_fcp7_png tests.test_fcp7_png_api tests.test_packaging_contract` 62 项通过；结果 `.artifacts/checks/20261108T075223Z-e7f052a9/result.json`。
- `pnpm run check:editor` 和 `pnpm run typecheck` 通过；Node 22.16.0 低于仓库推荐版本，命令有警告。FCP 7 与 Lottie、OGraf 截图已自查，列间距及自定义行距实测至少 8px。
- 尺寸与进度新增客户端用例在基线 `41bced05` 上真实失败（5 通过、1 失败，`.artifacts/checks/20261108T080009Z-7ae41c98/result.json`），当前源码通过。
- 这次未运行完整套件、重新构建发行包或在 Premiere / VEGAS 实测新尺寸与 WebP；既有三端打包与目标软件证据不自动扩展到本次变更。内联副本待发布前统一重生成。

## 第二轮 UI 调整的验证

- Chromium `fcp7-png.spec.mjs` / `fcp7-export.spec.mjs`：原生默认、全部字幕轨、结果行、自定义尺寸、PNG/WebP 真实文件头尺寸等全组运行，仅新增间距断言取错元素导致 2 项失败，修正定位后相关用例通过（`20261108T083527Z-2de47bc6`）；全组首轮 15 通过 / 2 失败见 `20261108T083338Z-17a1fa67`。
- Python `tests.test_fcp7_png_api` 10 项通过，含新增「只有已发布任务能打开自己的目录、忽略前端传入路径、无 token 拒绝」用例（`20261108T083537Z-0a64243a`）。
- `pnpm run build:editor`、`pnpm run typecheck` 通过；Node 22.16.0 低于仓库推荐版本。
- 未验证：真实点击打开文件夹（会启动系统文件管理器，需人工在 Windows/macOS/Linux 各点一次）；OGraf/Lottie 弹窗只做了静态与布局检查，未跑真实导出；目标剪辑软件导入仍未测。
