# 子代理调查报告：Launcher 打开编辑器后画面带（视频缩略图）整体缺失（#6.2）

只读子代理调查（2026-10-15），主会话抽查核对后并入账本。file:line 以核对时 HEAD `1d961b90` 为准。
（主会话核对：`open_mawe` 确无静态引用；`thumbnailHeight/wrapThumbnailRow` 收缩逻辑、
`start_server` 已运行复用分支见正文引用行号。）

## 1. 前端按钮与 bridge API

- 按钮元素是 `#openMawe`：`web/launcher/index.html:510`（`data-i18n="start_server_editor"`）。
  注意 `open_mawe`（`web/launcher/i18n/launcher-strings.js:118/278`）在全部 js/py/html/json 中
  只有定义处和 bundle 内的字串表，**没有任何静态引用，是孤儿 key**；实际生效的文案 key 是
  `start_server_editor` / `open_editor`，由 `renderServerButton()` 动态切换
  （`web/launcher/forms/launcher-form-sync.js:29-38`）。
- 点击接线：`$("openMawe").addEventListener("click", openServerEditor)` —
  `web/launcher/boot/launcher-wiring.js:14`。
- `openServerEditor()`（`web/launcher/boot/launcher-settings-startup.js:64-110`）流程：
  1. 读 `$("jsonPath")`（拖入工程后由 `setJsonPath` 填入，`web/launcher/forms/launcher-media-form.js:120`）；
  2. **已运行短路**：`state.serverRunning && projectPath === state.serverProjectPath`，
     或 `detectedServerUrl && !projectPath` → 直接 `bridge("open_url")` 打开旧 URL，不重启
     （launcher-settings-startup.js:70）；
  3. 否则 `refreshServerMedia()` → `bridge("check_server_media", {jsonPath})`
     （`web/launcher/server/launcher-media-server.js:118`），无媒体时报 `server_media_missing` 并中止
     （launcher-settings-startup.js:76-82）；
  4. `bridge("start_server", serverPayload())`，payload = `{jsonPath, mediaPath: $("serverMediaPath"),
     port: $("port")||"8250", guiLang}`（`launcher-form-sync.js:28`）；
  5. 成功后 `bridge("open_url", {url: result.url})`（launcher-settings-startup.js:100）。
- bridge 即 pywebview `window.MAWLauncher.callBackend` → `LauncherApi`
  （`web/launcher/boot/launcher-notify-backend.js:290`）。

## 2. maw/gui_web.py 的 start_server 实现

- `LauncherApi.start_server`：`maw/gui_web.py:2091-2166`。
  - **已运行复用**（关键）：只要端口上有任何 HTTP 服务响应（`_probe_server` 接受 200–499，
    `gui_web.py:4598-4621`），且该进程不是本实例启动的（`owned_server_running`），
    就**直接返回 `serverAlreadyRunning: True` 并打开根 URL，不带任何工程信息**
    （gui_web.py:2097-2104）。健康探测路径是 `/api/startup-status`（gui_web.py:158）。
  - 工程分支：`check_server_media` 校验（gui_web.py:2112, 2117-2118），然后
    `build_serve_command(json_path, media_path, port)`（gui_web.py:2119）。**只有用户在「编辑器媒体」
    字段手动填了 `serverMediaPath` 才传 `-m`**（gui_web.py:2113-2116；本例未填）。
  - 附加参数仅 `--no-open`（gui_web.py:2120）。**不传任何 FFmpeg 配置**——`build_serve_command`
    （`maw/gui_workflow.py:428-449`）只有 `[exe, serve.py] <json> [-m media] --port N`
    （冻结包则 `MAW.exe --serve`，gui_workflow.py:436-439）。serve 子进程自己用 env/.env/捆绑/PATH
    解析 FFmpeg（`server-editor/serve.py:649-652`、`maw/ffmpeg.py:167-254`）；GUI 的 FFmpeg 设置
    保存在 .env 的 `FFMPEG_PATH`（gui_web.py:3099），serve 侧读同一文件（serve.py:651）。
  - 启动方式：`popen_process_tree(..., env=_independent_app_child_environment(),
    cwd=str(self.paths.root))`（gui_web.py:2124-2132）；子进程 env 会把解析到的 ffmpeg/ffprobe
    目录前置进 PATH（gui_workflow.py:691-706）。
