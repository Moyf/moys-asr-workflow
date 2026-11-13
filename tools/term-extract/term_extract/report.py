"""candidates.json / report.csv / report.html（人工确认页）生成。"""

from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Final

CANDIDATES_FILENAME: Final[str] = "candidates.json"
REPORT_CSV_FILENAME: Final[str] = "report.csv"
REPORT_HTML_FILENAME: Final[str] = "report.html"

CSV_FIELDS: Final[tuple[str, ...]] = (
    "word", "score", "recommended", "typeGuess",
    "aiVerdict", "aiType", "aiReason",
    "eventCount", "hitCount", "avgConf",
    "exportable", "exportIssue", "variants", "contexts", "firstTimeMs",
)


def build_report(
    *,
    video_name: str,
    fps: float,
    model: str,
    duration_ms: int,
    min_score: int,
    scan_summary: Mapping[str, object],
    candidates: Sequence[Mapping[str, object]],
    ai_enabled: bool,
    ai_model: str | None = None,
    frames_dir: Path | None = None,
    weight_by_score: bool = False,
    ai_status: str | None = None,
    region: Mapping[str, object] | None = None,
    frames_base_dir: str = "frames",
) -> dict[str, object]:
    candidate_list = [dict(candidate) for candidate in candidates]
    if ai_enabled:
        for candidate in candidate_list:
            candidate["recommended"] = bool(candidate.get("recommended") and (candidate.get("ai") or {}).get("verdict") == "keep")
    _annotate_evidence_rects(candidate_list, frames_dir)
    return {
        "video": video_name,
        "fps": fps,
        "model": model,
        "durationMs": int(duration_ms),
        "minScore": int(min_score),
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "scan": dict(scan_summary),
        "aiEnabled": bool(ai_enabled),
        "aiModel": ai_model,
        "aiStatus": ai_status or ("complete" if ai_enabled else "disabled"),
        "weightByScore": bool(weight_by_score),
        "region": dict(region) if region is not None else None,
        "framesBaseDir": frames_base_dir,
        "candidates": candidate_list,
    }


def _annotate_evidence_rects(
    candidates: list[dict[str, object]], frames_dir: Path | None
) -> None:
    """把证据条目的像素 bbox 归一化为 rect（0–1，相对帧画面），确认页按百分比画框。

    帧尺寸从 frames/ 下的实际图片读取（PIL 只读文件头），旧扫描数据（--resume）
    同样适用；同时写入 frameSize 供确认页给 <img> 预留宽高、避免加载抖动。
    图片缺失或 pillow 不可用时静默跳过该条目，页面退化为无框缩略图。
    """

    if frames_dir is None:
        return
    sizes: dict[str, tuple[int, int] | None] = {}
    for candidate in candidates:
        for event in candidate.get("events") or []:  # type: ignore[union-attr]
            for entry in event.get("evidence") or []:  # type: ignore[union-attr]
                frame = str(entry.get("frame") or "")
                box = list(entry.get("box") or [])
                if not frame or len(box) != 4:
                    continue
                if frame not in sizes:
                    sizes[frame] = _image_size(frames_dir / frame)
                size = sizes[frame]
                if size is None:
                    continue
                width, height = size
                entry["frameSize"] = [width, height]
                x1, y1, x2, y2 = (float(value) for value in box)
                entry["rect"] = [
                    round(min(1.0, max(0.0, x1 / width)), 4),
                    round(min(1.0, max(0.0, y1 / height)), 4),
                    round(min(1.0, max(0.0, (x2 - x1) / width)), 4),
                    round(min(1.0, max(0.0, (y2 - y1) / height)), 4),
                ]


def _image_size(path: Path) -> tuple[int, int] | None:
    try:
        from PIL import Image  # 延迟导入：环境缺 pillow 时降级为无框模式

        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:
        return None


def write_candidates_json(path: Path, report: Mapping[str, object]) -> None:
    path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8", newline="\n"
    )


def write_report_csv(path: Path, candidates: Sequence[Mapping[str, object]]) -> None:
    json.dumps(candidates, allow_nan=False)
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS, lineterminator="\n")
    writer.writeheader()
    for candidate in candidates:
        ai = candidate.get("ai") or {}
        export_info = candidate.get("export") or {}
        writer.writerow(
            {
                "word": candidate.get("word", ""),
                "score": candidate.get("score", ""),
                "recommended": "是" if candidate.get("recommended") else "否",
                "typeGuess": candidate.get("typeGuess", ""),
                "aiVerdict": ai.get("verdict", ""),  # type: ignore[union-attr]
                "aiType": ai.get("type", ""),  # type: ignore[union-attr]
                "aiReason": ai.get("reason", ""),  # type: ignore[union-attr]
                "eventCount": candidate.get("eventCount", 0),
                "hitCount": candidate.get("hitCount", 0),
                "avgConf": candidate.get("avgConf", 0.0),
                "exportable": "是" if export_info.get("ok", True) else "否",  # type: ignore[union-attr]
                "exportIssue": export_info.get("reason", "") or "",  # type: ignore[union-attr]
                "variants": " / ".join(
                    str(item.get("text")) for item in candidate.get("variants") or []
                ),
                "contexts": " | ".join(str(item) for item in candidate.get("contexts") or []),
                "firstTimeMs": (candidate.get("events") or [{}])[0].get("startMs", "")  # type: ignore[union-attr,index]
                if candidate.get("events")
                else "",
            }
        )
    # UTF-8 BOM 让 Excel 直接打开时识别编码（与 OCR 去重报告一致）。
    path.write_bytes(("\ufeff" + output.getvalue()).encode("utf-8"))


def render_report_html(report: Mapping[str, object]) -> str:
    frames_base = report.get("framesBaseDir", "frames")
    if not isinstance(frames_base, str) or not re.fullmatch(r"frames(?:/run-[0-9a-f]{32})?", frames_base):
        raise ValueError("报告证据目录必须是安全的相对路径")
    data_json = json.dumps(report, ensure_ascii=False, allow_nan=False).replace("</", "<\\/")
    return HTML_TEMPLATE.replace("__DATA_JSON__", data_json)


def write_report_html(path: Path, report: Mapping[str, object]) -> None:
    path.write_text(render_report_html(report), encoding="utf-8", newline="\n")


def format_time(t_ms: int) -> str:
    seconds = t_ms // 1000
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


