"""MAW 工具箱同款字幕烧录驱动：SRT/ASS/.mosp 工程 → 带硬字幕的 MP4。

复用 maw.postprocess_ffmpeg.run_burn_subtitles，与 Launcher 工具箱「烧录字幕」
共用同一套 SRT→ASS 样式转换、PlayRes 探测、字体名归一化与编码器回退逻辑。

用法（任意工作目录均可，脚本按 maw/__init__.py 向上定位仓库根）:

    uv run --no-sync python .agents/skills/maw-subtitle-pipeline/scripts/burn_driver.py <媒体> <字幕> [encoder]

encoder: auto | cpu | nvenc | amf | qsv（默认 auto；AMD 显卡建议显式 amf，
NVIDIA 建议 nvenc，避免 auto 盲试不存在的硬件编码器）。

输出自动写入媒体同目录 <原名>.压字幕.mp4，重名自动避让；默认 CRF 21、
音频 AAC 192k，保留源媒体全部音轨。成功打印 OK/OUT 行，退出码 0。
"""

import sys
from pathlib import Path


def _repo_root() -> Path:
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "maw" / "__init__.py").is_file():
            return candidate
    raise SystemExit("未找到 MAW 仓库根目录（缺少 maw/__init__.py）；请在 MAW 仓库内运行本脚本。")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip())
        return 2
    root = _repo_root()
    sys.path.insert(0, str(root))
    from maw.ffmpeg import resolve_ffmpeg_tool
    from maw.postprocess_ffmpeg import BurnSubtitleRequest, run_burn_subtitles

    media = Path(sys.argv[1])
    subtitle = Path(sys.argv[2])
    encoder = sys.argv[3] if len(sys.argv) > 3 else "auto"
    ffmpeg_path = resolve_ffmpeg_tool("ffmpeg")
    ffprobe_path = resolve_ffmpeg_tool("ffprobe", configured_path=ffmpeg_path)
    result = run_burn_subtitles(
        BurnSubtitleRequest(media_path=media, subtitle_path=subtitle, video_encoder=encoder),
        ffmpeg_path=ffmpeg_path,
        ffprobe_path=ffprobe_path,
    )
    print(f"OK encoder={result.video_encoder}")
    print(f"OUT {result.media_path}")
    for warning in result.warnings:
        print(f"WARN {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
