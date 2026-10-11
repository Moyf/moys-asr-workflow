# 文档导航固定输入

这份合成夹具用于 `scripts/check_docs.py` 的链接回归，包含中文文件名、带空格的目录和文件名、SVG 图片，以及指南中真实存在的 `id="字幕设置"` 锚点。它不包含用户媒体或 MAW 界面截图。

入口是[导航页面](<docs/导航 入口.html>)，导航链为入口 → 字幕指南的「字幕设置」 → 图片资源；指南还提供返回入口的链接。

在仓库根目录运行：

```sh
python scripts/run_check.py --timeout 180 -- python scripts/run_tests.py tests/test_docs_check.py
python scripts/preview_docs_navigation.py
```

回归在 `.artifacts/docs-navigation-tests/` 的临时 Git 副本中执行检查器 `--scan-only --json`，分别断言完整输入退出 0、缺失图片退出 1、错误锚点退出 1，并检查对应的精确诊断。原始夹具保持不变；这里覆盖链接扫描，不代替整个仓库的文档结构检查。

预览脚本把 `docs/` 原样复制到 `.artifacts/docs-navigation-preview/preview-*/`，打印可直接用浏览器打开的 HTML 入口。每次生成使用新的目录，防止旧资源掩盖缺失输入；预览由 Git 忽略，固定输入随代码共享。