HTML_TEMPLATE = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>术语提取确认页</title>
<script>try{var t=localStorage.getItem("maw-term-report-theme");document.documentElement.dataset.theme=t||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");if(localStorage.getItem("maw-term-report-compact")==="1")document.documentElement.classList.add("compact");}catch(e){document.documentElement.dataset.theme="dark";}</script>
<style>
/* Hallmark · redesign: 工具确认页 · tone: utilitarian · palette: MAW Launcher 令牌（深色橙 / 浅色红强调），深色 / 浅色 */
:root,[data-theme=dark]{
  --bg-base:#1c1c20;--bg-panel:#26262b;--bg-raised:#2e2e34;--bg-input:#222226;--bg-hover:#2b2b31;
  --text-primary:#f3f1ee;--text-secondary:#d4d0cb;--text-muted:#b0aba5;--text-faint:#7c7873;
  --border-subtle:#33333a;--border:#44444c;--border-strong:#5a5a63;
  --accent:#f09a50;--accent-hover:#f5ad6c;--accent-text:#1c0f05;
  --tier-rec:#57c993;--tier-maybe:#f2bd5c;--tier-weak:#8fa6c8;--tier-noise:#7c7873;
  --good:#57c993;--bad:#f07c74;--warn:#f2bd5c;
  --mark:#ff4d6d;--mark-halo:rgba(0,0,0,.55);
  --shadow-1:0 1px 2px rgba(0,0,0,.25);--shadow-2:0 1px 2px rgba(0,0,0,.25),0 4px 14px rgba(0,0,0,.2);
  --scrim:rgba(12,12,14,.92);--on-scrim:#f3f1ee;--on-scrim-soft:rgba(255,255,255,.1);--on-scrim-line:rgba(255,255,255,.28);
  color-scheme:dark;
}
[data-theme=light]{
  --bg-base:#f4f4f5;--bg-panel:#ffffff;--bg-raised:#f1f1f3;--bg-input:#ffffff;--bg-hover:#f8f8f9;
  --text-primary:#1d1d20;--text-secondary:#46464d;--text-muted:#64646c;--text-faint:#a1a1a8;
  --border-subtle:#e6e6e9;--border:#d2d2d7;--border-strong:#b9b9c0;
  --accent:#c84545;--accent-hover:#b03a3a;--accent-text:#ffffff;
  --tier-rec:#1d8a57;--tier-maybe:#a86c0c;--tier-weak:#5b6b85;--tier-noise:#a1a1a8;
  --good:#1d8a57;--bad:#c84545;--warn:#946010;
  --mark:#e11d48;--mark-halo:rgba(255,255,255,.75);
  --shadow-1:0 1px 2px rgba(20,20,30,.05);--shadow-2:0 1px 2px rgba(20,20,30,.05),0 4px 14px rgba(20,20,30,.06);
  color-scheme:light;
}
:root{
  --font-sans:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif;
  --font-mono:ui-monospace,"Cascadia Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --r-sm:6px;--r-md:9px;--r-lg:14px;
  --t-fast:130ms ease-out;
  --top-stick:0px;--dock-h:0px;
}
*{box-sizing:border-box}
html,body{overflow-x:clip}
[hidden]{display:none!important}
body{margin:0;font:14px/1.55 var(--font-sans);color:var(--text-primary);background:var(--bg-base)}
body.overlay-open{overflow:hidden}
button,input,select{font:inherit;color:inherit}
button{height:32px;padding:0 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg-raised);color:var(--text-secondary);font-size:13px;cursor:pointer;white-space:nowrap;transition:background var(--t-fast),border-color var(--t-fast),color var(--t-fast)}
button:hover{background:var(--bg-hover);border-color:var(--border-strong);color:var(--text-primary)}
button:active{transform:translateY(1px)}
button:disabled{opacity:.45;cursor:not-allowed;transform:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text);font-weight:600}
button.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover);color:var(--accent-text)}
button.ghost{background:transparent;border-color:transparent;color:var(--text-muted)}
button.ghost:hover{background:var(--bg-raised);color:var(--text-primary)}

.top{position:sticky;top:0;z-index:6;background:var(--bg-panel);border-bottom:1px solid var(--border-subtle);box-shadow:var(--shadow-1)}
.top-row,.toolbar{max-width:1320px;margin:0 auto;padding-left:24px;padding-right:24px}
.top-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 20px;padding-top:14px;padding-bottom:12px}
.title{display:flex;align-items:baseline;gap:12px;min-width:0;flex:1 1 320px}
.title h1{margin:0;font-size:17px;font-weight:700;letter-spacing:.01em;white-space:nowrap}
.src{min-width:0;color:var(--text-faint);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stats{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 20px;color:var(--text-muted);font-size:12.5px}
.stats span{white-space:nowrap}
.stats b{margin-right:5px;font:600 16px var(--font-mono);color:var(--text-primary);font-variant-numeric:tabular-nums}
.stats .stat-picked b{color:var(--accent)}
#theme-btn{width:32px;padding:0;font-size:15px}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding-bottom:14px}
.field{display:inline-flex;align-items:stretch;height:32px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg-input);overflow:hidden;transition:border-color var(--t-fast)}
.field:hover{border-color:var(--border-strong)}
.field:focus-within{border-color:var(--accent)}
.field>span{display:flex;align-items:center;padding:0 9px;border-right:1px solid var(--border-subtle);background:var(--bg-raised);color:var(--text-muted);font-size:12.5px;white-space:nowrap}
.field input,.field select{min-width:0;border:0;background:transparent;padding:0 10px;font-size:13px;outline:none}
.field select{padding-right:6px;cursor:pointer}
.field-search{flex:1 1 240px;max-width:360px}
.field-search input{width:100%}
.num input{width:58px;font-family:var(--font-mono);cursor:ns-resize;-moz-appearance:textfield}
.num input::-webkit-inner-spin-button,.num input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.num input::placeholder,.field-search input::placeholder{color:var(--text-faint)}

