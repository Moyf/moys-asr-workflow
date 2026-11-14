# ASS 实时预览字体回退修复

## 范围与结果

分支 `fix/ass-preview-system-font-fallback`，基线 `ee2fe595`。
字体别名仍优先匹配；别名之后恢复 `--font-sans` 的原有系统字体顺序。
Canvas 使用展开后的具体字体族，DOM 字号探针使用同一回退链。
不新增全局字体设置，不改变 ASS 导出或 FFmpeg/libass 烧录。

## 独立审查

- P2，已修复：Canvas 无字体边界度量时的 DOM 探针仍使用 generic sans-serif，与绘制不一致。现向探针传相同 fallback，并新增真实别名模块 + DOM 探针测试。
- 复审：36 项 Canvas / layout / alias 测试通过，无未处理 blocker / major。
- 接受的验证边界：未做 Windows / macOS 实机字形对照；恢复的是候选字体顺序，不保证不同机器逐像素一致。实际字体取决于安装情况及字形覆盖。

## 验证

所有测试使用 `python scripts/run_check.py --timeout 180 -- <命令>` 执行。

- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_ass_canvas_raster.mjs tests/test_ass_canvas_layout.mjs tests/test_ass_font_aliases.mjs`：408/408 通过；跨语言测试通过 `MAW_TEST_PYTHON` 指向已安装 Python。
- `node scripts/build-editor.mjs --write`、`--check`：通过。
- `node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json`：通过。
- 双向回归：仅恢复基线 Canvas / alias 源码，新测试 2 项按预期失败（别名后系统回退及缓存刷新），恢复修复后通过。DOM 探针新增回归另行验证。
- 初次跨语言测试因默认 uv 缓存目录不可写失败；指定已安装 Python 后整组通过，不是产品断言回归。
- Chromium 独立 Canvas 冒烟未执行成功：环境禁止浏览器进程创建 socket，放宽沙箱重试仍失败。没有把单测模拟 Canvas 作为真实浏览器通过。
- 内联副本待发布前统一重生成。