- **与批量转写自动打开的差别：没有。** 批量 done 事件只是填 jsonPath + 加 attention 标记
  （`web/launcher/boot/launcher-notify-backend.js:272-285`），仍由用户点同一个按钮；
  工具箱「生成波形工程后打开」也是 `setJsonPath → window.MAWLauncher.openServerEditor()`
  （`web/launcher/postprocess.js:1440-1443`），殊途同归到 `start_server`。真正不同的链路是
  「用便携编辑器打开」`open_html`/`open_blank_html`（gui_web.py:3071/3076）——那是 edit.py
  静态 HTML，本就无画面带（提示「从本机 Server 加载视频后可用」，thumbnails.js:70）。

## 3. serve.py 的加载与绑定

- 媒体解析：`load_project` 在 `server-editor/serve.py:784-828`。JSON 无 `media` 字段且无 `-m` 时
  **提前返回 `source_media_path=None`，不做同主名兜底**（serve.py:786-802）；有字段则
  `resolve_project_media`（serve.py:804；实现 `maw/media.py:616-668`，裸文件名相对路径只按
  **工程所在目录**解析，media.py:480-484、573-587）。失败抛 `MediaResolutionError`（serve.py:805-806），
  整个工程加载失败。
- **HEVC 不会触发转码**：`CONVERSION_NEEDED` 仅 `.flv`（media.py:556-557；
  `convert_media_for_browser` 对其他后缀原样返回，media.py:410-411），serve.py:811-817 只对该状态转码。
  绑定用源媒体 `source_media_path`（serve.py:808-809）。
- 绑定：`EditorServer.__init__` 用**空白工程**起步并
  `thumbnail_jobs.bind(project.source_media_path or project.media_path, ...)`（serve.py:1184-1185）；
  deferred 加载完成后 `_bind_project_locked` 重新 bind 并递增 generation（serve.py:1220-1229）。
  `bind(None)` → `state="unavailable"`，有路径 → `"idle"`（`maw/thumbnail_jobs.py:324-337`）。
- **拿不到媒体的情形**：bind 得到 None（工程/`-m` 都没解析出媒体）；或 worker 首步 `probe_video`
  失败/异常 → `state="unavailable"`（无视频流，thumbnail_jobs.py:604-612）或 `state="error"`
  （任何异常，含 ffprobe 不可用 `raise ThumbnailError("ffprobe is unavailable")`、探测失败、
  缓存/协调 DB 异常；thumbnail_jobs.py:570-582、`maw/thumbnails.py:76-86`）。
- 实测落地（只读运行 `resolve_project_media`）：`仙术杯开场.qwen-audio.mosp` 的 media 字段是
  裸文件名 `"仙术杯开场.mp4"`（相对 `_maw/` 解析不存在，`_maw/` 里也没有同名媒体）→ **MISSING**；
  `仙术杯开场.qwen-audio.后处理.回填.mosp` 的 media 是绝对路径 → **SUCCESS**。前者在两条链路
  都打不开编辑器（Launcher 报 server_media_missing / serve.py 直接加载失败），所以用户拖入的
  应是回填工程，两链路解析结果一致。

## 4. 前端「画面带区域整体不出现」的条件

- 区域高度由 `thumbnailHeight() = visible ? 48 : 0` 决定（`web/editor/media/waveform/thumbnails.js:89`）；
  `wrapThumbnailRow` 在高度为 0 时**不创建 canvas 外壳**（thumbnails.js:93-94）——这就是「连区域都没有」。
- `visible = active() = !closed && enabled && available && !!binding`（`web/editor/media/editor-thumbnails.js:132`）。四个条件：
  1. **binding 为空**：来自 `MaweBoot.SERVER_CONFIG.thumbnailBinding`（thumbnails.js:41）；
     server 页面恒下发非空值（serve.py:1068、1231-1236），仅便携 HTML 没有
     （→ 显示「从本机 Server 加载视频后可用」）。
  2. **enabled=false**：localStorage `mawe-filmstrip-visible === 'false'`（editor-thumbnails.js:77、326-335；
     开关 `#waveform-show-thumbnails`，thumbnails.js:32-37）。**per-origin**：Launcher 固定用 GUI 端口
     （默认 8250），而直接 `serve.py` 不带 `--port` 时会自动跳过占用端口（serve.py:3260-3274）——
     两次测试可能落在不同 origin。
  3. **available=false**：首次 status 轮询返回 `state ∈ {unavailable, error, cancelled}`
     （editor-thumbnails.js:236-239）→ 区域收缩为 0。即第 3 节的 `bind(None)` / `probe_video` 失败 /
     worker 异常。状态文案会出现在 `#waveform-thumbnail-status` 与开关 tooltip（thumbnails.js:44-83）：
     `unavailable`→「当前媒体没有可用画面」，`error`→「画面缓存暂不可用」。
  4. **closed**：页面卸载，不相关。