.layout{max-width:1320px;margin:0 auto;padding:4px 24px 40px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
#list{min-width:0}

.tier-head{position:sticky;top:var(--top-stick);z-index:3;display:flex;align-items:center;gap:10px;min-height:50px;margin-top:14px;padding:6px 8px 6px 4px;background:var(--bg-base);border-bottom:1px solid var(--border-subtle);border-radius:var(--r-sm) var(--r-sm) 0 0;cursor:pointer;user-select:none;transition:background var(--t-fast)}
.tier-head:hover{background:var(--bg-raised)}
.tier-toggle{flex:1 1 auto;display:flex;align-items:center;gap:9px;min-width:0;height:38px;padding:0 6px;border:0;background:transparent;color:var(--text-primary);font-size:14px;text-align:left}
.tier-toggle:hover{background:transparent}
.tier-toggle .arrow{width:12px;color:var(--text-faint);font-size:11px;transition:transform var(--t-fast)}
.tier-toggle[aria-expanded=false] .arrow{transform:rotate(-90deg)}
.tier-dot{width:9px;height:9px;border-radius:3px;flex:none;background:var(--tier-c)}
.tier-name{font-weight:700}
.tier-range{color:var(--text-faint);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tier-count{padding:0 8px;border-radius:10px;background:color-mix(in oklab,var(--tier-c) 16%,transparent);color:var(--tier-c);font:600 12px/20px var(--font-mono);white-space:nowrap}
.tier-pick{height:28px;padding:0 10px;font-size:12.5px}
.tier-body{padding-top:10px}
.tier-rec{--tier-c:var(--tier-rec)}
.tier-maybe{--tier-c:var(--tier-maybe)}
.tier-weak{--tier-c:var(--tier-weak)}
.tier-noise{--tier-c:var(--tier-noise)}

.card{position:relative;display:grid;grid-template-columns:48px 52px minmax(0,1fr) auto;gap:0 14px;align-items:start;margin-bottom:8px;padding:14px 14px 14px 0;background:var(--bg-panel);border:1px solid var(--border-subtle);border-radius:var(--r-md);cursor:pointer;transition:background var(--t-fast),border-color var(--t-fast);content-visibility:auto;contain-intrinsic-size:auto 124px;scroll-margin-top:calc(var(--top-stick) + 60px);scroll-margin-bottom:calc(var(--dock-h) + 16px)}
@media print{.card{content-visibility:visible}}
.card::before{content:"";position:absolute;left:-1px;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--tier-c);opacity:.9}
.card:hover{background:var(--bg-hover);border-color:var(--border)}
.card.is-picked{background:color-mix(in oklab,var(--accent) 9%,var(--bg-panel));border-color:color-mix(in oklab,var(--accent) 55%,transparent)}
.card.off{cursor:default;opacity:.62}
.card.tier-noise:not(.is-picked){opacity:.8}
.pick{align-self:stretch;display:flex;justify-content:center;margin:-14px 0;padding-top:28px;cursor:pointer}
.card.off .pick{cursor:not-allowed}
.box{appearance:none;-webkit-appearance:none;display:grid;place-content:center;width:24px;height:24px;margin:0;border:1.5px solid var(--border-strong);border-radius:6px;background:var(--bg-input);cursor:inherit;transition:background var(--t-fast),border-color var(--t-fast)}
.box::before{content:"";width:11px;height:6px;margin-top:-3px;border:solid var(--accent-text);border-width:0 0 2.5px 2.5px;transform:rotate(-45deg) scale(0);transition:transform var(--t-fast)}
.card:hover .box:not(:disabled){border-color:var(--accent)}
.box:checked{background:var(--accent);border-color:var(--accent)}
.box:checked::before{transform:rotate(-45deg) scale(1)}
.box:disabled{background:var(--bg-raised);border-style:dashed}
.score-cell{display:flex;flex-direction:column;align-items:center;justify-content:center;width:52px;height:52px;border-radius:10px;background:color-mix(in oklab,var(--tier-c) 15%,transparent);color:var(--tier-c);line-height:1}
.score-cell b{font:700 20px var(--font-mono);font-variant-numeric:tabular-nums}
.score-cell span{margin-top:5px;font-size:11px;opacity:.9}
.body{min-width:0;padding-top:1px}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
.word{margin:0;font-size:18px;font-weight:700;line-height:1.3;overflow-wrap:anywhere;min-width:0;color:var(--text-primary)}
.badge{display:inline-block;padding:0 8px;border-radius:10px;background:var(--bg-raised);color:var(--text-muted);font-size:12px;line-height:20px;white-space:nowrap}
.badge.ai-keep{background:color-mix(in oklab,var(--good) 15%,transparent);color:var(--good)}
.badge.ai-reject{background:color-mix(in oklab,var(--bad) 15%,transparent);color:var(--bad)}
.badge.noexport{background:color-mix(in oklab,var(--warn) 15%,transparent);color:var(--warn);white-space:normal}
.facts{display:flex;flex-wrap:wrap;gap:2px 16px;margin-top:5px;color:var(--text-faint);font-size:12.5px}
.facts span{white-space:nowrap}
.facts b{margin:0 2px;font:600 12.5px var(--font-mono);color:var(--text-secondary);font-variant-numeric:tabular-nums}
.ctx{margin:8px 0 0;padding:3px 10px;border-left:2px solid var(--border-strong);border-radius:0 var(--r-sm) var(--r-sm) 0;background:var(--bg-raised);color:var(--text-muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
mark{padding:0 1px;border-radius:3px;background:color-mix(in oklab,var(--accent) 28%,transparent);color:var(--text-primary)}
.more{margin-top:8px}
.more summary{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--border-subtle);border-radius:13px;color:var(--text-muted);font-size:12px;list-style:none;cursor:pointer;user-select:none}
.more summary::-webkit-details-marker{display:none}
.more summary::after{content:"";width:6px;height:6px;margin-top:-3px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg);transition:transform var(--t-fast)}
.more[open] summary::after{margin-top:3px;transform:rotate(-135deg)}
.more summary:hover{border-color:var(--border);color:var(--text-primary)}
.more-body{margin-top:8px;padding:10px 12px;border-radius:var(--r-sm);background:var(--bg-raised);cursor:auto}
.d-row{display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px;font-size:12.5px;color:var(--text-secondary)}
.d-row+.d-row{margin-top:8px;padding-top:8px;border-top:1px solid var(--border-subtle)}
.d-k{color:var(--text-faint)}
.reasons{margin:0;padding:0;list-style:none}
.reasons li+li{margin-top:2px}
.delta{display:inline-block;min-width:38px;font:600 12px var(--font-mono)}
.delta.plus{color:var(--good)}
.delta.minus{color:var(--bad)}
.times{display:flex;flex-wrap:wrap;gap:4px}
.times span{padding:0 6px;border-radius:4px;background:var(--bg-panel);font:12px/20px var(--font-mono);color:var(--text-secondary)}

.frame-wrap{position:relative;display:block;line-height:0}
.frame-rect{position:absolute;border:2px solid var(--mark);box-shadow:0 0 0 1px var(--mark-halo);border-radius:2px;pointer-events:none}
.thumb{position:relative;display:block;width:168px;height:auto;padding:0;border:1px solid var(--border-subtle);border-radius:var(--r-sm);overflow:hidden;background:var(--bg-raised);cursor:zoom-in}
.thumb img{display:block;width:100%;height:auto}
.thumb:hover{border-color:var(--accent);background:var(--bg-raised)}
.thumb-more{position:absolute;right:6px;bottom:6px;padding:0 7px;border-radius:9px;background:var(--scrim);color:var(--on-scrim);font:11px/18px var(--font-mono)}
.frames{display:flex;flex-wrap:wrap;gap:8px}
.frame-btn{height:auto;padding:0;border:1px solid var(--border-subtle);border-radius:var(--r-sm);overflow:hidden;background:var(--bg-panel);cursor:zoom-in}
.frame-btn img{display:block;height:72px;width:auto}
.empty{padding:56px 0;color:var(--text-muted);text-align:center}
.empty button{margin-left:8px}

.switch{display:inline-flex;align-items:center;gap:8px;height:32px;margin-left:auto;padding:0 4px;color:var(--text-secondary);font-size:13px;white-space:nowrap;cursor:pointer;user-select:none}
.switch input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.switch-track{position:relative;width:34px;height:20px;border-radius:10px;background:var(--border);transition:background var(--t-fast)}
.switch-track::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--text-primary);box-shadow:var(--shadow-1);transition:transform var(--t-fast)}
.switch:hover .switch-track{background:var(--border-strong)}
.switch input:checked+.switch-track{background:var(--accent)}
.switch input:checked+.switch-track::after{transform:translateX(14px);background:var(--accent-text)}
.switch input:focus-visible+.switch-track{outline:2px solid var(--accent);outline-offset:2px}

.compact .card{grid-template-columns:44px 44px minmax(0,1fr);align-items:center;margin-bottom:4px;padding:5px 12px 5px 0;contain-intrinsic-size:auto 46px}
.compact .card::before{top:7px;bottom:7px}
.compact .pick{align-items:center;margin:-5px 0;padding-top:0}
.compact .box{width:20px;height:20px;border-radius:5px}
.compact .box::before{width:9px;height:5px;border-width:0 0 2px 2px}
.compact .score-cell{width:44px;height:28px;border-radius:7px}
.compact .score-cell b{font-size:14px}
.compact .score-cell span,.compact .ctx,.compact .more,.compact .thumb{display:none}
.compact .body{display:flex;align-items:center;gap:6px 18px;padding-top:0}
.compact .head{flex:0 1 auto;flex-wrap:nowrap;min-width:0;overflow:hidden}
.compact .word{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.compact .facts{flex:0 0 auto;flex-wrap:nowrap;margin:0 0 0 auto;gap:0 14px}
.compact .tier-body{padding-top:6px}

.dock{position:sticky;top:calc(var(--top-stick) + 16px);display:flex;flex-direction:column;gap:12px;margin-top:16px;max-height:calc(100vh - var(--top-stick) - 32px);overflow:auto}
.panel{padding:16px;background:var(--bg-panel);border:1px solid var(--border-subtle);border-radius:var(--r-lg)}
.panel h2{margin:0;font-size:13px;font-weight:700;color:var(--text-primary)}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:12px}
.count{font:600 13px var(--font-mono);color:var(--accent)}
.dock-toggle{display:none}
.preview-body{display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px;min-height:36px;max-height:min(36vh,300px);overflow:auto}
.preview-empty{color:var(--text-faint);font-size:12.5px}
.word-chip{display:inline-flex;align-items:center;gap:2px;height:26px;max-width:100%;padding:0 3px 0 10px;border-radius:13px;background:color-mix(in oklab,var(--accent) 14%,transparent);color:var(--text-primary);font-size:13px}
.word-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.word-chip button{width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--text-muted);font-size:14px;line-height:1}
.word-chip button:hover{background:color-mix(in oklab,var(--accent) 30%,transparent);color:var(--text-primary)}
.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:14px}
#export-btn,#copy-btn{height:36px}
.panel .hint{margin:12px 0 0;color:var(--text-faint);font-size:12px}
.keys,.source{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 12px;margin:0;font-size:12.5px}
.keys dt{white-space:nowrap}
.keys dd,.source dd{margin:0;color:var(--text-muted);min-width:0;overflow-wrap:anywhere}
.source dt{color:var(--text-faint)}
.source dd{color:var(--text-secondary)}
kbd{display:inline-block;min-width:20px;padding:0 5px;border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;background:var(--bg-raised);color:var(--text-secondary);font:11.5px/18px var(--font-mono);text-align:center}
.panel-aux h2{margin-bottom:12px}

