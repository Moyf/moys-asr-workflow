"""MAWE（Moy's ASR Workflow Editor）HTML 生成器（基于带字级时间戳的工程文件）+ 表情包管理。

用法:
    uv run python edit.py <subtitle.mosp|subtitle.json> [-m media] [-s stickers_dir] [-o output.html]

示例:
    uv run python edit.py "subtitle-project.mosp" -m "video.mp4"

工程文件由 generate_subtitle_qwen_api.py --json 生成，内容是 UTF-8 JSON，默认扩展名为 `.mosp`，包含每条字幕的字级 timestamps。

页面功能（HTML 单文件）:
- 嵌入媒体播放器，单击字幕跳转
- 基础波形 / 多行波形，可拖动字幕块与边缘直接调整时间
- 双击进入编辑（光标落在鼠标点击位置；Esc 取消，Enter/Ctrl+Enter 之一保存，另一个拆分）
- 右键菜单：拆分 / 分配表情包 / 合并字幕（多选）/ 拓展表情包时间（多选）
- 顶部搜索框过滤 + 高亮
- 批量替换（被替换的行自动标 dirty）
- 字数标签（>阈值红色高亮）
- 媒体窗口叠加字幕预览（可开关）
- 多选（Shift 范围选 / Ctrl 切换选）
- 表情包：左侧缩略图、点击查看全尺寸、可删除/替换
- 下载 SRT / `.mosp` 工程 / Resolve JSON / OTIO 工程
- 空格快捷键播放/暂停
"""

import argparse
import html
import json
import os
import re
from pathlib import Path
from typing import TypedDict

from maw.project import ProjectValidationFailed, normalize_project
from maw.media import AUDIO_EXTENSIONS, VIDEO_EXTENSIONS
from waveform import (
    DEFAULT_PEAKS_PER_SECOND,
    WaveformError,
    load_or_extract_waveform,
)

import reapeaks

VIDEO_EXTS = set(VIDEO_EXTENSIONS)
AUDIO_EXTS = set(AUDIO_EXTENSIONS)
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
# Keep this aligned with pyproject.toml; release workflows synchronize it.
BUNDLED_EDITOR_VERSION = "1.4.0-beta.3"


class Sticker(TypedDict):
    name: str
    filename: str
    rel: str


def get_app_version() -> str:
    """Read the project version, falling back to the packaged editor version."""
    pyproject = Path(__file__).resolve().parent / "pyproject.toml"
    try:
        text = pyproject.read_text(encoding="utf-8")
    except OSError:
        return BUNDLED_EDITOR_VERSION
    match = re.search(r'(?m)^version = "([^"]+)"\r?$', text)
    return match.group(1) if match else BUNDLED_EDITOR_VERSION


def media_tag(media_path: Path, media_url: str) -> str:
    ext = media_path.suffix.lower()
    if ext in VIDEO_EXTS:
        return (
            f'<video id="player" preload="metadata" '
            f'style="width:100%;max-height:40vh;background:#000;display:block;">'
            f'<source src="{html.escape(media_url)}"></video>'
        )
    return (
        f'<audio id="player" preload="metadata" '
        f'style="width:100%;display:block;">'
        f'<source src="{html.escape(media_url)}"></audio>'
    )


def load_env() -> dict[str, str]:
    """读取脚本同目录下的 .env 文件，返回 key=value 字典。

    零依赖实现（不引入 python-dotenv）。仅做简单 KEY=VALUE 解析，
    忽略空行和 # 注释行。调用方若需系统环境变量优先，请用 os.getenv 覆盖。
    文件不存在时返回空字典。
    """
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return {}
    result: dict[str, str] = {}
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        result[k.strip()] = v.strip()
    return result


def get_default_sticker_dir() -> str | None:
    """获取默认表情包目录。

    优先级：系统环境变量 STICKER_DIR > .env 文件里的 STICKER_DIR。
    未配置时返回 None。
    """
    env = load_env()
    return os.getenv("STICKER_DIR") or env.get("STICKER_DIR") or None


