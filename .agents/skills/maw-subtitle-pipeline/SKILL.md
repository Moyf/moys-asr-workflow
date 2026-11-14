---
name: maw-subtitle-pipeline
description: 基于 MAW 的批量字幕流水线：长视频无损切分成多份 → Qwen 云端转写生成 SRT 与 .mosp 工程 → 用公开 CLI --burn 把字幕硬烧进视频（保留全部音轨）。当用户要求"切分/拆分视频""生成字幕""转写""烧录字幕""压字幕""硬字幕""批量出片"，提到 MAW、OBS 录像加字幕、长视频出多份成片，或要求在本仓库运行完整 ASR → 烧录流程时使用。转写与烧录均通过公开 CLI（源码入口 uv run --no-sync python maw_gui.py，或含 --burn 的 MAW.exe 发布包）；本技能以源码环境为准，需要 uv sync 与带 libass 的 FFmpeg。
---

# maw-subtitle-pipeline

一条龙完成「长视频 → 切分 → 转写 → 硬字幕成片」。所有命令都在 **MAW 仓库根目录**执行；`uv` 一律加 `--no-sync`（环境由开发者手动 `uv sync` 维护，避免自动化时解析环境卡死超时）。

## 首次配置（一次性）

1. **依赖**：仓库根目录已 `uv sync`；`ffmpeg` / `ffprobe` 在 PATH（需带 libass，gyan.dev full/essentials 与 BtbN 构建均满足；`ffmpeg -version` 的 configuration 里查 `--enable-libass`）。
2. **ASR Key**：先检查 `<仓库根>/.env` 是否存在（只查存在性，绝不读取或打印内容）。不存在时向用户询问 `DASHSCOPE_API_KEY`（阿里云百炼），把 `DASHSCOPE_API_KEY=<key>` 写入 `.env`（UTF-8、LF，`.env` 已在 .gitignore）。其他供应商见 `docs/user/PROVIDERS.md`。改用环境变量传入也可以，但不要把 key 放进命令行参数。
3. **GPU → 烧录编码器**：`powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name)"` 判断厂商，烧录步骤按映射显式传编码器：
   - AMD → `amf`；NVIDIA → `nvenc`；Intel 核显 → `qsv`；查不到 → `auto`（auto 按 nvenc → qsv → amf → cpu 顺序尝试、失败自动回退，AMD 机器显式指定可省去失败的尝试）。

## 任务目录与防覆盖

- 默认新建任务目录：`<源媒体同名>_full/`；已存在时改用带日期后缀的新目录（如 `<源媒体同名>_full-1103/`），不要在旧任务目录里用不同切点重跑。
- 覆盖行为差异：切分（ffmpeg）与转写（`-o`）会直接覆盖同名文件，只有烧录输出 `<原名>.压字幕.mp4` 自动编号避让。
- 复用已有产物前逐文件向用户确认；切点变了必须全部重新生成——旧 SRT/MOSP 对应的是旧切点，混用会让字幕指到不同画面。
- 断点续跑的前提：目录里的既有产物来自同一次切点，且抽验时长完整，才可跳过已完成的份。

## 流程

### Step 0 探测媒体并做预算

```sh
ffprobe -v error -show_entries format=duration -show_entries stream=codec_type,codec_name,width,height -of default=noprint_wrappers=1 "<媒体>"
```

- 记录：时长（秒）、分辨率、音轨数。
- 预算基准（实测，可据此设超时与告知用户）：转写费用 ≈ **0.00022 元/秒**（Qwen，RTF ≈ 0.02，约 60x 实时，每份几分钟）；4K AMF 烧录 ≈ **0.65x 实时**（30 分钟片段约 20 分钟）；无损切分 ≈ 磁盘读写速度（51 GB 约 7 分钟）。
- 磁盘空间：切分产物 ≈ 源文件大小，烧录产物另计，确认目标盘剩余空间足够。

**音轨核验**（多音轨必做）：OBS 等录像常见 Mix / Voice / OriginSound 之类的分轨，转写基于哪条必须由用户决定：

```sh
ffprobe -v error -select_streams a -show_entries stream=index:stream_tags=language,title -of default=noprint_wrappers=1 "<媒体>"
```

- 单音轨：直接继续，无需询问。
- ==多音轨：先向用户询问转写基于哪条音轨==，按出现顺序列出零基音轨序号与名称，如「音轨 0：Mix」「音轨 1：Voice」「音轨 2：OriginSound」。注意 ffprobe 输出的 `index=1/2/3` 是容器流序号，转写参数用零基音轨序号 0/1/2（一般相差 1，因为开头有一条视频流），两者不要混用；音轨无标签时标注「无标签」，可提示第一轨通常是混音轨。
- 用户选定后：选第 0 条走默认公开 CLI；选其他条时 Step 2 改用模块命令（见 Step 2 的音轨说明）。烧录不受影响——它保留全部音轨。