.toast{position:fixed;left:50%;bottom:calc(var(--dock-h) + 24px);z-index:12;max-width:calc(100vw - 32px);padding:9px 16px;border-radius:var(--r-sm);background:var(--scrim);color:var(--on-scrim);font-size:13px;box-shadow:var(--shadow-2);opacity:0;transform:translate(-50%,8px);pointer-events:none;transition:opacity .16s ease,transform .16s ease}
.toast.show{opacity:1;transform:translate(-50%,0)}

.overlay{position:fixed;inset:0;z-index:9;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:16px 84px;background:var(--scrim)}
.overlay.open{display:flex}
.overlay-wrap{position:relative;line-height:0}
.overlay img{display:block;max-width:min(calc(100vw - 184px),1600px);max-height:78vh;border-radius:8px}
.overlay .frame-rect{border-width:3px;border-radius:3px}
.overlay-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px 16px;color:var(--on-scrim);font-size:13px}
.overlay-word{font-size:16px;font-weight:700}
#overlay-count{font-family:var(--font-mono);opacity:.8}
.overlay button{border-color:var(--on-scrim-line);background:var(--on-scrim-soft);color:var(--on-scrim)}
.overlay button:hover{background:var(--on-scrim-line)}
.overlay button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
.overlay-nav{position:fixed;top:50%;display:flex;align-items:center;justify-content:center;width:52px;height:52px;padding:0;border-radius:50%;font-size:28px;line-height:1;transform:translateY(-50%)}
.overlay-nav:active{transform:translateY(-50%)}
#overlay-prev{left:20px}
#overlay-next{right:20px}
#overlay-close{position:fixed;top:16px;right:20px;width:40px;height:40px;padding:0;border-radius:50%;font-size:20px}

@media (max-width:959px){
  .layout{grid-template-columns:minmax(0,1fr);padding-bottom:16px}
  body{padding-bottom:var(--dock-h)}
  .dock{position:fixed;left:0;right:0;bottom:0;top:auto;z-index:7;margin:0;max-height:none;overflow:visible;gap:0}
  .dock .panel-aux{display:none}
  .export{display:grid;grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:"tog copy exp";align-items:center;gap:8px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));border-width:1px 0 0;border-radius:0;box-shadow:0 -6px 20px rgba(0,0,0,.18)}
  .export .panel-head,.export .hint,.export .preview-body,#check-recommended,#uncheck-all{display:none}
  .export .actions{display:contents}
  .dock-toggle{grid-area:tog;display:flex;align-items:center;gap:8px;justify-self:start;max-width:100%;height:36px;padding:0 12px;background:transparent;border-color:transparent;color:var(--text-secondary)}
  .dock-toggle b{font:600 15px var(--font-mono);color:var(--accent)}
  .dock-toggle i{font-style:normal;color:var(--text-faint);font-size:11px;transition:transform var(--t-fast)}
  #copy-btn{grid-area:copy}
  #export-btn{grid-area:exp}
  .dock.expanded .export{grid-template-columns:repeat(4,minmax(0,1fr));grid-template-areas:"tog tog tog tog" "prev prev prev prev" "rec clr copy exp"}
  .dock.expanded .preview-body{grid-area:prev;display:flex;max-height:32vh;margin:2px 0 4px}
  .dock.expanded #check-recommended{grid-area:rec;display:block}
  .dock.expanded #uncheck-all{grid-area:clr;display:block}
  .dock.expanded .dock-toggle i{transform:rotate(180deg)}
  .card{grid-template-columns:44px 46px minmax(0,1fr);padding-right:12px}
  .score-cell{width:46px;height:46px}
  .score-cell b{font-size:17px}
  .pick{padding-top:25px}
  .card .thumb{grid-column:3;margin-top:10px;width:min(200px,100%)}
  .compact .card{grid-template-columns:40px 40px minmax(0,1fr)}
  .compact .score-cell{width:40px}
  .compact .body{display:block}
  .compact .facts{margin:1px 0 0;flex-wrap:wrap;gap:0 12px;font-size:12px}
  .compact .facts span:nth-child(n+3){display:none}
  .overlay{padding:16px 12px 88px}
  .overlay img{max-width:calc(100vw - 24px)}
  .overlay-nav{top:auto;bottom:20px;transform:none}
  .overlay-nav:active{transform:none}
}
@media (max-width:560px){
  .top{position:static}
  .top-row,.toolbar{padding-left:14px;padding-right:14px}
  .layout{padding-left:14px;padding-right:14px}
  .field-search{flex-basis:100%;max-width:none}
  .tier-range{display:none}
  .export{padding-left:10px;padding-right:10px}
  .dock.expanded .export{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-areas:"tog tog" "prev prev" "rec clr" "copy exp"}
}
@media (prefers-reduced-motion:reduce){
  *{transition:none!important}
  button:active{transform:none}
}
</style>
</head>
<body>
<header class="top">
  <div class="top-row">
    <div class="title"><h1>术语提取确认页</h1><span class="src" id="src-name"></span></div>
    <div class="stats" id="stats"></div>
    <button type="button" id="theme-btn" class="ghost" title="切换深色 / 浅色" aria-label="切换深色或浅色主题">◐</button>
  </div>
  <div class="toolbar" role="search">
    <label class="field field-search"><input type="search" id="q" placeholder="搜索词 / 变体 / 上下文（按 / 聚焦）" aria-label="搜索"></label>
    <label class="field num" title="最低分数：留空不限；可键入，或悬停滚轮调整（±5）"><span>分数 ≥</span><input type="number" id="min-score" value="" placeholder="不限" step="5"></label>
    <label class="field num" title="最多字数：超过的候选默认隐藏（疑似整句字幕或 UI 文案）；清空显示全部；滚轮可调（±1）"><span>字数 ≤</span><input type="number" id="max-len" value="12" min="1"></label>
    <label class="field num" title="最少出现次数：按独立显示事件数过滤；滚轮可调（±1）"><span>出现 ≥</span><input type="number" id="min-events" value="0" min="0"></label>
    <label class="field"><span>AI</span><select id="ai-filter" aria-label="AI 判定">
      <option value="">全部判定</option>
      <option value="keep">AI 保留</option>
      <option value="reject">AI 排除</option>
      <option value="none">未筛选</option>
    </select></label>
    <button type="button" id="reset-filters" class="ghost">重置筛选</button>
    <label class="switch" title="精简显示：每个候选只占一行，隐藏缩略图、上下文与明细（V）"><input type="checkbox" id="compact-toggle" role="switch"><span class="switch-track" aria-hidden="true"></span>精简显示</label>
  </div>