def scan_stickers(dir_path: Path, max_depth: int = 3, max_items: int = 500) -> tuple[str, list[Sticker]]:
    """扫描表情包目录（递归子目录）。

    返回 (root_abs, items)：
      - root_abs: 文件夹的绝对路径（POSIX 风格，便于拼 file URL），无尾斜杠
      - items: [{name, filename, rel}]：
        * rel      相对 root 的 POSIX 路径，可含子目录（如 "大狗/xxx.png"）
        * name     带子目录层级的 stem（如 "大狗/xxx"），跨子目录唯一
        * filename 原始文件名（不含目录，向下兼容老逻辑）
      - max_depth: 相对 root 的最大子目录层级（0=仅顶层，1=允许一层子目录，...）
      - max_items: 最多收集的图片数，防止异常大目录拖慢扫描

    前端 stickerUrl/stickerAbsPath 用 STICKER_ROOT + rel 拼 URL，天然兼容嵌套 rel。
    """
    if not dir_path or not dir_path.exists() or not dir_path.is_dir():
        return ("", [])
    root_abs = dir_path.resolve()
    items: list[Sticker] = []
    for p in sorted(root_abs.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix.lower() not in IMAGE_EXTS:
            continue
        rel_path = p.relative_to(root_abs)
        depth = len(rel_path.parts) - 1  # 相对路径中的目录层数
        if depth > max_depth:
            continue
        rel = rel_path.as_posix()  # 含子目录的相对路径
        name = rel_path.with_suffix("").as_posix()  # 如 "大狗/xxx"，跨子目录唯一
        items.append({"name": name, "filename": p.name, "rel": rel})
        if len(items) >= max_items:
            break
    return (root_abs.as_posix(), items)


WEB_DIR = Path(__file__).parent / "web"
EDITOR_SCRIPT_MANIFEST = "editor-scripts.txt"


def ninja_sfx_base_url(output_path: Path) -> str:
    """Return a URL from a generated page to the source tree's slash sounds."""
    source_dir = (WEB_DIR / "sfx").resolve()
    output_dir = output_path.parent.resolve()
    try:
        relative = os.path.relpath(source_dir, output_dir)
    except ValueError:
        # Windows cannot make a relative path across drives; an absolute file URL
        # still works for the local generated page and keeps the sound optional.
        return f"{source_dir.as_uri().rstrip('/')}/"
    return f"{Path(relative).as_posix().rstrip('/')}/"


def read_web_asset(name: str) -> str:
    """Read a source web asset that will be inlined into generated HTML."""
    return (WEB_DIR / name).read_text(encoding="utf-8")


def read_editor_script_manifest() -> tuple[str, ...]:
    """Read and validate the ordered list of scripts in the editor page."""
    entries: list[str] = []
    for line_number, raw_line in enumerate(read_web_asset(EDITOR_SCRIPT_MANIFEST).splitlines(), start=1):
        entry = raw_line.split("#", 1)[0].strip()
        if not entry:
            continue
        path = Path(entry)
        if path.name != entry or path.suffix.lower() != ".js":
            raise ValueError(f"Invalid editor script manifest entry at line {line_number}: {entry!r}")
        if entry in entries:
            raise ValueError(f"Duplicate editor script manifest entry at line {line_number}: {entry!r}")
        if not (WEB_DIR / path).is_file():
            raise ValueError(f"Editor script manifest entry does not exist: {entry!r}")
        entries.append(entry)
    if not entries:
        raise ValueError("Editor script manifest is empty")
    return tuple(entries)


def build_editor_scripts() -> str:
    """Inline editor scripts using the single shared source order."""
    return "\n\n".join(read_web_asset(name).rstrip() for name in read_editor_script_manifest())


def render_editor_page(**context: str) -> str:
    """Render the modular web sources back into one portable HTML file."""
    replacements = {
        "__EDITOR_CSS__": read_web_asset("editor.css").rstrip(),
        "__WAVEFORM_CSS__": read_web_asset("waveform.css").rstrip(),
        "__EDITOR_SCRIPTS_JS__": build_editor_scripts(),
        "__TITLE__": context["title"],
        "__MEDIA_HTML__": context["media_html"],
        "__DATA_JSON__": context["data_json"],
        "__FILENAME_BASE_JSON__": context["filename_base_json"],
        "__STICKERS_JSON__": context["stickers_json"],
        "__STICKER_ROOT_JSON__": context["sticker_root_json"],
        "__STICKER_URL_PREFIX_JSON__": context.get("sticker_url_prefix_json", '""'),
        "__SERVER_CONFIG_JSON__": context.get("server_config_json", "null"),
        "__NINJA_SFX_BASE_URL_JSON__": context.get("ninja_sfx_base_url_json", '"web/sfx/"'),
        "__UI_LANGUAGE_JSON__": context.get("ui_language_json", "null"),
        "__APP_VERSION__": context["app_version"],
        "__JSON_DISPLAY__": context["json_display"],
        "__JSON_NAME_CLASS__": context["json_name_class"],
        "__MEDIA_NAME_DISPLAY__": context["media_name_display"],
        "__MEDIA_NAME_TITLE__": context["media_name_title"],
        "__MEDIA_NAME_CLASS__": context["media_name_class"],
    }
    page = read_web_asset("editor-template.html")
    template_tokens = set(re.findall(r"__[A-Z][A-Z0-9_]+__", page))
    unresolved = sorted(template_tokens - replacements.keys())
    if unresolved:
        raise ValueError(f"Unresolved editor template tokens: {', '.join(unresolved)}")
    for token, value in replacements.items():
        page = page.replace(token, value)
    return page


def build_blank_html(ninja_sfx_base_url_json: str | None = None) -> str:
    """生成一个空壳全功能编辑器 HTML（不预先自包含任何工程数据）。

    页面功能与 .edit.html 完全一致（始终是最新模板），但初始没有字幕 / 媒体。
    打开后可用「打开工程」单独选择 .mosp 或 .json；浏览器无法自动读取关联媒体时会提示选择，
    即可用最新功能编辑旧工程。

    为保证仓库内发布的 blank-editor.html 可复现且不携带生成者的本机路径，
    空壳不预载 STICKER_DIR；用户可在页面里用 🦊 按钮选择表情包目录。
    """
    blank_data = {"segments": [], "media": "", "language": "", "model": ""}
    # 空占位播放器：无 source，用户通过「加载媒体」加载
    media_html = (
        '<audio id="player" preload="metadata" '
        'style="width:100%;display:block;"></audio>'
    )
    return render_editor_page(
        title=html.escape("MAWE — Moy's ASR Workflow Editor · 用「打开工程」加载工程文件"),
        media_html=media_html,
        data_json=json.dumps(blank_data, ensure_ascii=False),
        filename_base_json=json.dumps("untitled", ensure_ascii=False),
        stickers_json="[]",
        sticker_root_json='""',
        ninja_sfx_base_url_json=ninja_sfx_base_url_json or '"web/sfx/"',
        app_version=html.escape(f"v{get_app_version()}"),
        json_display=html.escape("未加载工程"),
        json_name_class="empty",
        media_name_display=html.escape("未加载媒体"),
        media_name_title="",
        media_name_class="empty",
    )


def main():
    parser = argparse.ArgumentParser(description="MAWE — Moy's ASR Workflow Editor（含表情包管理 + 多选）")
    parser.add_argument(
        "json_path", nargs="?",
        help="工程文件路径（.mosp 或 .json，由 generate_subtitle_qwen_api.py --json 生成）；--blank 模式下可省略",
    )
    parser.add_argument(
        "-m", "--media",
        help="媒体文件路径（默认从工程文件的 media 读取，找不到时尝试同目录同名媒体）",
    )
    parser.add_argument(
        "-s", "--stickers",
        help="表情包文件夹路径（扫描其中图片作为表情包来源）",
    )
    parser.add_argument(
        "-o", "--output",
        help="输出 HTML 路径（默认: 工程文件同目录下 <stem>.edit.html）",
    )
    parser.add_argument(
        "--blank", action="store_true",
        help="生成空壳全功能编辑器（不含工程数据，打开后用「打开工程」加载工程文件）；"
             "默认输出到本项目根目录 blank-editor.html",
    )
    parser.add_argument(
        "--no-waveform", action="store_true",
        help="不预生成波形峰值（已有工程文件中的波形缓存仍会保留）",
    )
    parser.add_argument(
        "--waveform-peaks-per-second", type=int,
        default=DEFAULT_PEAKS_PER_SECOND,
        help=f"波形峰值密度（默认: {DEFAULT_PEAKS_PER_SECOND}/秒）",
    )
    args = parser.parse_args()

    # === 空壳模式：生成最新模板的空编辑器 ===
    if args.blank:
        output_path = Path(args.output).resolve() if args.output else \
            (Path(__file__).parent / "blank-editor.html").resolve()
        # Path.write_text() 在 Windows 上会把换行转换成 CRLF；HTML 资产统一保持 LF。
        output_path.write_bytes(build_blank_html(
            json.dumps(ninja_sfx_base_url(output_path), ensure_ascii=False),
        ).encode("utf-8"))
        print(f"MAWE 空壳编辑器已生成: {output_path}")
        print("用法: file:// 打开 → 点「打开工程」选择 .mosp/.json（需要时按提示选择关联媒体）")
        return 0

    if not args.json_path:
        parser.error("缺少 json_path（或使用 --blank 生成空壳编辑器）")

    json_path = Path(args.json_path).resolve()
    if not json_path.exists():
        print(f"错误: 工程文件不存在 - {json_path}")
        return 1

    try:
        data = normalize_project(json.loads(json_path.read_text(encoding="utf-8")))
    except ProjectValidationFailed as exc:
        print(f"错误: {exc}")
        return 1

    # 媒体
    media_path = None
    if args.media:
        media_path = Path(args.media).resolve()
    else:
        project_media = data.get("media")
        if isinstance(project_media, str) and project_media:
            candidate = Path(project_media)
            if candidate.exists():
                media_path = candidate.resolve()

    if not media_path or not media_path.exists():
        stem = json_path.stem.split(".")[0]
        for ext in list(VIDEO_EXTS) + list(AUDIO_EXTS):
            cand = json_path.parent / f"{stem}{ext}"
            if cand.exists():
                media_path = cand.resolve()
                break

    if not media_path or not media_path.exists():
        print(f"错误: 找不到媒体文件，请用 -m 参数指定")
        return 1

    if not args.no_waveform:
        try:
            waveform, extracted = load_or_extract_waveform(
                data.get("waveform"),
                media_path,
                peaks_per_second=args.waveform_peaks_per_second,
            )
            data["waveform"] = waveform
            state = "已提取" if extracted else "使用缓存"
            print(
                f"[waveform] {state}: {waveform['peak_count']} peaks "
                f"({waveform['peaks_per_second']}/秒)"
            )
        except (WaveformError, ValueError) as exc:
            data.pop("waveform", None)
            print(f"[waveform] 警告: {exc}；编辑器仍可正常使用")

        # ReaPeaks 频谱染色与波形层（可选缓存，读取媒体旁 .ReaPeaks；缺失静默降级）
        spectral = reapeaks.load_spectral_payload(
            media_path, peaks_per_second=args.waveform_peaks_per_second
        )
        if spectral is not None:
            data["spectral"] = spectral
        else:
            data.pop("spectral", None)
        reapeaks_wave = reapeaks.load_waveform_payload(media_path)
        if reapeaks_wave is not None:
            data["waveform_reapeaks"] = reapeaks_wave
        else:
            data.pop("waveform_reapeaks", None)

    output_path = Path(args.output).resolve() if args.output else \
        json_path.with_name(f"{json_path.stem}.edit.html")

    # 媒体 URL
    try:
        media_url = media_path.relative_to(output_path.parent).as_posix()
    except ValueError:
        media_url = media_path.as_uri()

    # 表情包扫描：参数 > .env STICKER_DIR
    sticker_root = ""
    stickers: list[Sticker] = []
    sticker_source = args.stickers or get_default_sticker_dir()
    if sticker_source:
        sticker_dir = Path(sticker_source).resolve()
        sticker_root, stickers = scan_stickers(sticker_dir)

    filename_base = json_path.stem

    page = render_editor_page(
        title=html.escape(f"MAWE — {media_path.name}"),
        media_html=media_tag(media_path, media_url),
        data_json=json.dumps(data, ensure_ascii=False),
        filename_base_json=json.dumps(filename_base, ensure_ascii=False),
        stickers_json=json.dumps(stickers, ensure_ascii=False),
        sticker_root_json=json.dumps(sticker_root, ensure_ascii=False),
        ninja_sfx_base_url_json=json.dumps(
            ninja_sfx_base_url(output_path), ensure_ascii=False,
        ),
        app_version=html.escape(f"v{get_app_version()}"),
        json_display=html.escape(json_path.name),
        json_name_class="",
        media_name_display=html.escape(media_path.name),
        media_name_title=html.escape(f"点击复制媒体名：{media_path.name}"),
        media_name_class="",
    )

    # 保持输出与源码一致为 LF，避免 Windows 文本模式转换成 CRLF。
    output_path.write_bytes(page.encode("utf-8"))
    print(f"编辑页面已生成: {output_path}")
    segments = data["segments"]
    assert isinstance(segments, list)
    print(f"段落数: {len(segments)}")
    print(f"媒体: {media_path}")
    print(f"表情包: {len(stickers)} 张" + (f" (来自 {sticker_source})" if sticker_source else " (未指定 --stickers 且 .env 无 STICKER_DIR)"))
    print()
    print("功能:")
    print("  • 单击跳转 / 双击编辑（光标定位到鼠标位置）/ 右键菜单")
    print("  • 基础波形 / 多行波形；拖动字幕块移动，拖动边缘调整起止时间")
    print("  • Shift+点击=范围选 / Ctrl+点击=切换选 / Alt+点击=切换禁用")
    print("  • 多选后右键：合并字幕、分配跨多句表情包、拓展表情包时间、标记颜色、禁用启用")
    print("  • 拖拽文件到页面：视频/音频→加载媒体，.mosp/.json→打开工程")
    print("  • 右键菜单可分配 5 色标记（红/黄/蓝/绿/紫），单选/多选都支持")
    print("  • 媒体窗口可叠加字幕预览（toolbar 切换）")
    print("  • 拆分键可切换 Enter / Ctrl+Enter")
    print("  • J/K/L 倍速控制（×0.5 / 重置 1× / ×2，叠加）")
    print("  • 下载 SRT / .mosp 工程 / Resolve JSON，以及编辑器支持的附加工程文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