- 注意「网络失败」不消失区域：连续 3 次失败进入 `network-error` 只停止取图，
  `active()` 不含 `networkSuspended`（editor-thumbnails.js:104-113、132），画面带保留。
  所以「区域整个没有」只能落在 1/2/3。

## 5. 综合判断（候选原因，按可能性排序）

前提事实：工程与波形正常显示 ⇒ 页面 reload 后拿到了完整工程与**新鲜 binding**
（延迟加载完成后 `window.location.reload()`，`web/editor/io/editor-server-connection.js:167-173`）
⇒ binding 为空的候选基本排除；媒体解析（回填工程）两链路一致；HEVC 转码与绑定无关（仅 flv）。
剩余解释：

1. **（最可能）缩略图 worker 在 Launcher 启动的 serve 子进程里进入 `error`/`unavailable`**
   → `available=false` → 区域整体不渲染。serve 代码两条链路相同，差异只能来自子进程运行环境/时序：
   如子进程内 ffprobe 解析失败（`maw/thumbnails.py:78-80`）、探测异常（:84-86）、
   或与 Launcher 仍在跑的 `build_base` 后台任务发生跨进程协调/缓存竞争异常
   （`maw/thumbnail_jobs.py:575-582` 把一切异常吞成 `state="error"`；协调器
   `maw/thumbnail_jobs.py:30-80`、media_cache 构建入口 `maw/media_cache.py:276-291`）。
   **验证入口**：编辑器里看波形设置的「视频缩略图」开关 tooltip / `#waveform-thumbnail-status` 文案，
   或直接 `GET /api/thumbnails?binding=<页面里的值>` 看 `state`/`error` 字段。
2. **（次可能）「打开编辑器」根本没启动新 server，而是复用了端口上的旧实例**：
   `start_server` 的 already-running 分支对任何响应 200–499 的服务都放行且不带工程参数
   （gui_web.py:2097-2104；探测不校验是否 MAW 进程，`_maw_server_process_id` 只用于状态报告
   gui_web.py:4686-4698）。用户先前手动起的 serve.py 实例、上次 GUI 会话遗留的 serve 子进程都算。
   旧实例若处于 startup-error 或其缩略图 worker 已 error，就会出现
   「工程显示（自动打开上次工程恢复）但画面带没了」的组合。
   **验证**：任务管理器 / `netstat -ano | findstr 8250` 看是否有第二个 serve 进程；
   Launcher 日志里是否有「服务器已在运行」文案（launcher-server-monitor.js:7）。
3. **（需排除的显示开关）`mawe-filmstrip-visible` 在该 origin 的 localStorage 为 'false'**
   （editor-thumbnails.js:77）：两链路 origin 可能不同（serve.py 自动跳端口 vs Launcher 固定端口），
   直接测试正常不代表 Launcher 那个 origin 开着。开关若关着，状态行显示「视频画面已隐藏」
   （thumbnails.js:71-72）。一眼可查。

**已排除**：HEVC 触发 `convert_media_for_browser`（仅 flv，media.py:556-557/410-411，绑定用源媒体
serve.py:808）；媒体路径未传入（`-m` 缺省时由工程 media 字段解析，回填工程为绝对路径、两链路一致；
裸文件名的 `仙术杯开场.qwen-audio.mosp` 在两条链路都无法打开编辑器，只会报 `server_media_missing` /
加载失败，不会出现「打开了但没画面带」）；serve 启动参数缺 FFmpeg 配置（本来就不经命令行传递，
env/.env/捆绑/PATH 解析，gui_workflow.py:691-706、serve.py:649-652）。

**顺带发现的潜在问题**（与本 bug 弱相关但值得记录）：
- `check_server_media` 把「请求路径不存在」也算 `hasMedia=True`（gui_web.py:2339，
  `bool(requested or resolved or candidates)`），与 serve.py 的解析口径不一致；
- serve.py 对空 media 字段的提前返回（serve.py:786-802）没有 check_server_media 的同主名兜底，
  两处口径今后可能产生「Launcher 认为有媒体、Server 认为没有」或反向的错配。