</header>
<div class="layout">
  <main id="list"></main>
  <aside class="dock" id="dock">
    <section class="panel export" aria-labelledby="preview-title">
      <div class="panel-head"><h2 id="preview-title">导出预览</h2><span class="count" id="preview-count">0 个词</span></div>
      <button type="button" class="dock-toggle" id="dock-toggle" aria-expanded="false" aria-controls="preview-body">已选 <b id="dock-count">0</b> 个词 <i>▲</i></button>
      <div class="preview-body" id="preview-body"></div>
      <div class="actions">
        <button type="button" id="export-btn" class="primary">导出热词 txt</button>
        <button type="button" id="copy-btn">复制清单</button>
        <button type="button" id="check-recommended">勾选推荐项</button>
        <button type="button" id="uncheck-all">清空勾选</button>
      </div>
      <p class="hint" id="export-hint">按候选顺序去重，最多导出 2000 个词；点 × 可移除单个词。</p>
    </section>
    <section class="panel panel-aux" aria-labelledby="keys-title">
      <h2 id="keys-title">快捷键</h2>
      <dl class="keys">
        <dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>下一条 / 上一条</dd>
        <dt><kbd>X</kbd> <kbd>空格</kbd></dt><dd>勾选当前条（也可直接点整行）</dd>
        <dt><kbd>O</kbd> <kbd>Enter</kbd></dt><dd>查看证据帧</dd>
        <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>大图前后切换，<kbd>Esc</kbd> 关闭</dd>
        <dt><kbd>/</kbd></dt><dd>聚焦搜索</dd>
        <dt><kbd>V</kbd></dt><dd>切换精简显示</dd>
      </dl>
    </section>
    <section class="panel panel-aux" aria-labelledby="source-title">
      <h2 id="source-title">来源</h2>
      <dl class="source" id="source"></dl>
    </section>
  </aside>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<div class="overlay" id="overlay" tabindex="-1" role="dialog" aria-modal="true" aria-label="证据帧大图">
  <button type="button" id="overlay-close" title="关闭（Esc）" aria-label="关闭">×</button>
  <button type="button" class="overlay-nav" id="overlay-prev" title="上一张（←）" aria-label="上一张">‹</button>
  <div class="overlay-wrap"><img id="overlay-img" alt="证据帧大图"><div class="overlay-rects" id="overlay-rects"></div></div>
  <div class="overlay-bar"><span class="overlay-word" id="overlay-word"></span><span id="overlay-count"></span><button type="button" id="overlay-pick"></button></div>
  <button type="button" class="overlay-nav" id="overlay-next" title="下一张（→）" aria-label="下一张">›</button>