### Step 1 无损切分

```sh
ffmpeg -hide_banner -loglevel error -n -ss <起点秒> -i "<源媒体>" -map 0 -t <时长秒> -c copy "part<N>.mkv"
```

- 最后一份省略 `-t` 直接到结尾；`-map 0` 保留全部流（含 OBS 多音轨）。
- `-c copy` 切点对齐关键帧：每份开头可能提前数秒、相邻份有几秒重叠。**份内音画字幕始终同步**（转写和烧录都基于同一份文件），无须追求帧精确。
- `-n` 遇到已存在的目标文件会直接报错退出，防止静默覆盖旧片段；确需覆盖时先向用户确认，再对该份单独改用 `-y`。
- 产出目录遵循「任务目录与防覆盖」。

### Step 2 逐份转写（MAW 公开 CLI 的源码入口）

```sh
uv run --no-sync python maw_gui.py -i "<part>.mkv" -o "<part>.srt" "<part>.mosp"
```

- 必须显式给 `-o` 两个路径（SRT + MOSP），自动化不要依赖自动命名。
- 成功判据：退出码 0 + SRT/MOSP 文件真实存在 + 日志有 `MAW_STAT rtf=` 行；只看到进度信息不算成功。
- 音轨按 Step 0 核验结果：默认第 0 条（`0:a:0`，OBS 录像第一轨通常是混音轨）；用户选定其他轨时，改用模块命令并带零基音轨序号：`uv run --no-sync python -m maw.asr.qwen "<part>.mkv" -o "<part>.srt" --json --no-html --audio-track <N>`（`--audio-track` 为零基序号，公开 CLI 无此参数）。
- `-o` 指定的 SRT/MOSP 会直接覆盖已有文件；复用同名产物前先确认（见「任务目录与防覆盖」）。
- 超时建议 ≥ 10 分钟/份；逐份串行执行，不要并发打 API。

### Step 3 逐份烧录（公开 CLI `--burn`）

```sh
uv run --no-sync python maw_gui.py --burn "<part>.srt" -i "<part>.mkv" --encoder <encoder>
```

- `--burn` 接受 SRT/ASS/SSA 或 `.mosp`/`.json` 工程：SRT 与工程按样式库样式转换，PlayRes 取视频实际分辨率，字体名归一化，缺字中止，与工具箱「烧录字幕」同一套转换与编码逻辑。
- 输出自动写入媒体同目录 `<原名>.压字幕.mp4`，重名自动避让，不覆盖任何文件；默认 CRF 21、音频 AAC 192k，保留全部音轨。
- `<encoder>` 传首次配置里确定的值（如 `amf`）；`--encoder` 仅限 `auto|cpu|nvenc|amf|qsv`，显式值不存在于当前 FFmpeg 时报错，此时回退 `auto`。
- 成功判据：退出码 0 +「视频已烧录字幕:」行 + 输出文件真实存在；失败时 stderr 说明原因（含字幕文件缺失、格式不支持）。
- 超时建议：媒体时长 ÷ 0.5（4K CPU 编码更慢，必要时换硬件编码器或告知用户耗时）。

### Step 4 验证（不可省略）

1. `ffprobe` 抽查每份成片：时长与源片段一致、视频 h264、音轨数与源一致。
2. 抽帧目检：从某份的 SRT 里挑一条中间时间戳，`ffmpeg -ss <句中时刻> -i "<成片>" -frames:v 1 -vf scale=1280:-1 check.jpg`，读图确认字幕已烧上、字号边距正常。

## 已知坑位

- `uv run` 不加 `--no-sync` 会重新解析环境，自动化场景表现为「卡死无输出」。
- 不要把 `uv run` 与慢命令串联在同一条链里；本流程全部是一次性前台命令，逐条设大超时即可，不需要常驻进程。
- 大文件操作（切分、烧录）动辄数十分钟：必须显式设置命令超时，并按 Step 0 的基准给用户预期。
- 删除文件（测试产物、中间文件）一律移入回收站，禁止 `rm -rf`。
- `.env` 只存本机 key：不读取、不打印、不提交、不进测试夹具。

## 实战记录（2026-11-03，可作预期参照）

2h06m 4K (3840×2160) OBS 录像 51 GB、3 音轨 → 切 4 等份（约 30.5 分钟/份）→ 共 2134 条字幕 → 4 个 `压字幕.mp4`：切分约 7 分钟，转写每份 2–4 分钟（RTF 0.016–0.021，合计费用约 1.6 元），AMF 4K 烧录每份约 20 分钟，抽帧验证全部通过。
