# AGENTS.md

## 项目目标

`moys-asr-workflow`（简称 **MAW**）是一个刻意收窄的、可公开分发的 Qwen ASR API 工作流：

```text
本地媒体 -> Qwen API -> SRT + JSON 工程 -> 本地浏览器编辑 -> 导出
```

它不是完整的 ASR 平台。不要在没有明确需求时引入本地模型、其他识别引擎、剪辑软件脚本、比较工具或任何个人工作流资产。未来完整产品是 MOSE，见 `docs/MOSE.md`。

## 先读这些文件

```text
README.md                     # 新用户的安装和最短路径
docs/WORKFLOW.md              # 全流程、参数、排错
JSON_SCHEMA.md                # JSON 工程契约
generate_subtitle_qwen_api.py # API 转写入口
edit.py + waveform.py         # 单文件编辑器生成和波形缓存
server-editor/serve.py        # 推荐的 localhost 编辑器
web/                          # 所有前端源码
```

`web/` 是唯一前端源码。`edit.py` 将它内联为便携 `.edit.html`，`server-editor` 则在每次请求时从它渲染页面。因此，修改 `web/` 或模板后必须运行：

```powershell
uv run python edit.py --blank
```

不要手改 `blank-editor.html` 内联副本。所有文本文件必须保持 UTF-8 与 LF（`\n`）换行，包括 Windows 上编辑的 `.py`、`.js`、`.html`、`.md`、`.yml`、`.ps1` 等文件；禁止提交 CRLF（`\r\n`）。不要依赖开发者机器的 `core.autocrlf`，以仓库 `.gitattributes` 的 `eol=lf` 规则为准。

## 开发与验证

```powershell
uv sync
node --check web\editor.js
node --check web\waveform.js
node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs
uv run python -m unittest discover -s tests -p "test_*.py"
git diff --check
```

自动化测试覆盖数据处理和服务器契约，不能替代真实浏览器中的拖动、播放、Seek 和布局体验。涉及编辑器交互的改动，应至少手动启动：

```powershell
uv run python server-editor\serve.py --blank
```

## 代码与安全约束

- `.env` 只存本机 Key；绝不读取、打印、提交或放进测试夹具。
- 不加入媒体、识别结果、波形 sidecar、截图或个人绝对路径。
- 本地服务器必须只监听 `127.0.0.1`；不可改成任意本地文件浏览或任意路径写入接口。
- JSON 的 `segments[*].start/end/items[*].start/end` 都是整数毫秒。修改 schema 必须同步更新 `JSON_SCHEMA.md`、测试与 changelog。
- `waveform` 是可重建缓存，不能变成工程唯一真源；`segments` 才是字幕真源。
- 删除文件时移入回收站，绝不使用 `rm -rf`。

## 发布检查

发布前确认：版本号、`CHANGELOG.md`、README 命令和 `blank-editor.html` 相互一致；运行上述测试；扫描 `.env`、媒体与个人路径；确认 `LICENSE`、`THIRD_PARTY_NOTICES.md` 仍正确。不要创建远端、推送、打 tag 或 GitHub Release，除非维护者明确要求。

## 上游关系

MAW 从一开始就是独立项目。需要引入外部代码时，逐项审查、补测试并更新文档；不要整目录覆盖或带入开发者机器上的配置、缓存与辅助工具。