</div>
<script type="application/json" id="candidate-data">__DATA_JSON__</script>
<script>
(function(){
"use strict";
var report=JSON.parse(document.getElementById("candidate-data").textContent);
var cands=report.candidates||[];
var framesBase=report.framesBaseDir||"frames";
function frameUrl(frame){return framesBase+"/"+frame;}
var line=report.minScore||60;
var list=document.getElementById("list");
var checkedState=new Set();
var collapsed={weak:true,noise:true};
var tierUI=[];
var lastShown=0;
var FILTER_DEFAULTS={"q":"","min-score":"","max-len":"12","min-events":"0","ai-filter":""};
var IDX=new Map();
cands.forEach(function(c,i){IDX.set(c,i);});

function $(id){return document.getElementById(id);}
function fmtTime(ms){var s=Math.floor((ms||0)/1000);return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
function frameTime(f){var m=/frame-(\\d+)\\.jpg$/.exec(f||"");return m?fmtTime(parseInt(m[1],10)):"";}
function exportIssue(c){
  if(c.export&&!c.export.ok)return c.export.reason||"热词不符合限制";
  var word=String(c.word||"").trim(),match=/^(.+?)\\s*[:：]\\s*([0-9]+)\\s*$/.exec(word);
  if(!word)return "热词名称为空";
  if(match){
    if([1,2,3,4,5,50].indexOf(Number(match[2]))<0)return "权重只能是 1–5 或 50";
    word=match[1].trim();
  }
  if(!word)return "热词名称为空";
  if(/[^\\x00-\\x7f]/.test(word))return Array.from(word).length>15?"含非 ASCII 字符时最多 15 个字符":null;
  return word.split(/\\s+/).length>7?"纯 ASCII 热词最多 7 个空格分隔的单词":null;
}
function exportable(c){return !exportIssue(c);}
function recommended(c){return !!c.recommended&&(!c.ai||c.ai.verdict!=="reject")&&(!report.aiEnabled||(c.ai&&c.ai.verdict==="keep"));}
function highlight(text,word){
  var s=String(text||""),w=String(word||"");
  var k=w?s.toLowerCase().indexOf(w.toLowerCase()):-1;
  if(k<0)return esc(s);
  return esc(s.slice(0,k))+"<mark>"+esc(s.slice(k,k+w.length))+"</mark>"+esc(s.slice(k+w.length));
}

function rectStyle(r){
  return "left:"+(r[0]*100).toFixed(2)+"%;top:"+(r[1]*100).toFixed(2)+"%;width:"+(r[2]*100).toFixed(2)+"%;height:"+(r[3]*100).toFixed(2)+"%";
}
function rectsHtml(rects){
  return (rects||[]).map(function(r){return '<i class="frame-rect" style="'+rectStyle(r)+'"></i>';}).join("");
}

function evidenceOf(c){
  var rects={},sizes={},order=[];
  (c.events||[]).forEach(function(e){(e.evidence||[]).forEach(function(v){
    if(!v||!v.frame)return;
    if(!rects[v.frame]){rects[v.frame]=[];order.push(v.frame);}
    if(v.rect)rects[v.frame].push(v.rect);
    if(v.frameSize)sizes[v.frame]=v.frameSize;
  });});
  return {frames:order.slice(0,4),rects:rects,sizes:sizes};
}
var EV=cands.map(evidenceOf);
var REC_COUNT=cands.filter(recommended).length;
var KEEP_COUNT=cands.filter(function(c){return c.ai&&c.ai.verdict==="keep";}).length;

function frameHtml(f,ev){
  var sz=ev.sizes[f]||[];
  var dims=sz.length?' width="'+sz[0]+'" height="'+sz[1]+'"':"";
  return '<span class="frame-wrap"><img loading="lazy" decoding="async"'+dims+' src="'+esc(frameUrl(f))+'" alt="证据帧 '+frameTime(f)+'">'+rectsHtml(ev.rects[f])+"</span>";
}

var TIERS=[
  {id:"rec",name:"推荐",desc:report.aiEnabled?"规则达到推荐线；自动勾选另需 AI 保留":"达到规则推荐线",cls:"rec"},
  {id:"maybe",name:"待定",desc:"接近推荐线",cls:"maybe"},
  {id:"weak",name:"观察",desc:"信号较弱",cls:"weak"},
  {id:"noise",name:"排除",desc:"忽略词、整句等负面评分",cls:"noise"}
];
var TIER_NAME={};
TIERS.forEach(function(t){TIER_NAME[t.id]=t.name;});
function tierOf(c){
  var s=c.score||0;
  if(s>=line)return "rec";
  if(s>=line-20)return "maybe";
  if(s>0)return "weak";
  return "noise";
}
function tierRange(id){
  if(id==="rec")return "≥"+line+" 分";
  if(id==="maybe")return (line-20)+"–"+(line-1)+" 分";
  if(id==="weak")return "1–"+Math.max(line-21,0)+" 分";
  return "≤0 分";
}

function badgesHtml(c){
  var out=[],ai=c.ai;
  if(c.typeGuess)out.push('<span class="badge">'+esc(c.typeGuess)+"</span>");
  if(ai)out.push('<span class="badge ai-'+esc(ai.verdict)+'">AI '+(ai.verdict==="keep"?"保留":"排除")+(ai.type?" · "+esc(ai.type):"")+"</span>");
  else if(report.aiEnabled||["pending","failed","cancelled"].indexOf(report.aiStatus)>=0)out.push('<span class="badge">仅规则评分 · AI 未完成</span>');
  if(!exportable(c))out.push('<span class="badge noexport">不可导出：'+esc(exportIssue(c))+"</span>");
  return out.join("");
}

function detailRow(label,html){return '<div class="d-row"><span class="d-k">'+label+"</span><div>"+html+"</div></div>";}

function renderCard(c,i){
  var ev=EV[i],ok=exportable(c),picked=checkedState.has(i),tier=tierOf(c);
  var card=document.createElement("article");
  card.className="card tier-"+tier+(ok?"":" off")+(picked?" is-picked":"");
  card.tabIndex=0;
  card.dataset.i=String(i);
  var first=(c.events||[])[0];
  var facts=[
    '<span title="独立显示事件数（同一段连续显示算一次）">出现<b>'+(c.eventCount||0)+"</b>次</span>",
    '<span title="被采样到的帧数">采样<b>'+(c.hitCount||0)+"</b>帧</span>",
    '<span title="OCR 平均置信度">置信<b>'+Math.round((c.avgConf||0)*100)+"%</b></span>"
  ];
  if(first)facts.push('<span title="首次出现时间">首现<b>'+fmtTime(first.startMs)+"</b></span>");
  var ctx=(c.contexts||[]).filter(function(s){return s&&s!==c.word;})[0]||"";
  var reasons=(c.reasons||[]).map(function(r){
    return '<li><span class="delta '+(r.delta>=0?"plus":"minus")+'">'+(r.delta>=0?"+":"")+r.delta+"</span>"+esc(r.detail)+"</li>";
  }).join("");
  var variants=(c.variants||[]).map(function(v){return esc(v.text)+" ×"+v.count;}).join("、");
  var times=(c.events||[]).slice(0,12).map(function(e){return "<span>"+fmtTime(e.startMs)+"</span>";}).join("");
  if(c.events&&c.events.length>12)times+="<span>… 共 "+c.events.length+" 次</span>";
  var detail=
    (reasons?detailRow("评分",'<ul class="reasons">'+reasons+"</ul>"):"")+
    (variants?detailRow("变体",variants):"")+
    (c.contexts&&c.contexts.length?detailRow("上下文",c.contexts.map(function(s){return highlight(s,c.word);}).join(" / ")):"")+
    (times?detailRow("出现",'<div class="times">'+times+"</div>"):"")+
    (c.ai&&c.ai.reason?detailRow("AI",esc(c.ai.reason)):"")+
    (ev.frames.length>1?detailRow("证据帧",'<div class="frames">'+ev.frames.map(function(f){
      return '<button type="button" class="frame-btn" data-frame="'+esc(f)+'" title="'+frameTime(f)+'">'+frameHtml(f,ev)+"</button>";
    }).join("")+"</div>"):"");
  var nReasons=(c.reasons||[]).length;
  var f0=ev.frames[0];
  card.innerHTML=
    '<label class="pick" title="勾选（X）"><input type="checkbox" class="box" data-i="'+i+'"'+(picked?" checked":"")+(ok?"":" disabled")+' aria-label="勾选 '+esc(c.word)+'"></label>'+
    '<div class="score-cell" title="规则评分"><b>'+c.score+"</b><span>"+TIER_NAME[tier]+"</span></div>"+
    '<div class="body"><div class="head"><h3 class="word">'+esc(c.word)+"</h3>"+badgesHtml(c)+"</div>"+
      '<div class="facts">'+facts.join("")+"</div>"+
      (ctx?'<p class="ctx" title="'+esc(ctx)+'">'+highlight(ctx,c.word)+"</p>":"")+
      (detail?'<details class="more"><summary>证据与理由'+(nReasons?" · "+nReasons+" 条评分":"")+'</summary><div class="more-body">'+detail+"</div></details>":"")+
    "</div>"+
    (f0?'<button type="button" class="thumb" data-frame="'+esc(f0)+'" title="查看证据帧（O）">'+frameHtml(f0,ev)+
      (ev.frames.length>1?'<span class="thumb-more">'+ev.frames.length+" 帧</span>":"")+"</button>":"");
  return card;
}

function currentFilter(){
  var q=$("q").value.trim().toLowerCase();
  var rawMin=$("min-score").value.trim();
  var min=rawMin===""?-Infinity:parseInt(rawMin,10)||0;
  var maxLen=parseInt($("max-len").value||"0",10)||0;
  var minEvents=parseInt($("min-events").value||"0",10)||0;
  var ai=$("ai-filter").value;
  return cands.filter(function(c){
    if((c.score||0)<min)return false;
    if(maxLen&&(c.word||"").length>maxLen)return false;
    if(minEvents&&(c.eventCount||0)<minEvents)return false;
    if(ai==="keep"&&(!c.ai||c.ai.verdict!=="keep"))return false;
    if(ai==="reject"&&(!c.ai||c.ai.verdict!=="reject"))return false;
    if(ai==="none"&&c.ai)return false;
    if(q){
      var hay=(c.word+" "+(c.variants||[]).map(function(v){return v.text;}).join(" ")+" "+(c.contexts||[]).join(" ")).toLowerCase();
      if(hay.indexOf(q)<0)return false;
    }
    return true;
  });
}

function refresh(){
  list.innerHTML="";
  tierUI=[];
  var shown=currentFilter();
  lastShown=shown.length;
  if(!shown.length){
    var empty=document.createElement("div");
    empty.className="empty";
    empty.innerHTML='当前筛选条件下没有候选<button type="button" class="ghost" id="empty-reset">重置筛选</button>';
    list.appendChild(empty);
  }
  var groups={};
  shown.forEach(function(c){var t=tierOf(c);(groups[t]=groups[t]||[]).push(IDX.get(c));});
  var frag=document.createDocumentFragment();
  TIERS.forEach(function(t){
    var idxs=groups[t.id]||[];
    if(!idxs.length)return;
    var isCollapsed=!!collapsed[t.id];
    var head=document.createElement("div");
    head.className="tier-head tier-"+t.cls;
    head.innerHTML='<button type="button" class="tier-toggle" aria-expanded="'+(!isCollapsed)+'"><span class="arrow">▼</span><span class="tier-dot"></span><span class="tier-name">'+t.name+'</span><span class="tier-range">'+tierRange(t.id)+" · "+t.desc+"</span></button>"+
      '<span class="tier-count"></span><button type="button" class="tier-pick ghost"></button>';
    var body=document.createElement("div");
    body.className="tier-body";
    body.hidden=isCollapsed;
    idxs.forEach(function(i){body.appendChild(renderCard(cands[i],i));});
    var toggle=head.querySelector(".tier-toggle");
    head.addEventListener("click",function(ev){
      if(ev.target.closest(".tier-pick"))return;
      collapsed[t.id]=!collapsed[t.id];
      body.hidden=collapsed[t.id];
      toggle.setAttribute("aria-expanded",String(!collapsed[t.id]));
    });
    var ui={idxs:idxs,count:head.querySelector(".tier-count"),btn:head.querySelector(".tier-pick")};
    ui.btn.addEventListener("click",function(){
      var pickable=ui.idxs.filter(function(i){return exportable(cands[i]);});
      var all=pickable.length&&pickable.every(function(i){return checkedState.has(i);});
      var rejectedCount=all?0:pickable.filter(function(i){return cands[i].ai&&cands[i].ai.verdict==="reject";}).length;
      pickable.forEach(function(i){setPicked(i,!all,true);});
      updatePreview();
      toast((all?"已取消":"已勾选")+"「"+t.name+"」组 "+pickable.length+" 项"+(rejectedCount?"；含 "+rejectedCount+" 个 AI 排除项，请人工核实":""));
    });
    tierUI.push(ui);
    frag.appendChild(head);
    frag.appendChild(body);
  });
  list.appendChild(frag);
  updatePreview();
}

function setPicked(i,on,silent){
  if(!exportable(cands[i]))return;
  if(on)checkedState.add(i);else checkedState.delete(i);
  var card=list.querySelector('.card[data-i="'+i+'"]');
  if(card){
    card.classList.toggle("is-picked",on);
    var box=card.querySelector(".pick input");
    if(box)box.checked=on;
  }
  if(!silent)updatePreview();
  if(on&&!silent&&cands[i].ai&&cands[i].ai.verdict==="reject")toast("已人工勾选 AI 排除项，请核实后导出");
}

function exportRecords(){
  var seen=new Set(),out=[],ignored=0;
  cands.forEach(function(c,i){
    var word=String(c.word||"").trim();
    if(!checkedState.has(i)||!word||seen.has(word))return;
    seen.add(word);
    if(!exportable(c)||out.length>=2000){ignored++;return;}
    var weight=report.weightByScore?(c.score>=80?5:c.score>=70?4:c.score>=60?3:null):null;
    out.push({word:word,line:word+(weight!=null?": "+weight:"")});
  });
  return {records:out,ignored:ignored};
}

function stat(n,label,cls){return '<span'+(cls?' class="'+cls+'"':"")+"><b>"+n+"</b>"+label+"</span>";}

function updatePreview(){
  var result=exportRecords(),records=result.records,words=records.map(function(r){return r.word;});
  $("preview-count").textContent=words.length+" 个词";
  $("dock-count").textContent=String(words.length);
  $("preview-body").innerHTML=words.length?records.map(function(r){
    return '<span class="word-chip"><span>'+esc(r.line)+'</span><button type="button" data-word="'+esc(r.word)+'" title="移除" aria-label="移除 '+esc(r.word)+'">×</button></span>';
  }).join(""):'<span class="preview-empty">尚未勾选。点击候选整行即可勾选，或聚焦后按 X。</span>';
  $("export-btn").disabled=!words.length;
  $("copy-btn").disabled=!words.length;
  $("uncheck-all").disabled=!checkedState.size;
  $("check-recommended").disabled=!REC_COUNT;
  $("export-hint").textContent=(report.weightByScore?"按规则分数带附带权重；":"")+"按候选顺序去重，最多导出 2000 个词。"+(result.ignored?"已忽略 "+result.ignored+" 个超限或不可导出词；移除前项可让后项进入导出。":"点 × 可移除单个词。");
  tierUI.forEach(function(ui){
    var pickable=ui.idxs.filter(function(i){return exportable(cands[i]);});
    var n=pickable.filter(function(i){return checkedState.has(i);}).length;
    ui.count.textContent=(n?n+" / ":"")+ui.idxs.length;
    ui.count.title=n?"已选 "+n+" / 共 "+ui.idxs.length:"共 "+ui.idxs.length+" 个";
    ui.btn.textContent=pickable.length&&n===pickable.length?"取消本组":"全选本组";
    ui.btn.disabled=!pickable.length;
  });
  $("stats").innerHTML=stat(cands.length,"候选")+stat(lastShown,"显示")+stat(REC_COUNT,"推荐")+
    (report.aiEnabled?stat(KEEP_COUNT,"AI 保留"):"")+stat(words.length,"已选","stat-picked");
}

var toastTimer=null;
function toast(msg){
  var el=$("toast");
  el.textContent=msg;
  el.classList.add("show");
  if(toastTimer)clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){el.classList.remove("show");},2200);
}

function resetFilters(){
  Object.keys(FILTER_DEFAULTS).forEach(function(id){$(id).value=FILTER_DEFAULTS[id];});
  refresh();
}

$("check-recommended").addEventListener("click",function(){
  var n=0;
  cands.forEach(function(c,i){if(recommended(c)&&exportable(c)){setPicked(i,true,true);n++;}});
  updatePreview();
  toast(n?"已勾选 "+n+" 个推荐项":"没有可导出的推荐项");
});
$("uncheck-all").addEventListener("click",function(){
  Array.from(checkedState).forEach(function(i){setPicked(i,false,true);});
  updatePreview();
  toast("已清空勾选");
});
$("reset-filters").addEventListener("click",resetFilters);
$("preview-body").addEventListener("click",function(ev){
  var b=ev.target.closest("button[data-word]");
  if(!b)return;
  var w=b.dataset.word;
  cands.forEach(function(c,i){if(c.word===w)setPicked(i,false,true);});
  updatePreview();
});
$("dock-toggle").addEventListener("click",function(){
  var on=$("dock").classList.toggle("expanded");
  this.setAttribute("aria-expanded",String(on));
});
$("theme-btn").addEventListener("click",function(){
  var root=document.documentElement;
  var next=root.dataset.theme==="light"?"dark":"light";
  root.dataset.theme=next;
  try{localStorage.setItem("maw-term-report-theme",next);}catch(e){}
});
var compactBox=$("compact-toggle");
compactBox.checked=document.documentElement.classList.contains("compact");
function setCompact(on){
  var anchor=document.activeElement&&document.activeElement.closest?document.activeElement.closest(".card"):null;
  document.documentElement.classList.toggle("compact",on);
  compactBox.checked=on;
  try{localStorage.setItem("maw-term-report-compact",on?"1":"0");}catch(e){}
  if(anchor)anchor.scrollIntoView({block:"nearest"});
}
compactBox.addEventListener("change",function(){setCompact(compactBox.checked);});

var qTimer=null;
["q","min-score","max-len","min-events","ai-filter"].forEach(function(id){
  $(id).addEventListener(id==="q"?"input":"change",function(){
    if(id!=="q"){refresh();return;}
    if(qTimer)clearTimeout(qTimer);
    qTimer=setTimeout(function(){qTimer=null;refresh();},180);
  });
});
var wheelDefaults={"min-score":"0","max-len":"12","min-events":"0"};
["min-score","max-len","min-events"].forEach(function(id){
  var el=$(id);
  el.addEventListener("wheel",function(ev){
    ev.preventDefault();
    if(el.value===""||el.value==null)el.value=wheelDefaults[id]||"0";
    try{if(ev.deltaY<0)el.stepUp();else el.stepDown();}catch(err){return;}
    el.dispatchEvent(new Event("change"));
  },{passive:false});
});

list.addEventListener("change",function(ev){
  var t=ev.target;
  if(t&&t.type==="checkbox"&&t.dataset.i!=null)setPicked(parseInt(t.dataset.i,10),t.checked);
});
list.addEventListener("click",function(ev){
  var t=ev.target;
  if(t.id==="empty-reset"){resetFilters();return;}
  var fb=t.closest("[data-frame]");
  var card=t.closest(".card");
  if(fb){if(card)openOverlay(parseInt(card.dataset.i,10),fb.dataset.frame);return;}
  if(!card||t.closest(".pick,button,a,summary,.more-body,input"))return;
  var sel=window.getSelection?String(window.getSelection()):"";
  if(sel)return;
  var i=parseInt(card.dataset.i,10);
  if(!exportable(cands[i])){toast("该词超出热词限制，不能导出");return;}
  setPicked(i,!checkedState.has(i));
});

function exportText(result){return result.records.map(function(r){return r.line;}).join("\\n");}
function exportNotice(result){return result.ignored?"；已忽略 "+result.ignored+" 个超限或不可导出词":"";}
$("export-btn").addEventListener("click",function(){
  var result=exportRecords();
  if(!result.records.length)return;
  var blob=new Blob([exportText(result)+"\\n"],{type:"text/plain;charset=utf-8"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);a.download="hotwords.txt";a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);},2000);
  toast("已发起 hotwords.txt 下载："+result.records.length+" 个词"+exportNotice(result));
});
$("copy-btn").addEventListener("click",function(){
  var result=exportRecords(),text=exportText(result);
  if(!text)return;
  var n=text.split("\\n").length;
  var done=function(){toast("已复制 "+n+" 个术语"+exportNotice(result));};
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done,function(){fallbackCopy(text,done);});
  }else{fallbackCopy(text,done);}
});
function fallbackCopy(text,done){
  var ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);
  ta.select();
  try{if(document.execCommand("copy"))done();else toast("复制失败，请改用导出 txt");}catch(e){toast("复制失败，请改用导出 txt");}
  document.body.removeChild(ta);
}

