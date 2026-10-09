# 本机编辑器 Server

Server 从 `web/` 渲染 MAWE，并提供媒体 Range 请求、受限工程保存与本机设置。只监听 `127.0.0.1`。日常编辑操作见 [编辑器指南](../docs/EDITOR_GUIDE.md)，打包应用的服务管理见 [CLI](../docs/CLI.md)。

## 源码启动

在仓库根目录完成 `uv sync` 后：

```sh
# 工程与关联媒体
uv run --no-sync python server-editor/serve.py "project.mosp"

# 覆盖已失效的媒体引用；表情包目录可选
uv run --no-sync python server-editor/serve.py "project.mosp" -m "video.mp4" -s "stickers"

# 不带工程时恢复上次明确打开的工程
uv run --no-sync python server-editor/serve.py

# 本次强制空白启动
uv run --no-sync python server-editor/serve.py --blank

# 指定端口且不打开浏览器
uv run --no-sync python server-editor/serve.py "project.mosp" --port 8250 --no-open
```

源码入口省略端口时从 8250 起寻找空闲端口，终端打印实际地址；显式端口被占用会报错，`--port 0` 由系统分配。公开 `MAW.exe --server` 的端口规则不同，不支持 0。

启动后先提供准备页面，再加载工程、媒体和波形；出错时保留具体原因。终端 Ctrl+C 停止。

## 媒体与工程接管

Server 根据工程 `media` 引用或 `-m` 加载媒体。有效的同目录媒体保存为相对引用；目录外媒体或显式覆盖仍可记录绝对路径。媒体移动时重新指定，服务不扫描任意目录。

空白页面中拖入工程时，浏览器拿不到真实文件路径。Server 只能根据工程的绝对媒体引用定位同目录同名工程，并验证内容一致后接管；相对引用、媒体已移动或文件不一致会回退到浏览器导入，需要选择媒体并导出保存。

浏览器「新建工程」使用文件句柄保存，不经过 Server，不进入 Server 最近列表；取消对话框不改变当前工程。新建成功解除旧 Server 绑定，防止写错文件。

## 保存与设置

Server 绑定的工程可以原子保存，覆盖前保留 `<文件名>.mosp.bak` 或 `.json.bak`。另存为只接受当前目录内的 `.mosp` / `.json` 文件名，拒绝路径、盘符与上级目录。

浏览器授权文件句柄与下载式保存的区别、自动保存及多版本 `.mosp-bak` 恢复，统一见 [编辑器保存说明](../docs/EDITOR_GUIDE.md#5-保存另存为与备份)。无媒体或仅 SRT 的工程也可保存，不会因此扫描同名媒体。

最近 10 个明确打开的工程、恢复开关、工作区库及引导状态在 MAW 用户数据目录的 `server-editor-settings.json`：

| 系统 | 默认目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/MAW` |
| macOS | `~/Library/Application Support/MAW` |
| Linux | `$XDG_DATA_HOME/MAW`，缺省 `~/.local/share/MAW` |

损坏或失效的最近记录会提示并回到空白页面，不扫描目录。`--blank` 优先于恢复设置。Windows 旧设置路径只在新文件不存在时读取，保存始终写新路径。

浏览器偏好仍可能按 localhost 端口隔离；Server 引导状态、命名工作区及 ASS 样式库使用用户级文件。数据边界见 [开发概览](../docs/DEVELOPMENT.md)。

## 前端维护

修改编辑器 JavaScript、清单或构建配置后，先运行 `pnpm run build:editor` 再刷新页面；持续调试可另开 `pnpm run watch:editor`。提交前运行 `pnpm run check:editor`，并提交对应 bundle 与 `.meta.json`。CSS 和模板修改仍只需刷新。`web/editor-scripts.txt` 是装配顺序真源；Server 与便携页面读取同一份构建产物，最终用户不需要 Node。

日常不要重生成 `blank-editor.html`；只有发布检查或维护者明确要求更新便携产物时，才运行 `uv run --no-sync python edit.py --blank`。服务不提供任意本地文件浏览或任意路径写入接口。