var ov={card:-1,frames:[],index:0};
function overlayOpen(){return $("overlay").classList.contains("open");}
function openOverlay(i,frame){
  var frames=EV[i]&&EV[i].frames||[];
  if(!frames.length)return;
  ov.card=i;ov.frames=frames;
  var k=frames.indexOf(frame);
  showOverlay(k<0?0:k);
  $("overlay").classList.add("open");
  document.body.classList.add("overlay-open");
  $("overlay").focus({preventScroll:true});
}
function showOverlay(index){
  var n=ov.frames.length;
  if(!n)return;
  ov.index=(index+n)%n;
  var f=ov.frames[ov.index];
  $("overlay-img").src=frameUrl(f);
  $("overlay-rects").innerHTML=rectsHtml(EV[ov.card].rects[f]);
  $("overlay-word").textContent=cands[ov.card].word;
  $("overlay-count").textContent=(n>1?(ov.index+1)+" / "+n+" · ":"")+frameTime(f);
  $("overlay-prev").hidden=n<2;
  $("overlay-next").hidden=n<2;
  syncOverlayPick();
  [ov.index-1,ov.index+1].forEach(function(k){
    var nf=ov.frames[(k+n)%n];
    if(nf&&nf!==f){var pre=new Image();pre.src=frameUrl(nf);}
  });
}
function syncOverlayPick(){
  var b=$("overlay-pick"),ok=exportable(cands[ov.card]),on=checkedState.has(ov.card);
  b.disabled=!ok;
  b.textContent=!ok?"不可导出":on?"✓ 已勾选（X）":"勾选（X）";
  b.classList.toggle("primary",on);
}
function toggleOverlayPick(){
  if(!exportable(cands[ov.card]))return;
  setPicked(ov.card,!checkedState.has(ov.card));
  syncOverlayPick();
}
function closeOverlay(){
  $("overlay").classList.remove("open");
  document.body.classList.remove("overlay-open");
  var card=list.querySelector('.card[data-i="'+ov.card+'"]');
  if(card)card.focus({preventScroll:true});
}
$("overlay").addEventListener("click",function(ev){
  if(ev.target===this||ev.target.classList.contains("overlay-bar"))closeOverlay();
});
$("overlay-close").addEventListener("click",closeOverlay);
$("overlay-pick").addEventListener("click",toggleOverlayPick);
$("overlay-prev").addEventListener("click",function(){showOverlay(ov.index-1);});
$("overlay-next").addEventListener("click",function(){showOverlay(ov.index+1);});

function visibleCards(){
  return [].filter.call(list.querySelectorAll(".card"),function(el){return el.offsetParent!==null;});
}
function moveFocus(card,d){
  var cs=visibleCards();
  if(!cs.length)return;
  var k=card?cs.indexOf(card):-1;
  var next=k<0?cs[d>0?0:cs.length-1]:cs[Math.min(cs.length-1,Math.max(0,k+d))];
  next.focus({preventScroll:true});
  next.scrollIntoView({block:"nearest"});
}
document.addEventListener("keydown",function(ev){
  var t=ev.target;
  var typing=t&&((t.tagName==="INPUT"&&t.type!=="checkbox")||t.tagName==="SELECT"||t.tagName==="TEXTAREA"||t.isContentEditable);
  if(ev.ctrlKey||ev.metaKey||ev.altKey)return;
  if(t===compactBox&&ev.key===" ")return;
  if(overlayOpen()){
    if(typing)return;
    if(ev.key==="ArrowLeft"){ev.preventDefault();showOverlay(ov.index-1);}
    else if(ev.key==="ArrowRight"){ev.preventDefault();showOverlay(ov.index+1);}
    else if(ev.key==="Escape"){ev.preventDefault();closeOverlay();}
    else if(ev.key==="x"||ev.key==="X"){ev.preventDefault();toggleOverlayPick();}
    return;
  }
  if(typing){
    if(ev.key==="Escape"&&t.id==="q")t.blur();
    return;
  }
  var card=t&&t.closest?t.closest(".card"):null;
  var key=ev.key;
  if(key==="/"){ev.preventDefault();$("q").focus();$("q").select();}
  else if(key==="v"||key==="V"){ev.preventDefault();setCompact(!compactBox.checked);}
  else if(key==="j"||key==="J"){ev.preventDefault();moveFocus(card,1);}
  else if(key==="k"||key==="K"){ev.preventDefault();moveFocus(card,-1);}
  else if(card&&(key==="x"||key==="X"||(key===" "&&t===card))){
    ev.preventDefault();
    var i=parseInt(card.dataset.i,10);
    setPicked(i,!checkedState.has(i));
  }
  else if(card&&(key==="o"||key==="O"||(key==="Enter"&&t===card))){
    ev.preventDefault();
    openOverlay(parseInt(card.dataset.i,10));
  }
});

var topBar=document.querySelector(".top");
var dockPanel=document.querySelector(".export");
var narrow=window.matchMedia("(max-width:959px)");
function syncLayout(){
  var root=document.documentElement.style;
  var sticky=getComputedStyle(topBar).position==="sticky";
  root.setProperty("--top-stick",(sticky?topBar.offsetHeight:0)+"px");
  root.setProperty("--dock-h",(narrow.matches?dockPanel.offsetHeight:0)+"px");
}
if(window.ResizeObserver){var ro=new ResizeObserver(syncLayout);ro.observe(topBar);ro.observe(dockPanel);}
window.addEventListener("resize",syncLayout);
syncLayout();

var scan=report.scan||{};
function srcRow(k,v){return "<dt>"+k+"</dt><dd>"+esc(v)+"</dd>";}
$("src-name").textContent=(report.video||"")+
  (!report.aiEnabled?" · "+(report.aiStatus==="failed"?"AI 失败":report.aiStatus==="pending"?"AI 待完成":report.aiStatus==="cancelled"?"AI 已取消":"未启用 AI")+"，仅规则评分":"")+
  (scan.truncated?" · 扫描已截断":"")+(scan.framesFailed?" · 部分帧失败":"");
$("src-name").title=$("src-name").textContent;
$("source").innerHTML=
  srcRow("视频",report.video||"—")+
  srcRow("扫描",(scan.framesScanned!=null?scan.framesScanned+" / "+(scan.framesTotal||0)+" 帧 · ":"")+"fps "+report.fps)+
  srcRow("OCR",report.model||"—")+
  srcRow("区域",report.region?report.region.mode+(report.region.mode==="custom"?" · "+[report.region.x1,report.region.y1,report.region.x2,report.region.y2].join(", "):""):"未记录")+
  srcRow("扫描边界",(scan.truncated?"已截断：计划 "+scan.framesTotal+" / 全片 "+scan.framesPlanned+" 帧；采样至 "+fmtTime(scan.sampledThroughMs):"未标记截断")+(scan.framesFailed?"；失败 "+scan.framesFailed+" 帧":""))+
  srcRow("AI 筛选",report.aiEnabled?(report.aiModel||"已启用"):(report.aiStatus==="failed"?"失败；仅规则评分":report.aiStatus==="pending"?"待完成；仅规则评分":report.aiStatus==="cancelled"?"已取消；仅规则评分":"未启用；仅规则评分"))+
  srcRow("推荐线",line+" 分")+
  srcRow("生成于",String(report.createdAt||"—").replace("T"," "));

refresh();
})();
</script>
</body>
</html>
"""
