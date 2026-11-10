"""candidates.json / report.csv / report.html（人工确认页）生成。"""

from __future__ import annotations

import csv
import io
import json
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
) -> dict[str, object]:
    candidate_list = [dict(candidate) for candidate in candidates]
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
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def write_report_csv(path: Path, candidates: Sequence[Mapping[str, object]]) -> None:
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
    data_json = json.dumps(report, ensure_ascii=False).replace("</", "<\\/")
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
<style>
:root{--ink:#1c2733;--muted:#66727f;--line:#dbe3e9;--accent:#0f766e;--warn:#b45309;--bad:#b91c1c;--bg:#f5f7f9;--card:#fff;}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 "Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;color:var(--ink);background:var(--bg)}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;box-shadow:0 1px 4px rgba(16,32,48,.06)}
header h1{font-size:15px;margin:0 12px 0 0}
.chip{background:#eef4f3;color:var(--accent);border-radius:12px;padding:2px 10px;font-size:12px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-left:auto}
.controls input[type=search],.controls input[type=number],.controls select{padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;font-size:13px}
.controls input[type=number]{cursor:ns-resize}
button{padding:5px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:hover{filter:brightness(.97)}
main{max-width:1080px;margin:16px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;content-visibility:auto;contain-intrinsic-size:auto 190px}
@media print{.card{content-visibility:visible}}
.card.off{opacity:.55}
.card input[type=checkbox]{width:24px;height:24px;accent-color:var(--accent);cursor:pointer;flex:none}
.card .pick{grid-row:1/span 2;display:flex;align-items:flex-start;cursor:pointer;padding-right:2px}
.head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.word{font-size:17px;font-weight:600}
.score{font-weight:700;color:var(--accent)}
.badge{font-size:12px;border:1px solid var(--line);border-radius:10px;padding:1px 8px;color:var(--muted)}
.badge.ai-keep{border-color:#9ec9c3;color:var(--accent)}
.badge.ai-reject{border-color:#e5b9b9;color:var(--bad)}
.badge.rec{border-color:var(--accent);color:var(--accent)}
.badge.noexport{border-color:#eec9a0;color:var(--warn)}
.meta{color:var(--muted);font-size:12.5px;margin-top:2px}
.tier-head{display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 10px;background:var(--card);border:1px solid var(--line);border-left-width:4px;border-radius:8px;user-select:none;font-size:13px}
.tier-head .arrow{width:14px;color:var(--muted)}
.tier-dot{width:10px;height:10px;border-radius:50%;flex:none}
.tier-head.tier-rec{border-left-color:var(--accent)}.tier-head.tier-rec .tier-dot{background:var(--accent)}
.tier-head.tier-maybe{border-left-color:var(--warn)}.tier-head.tier-maybe .tier-dot{background:var(--warn)}
.tier-head.tier-weak{border-left-color:#64748b}.tier-head.tier-weak .tier-dot{background:#64748b}
.tier-head.tier-noise{border-left-color:var(--muted)}.tier-head.tier-noise .tier-dot{background:var(--muted)}
.tier-range{color:var(--muted);font-size:12px}
.tier-count{color:var(--muted);font-size:12px;margin-left:auto}
.tier-body{margin-top:8px}
.card.tier-rec{border-left:4px solid var(--accent)}
.card.tier-maybe{border-left:4px solid var(--warn)}
.card.tier-weak{border-left:4px solid #64748b}
.card.tier-noise{border-left:4px solid var(--muted);opacity:.72}
.empty{color:var(--muted);text-align:center;padding:24px 0}
details{margin-top:6px}
summary{cursor:pointer;color:var(--muted);font-size:12.5px}
.reasons li{font-size:12.5px;color:var(--muted);list-style:none}
.reasons .plus{color:var(--accent);font-weight:600}
.reasons .minus{color:var(--bad);font-weight:600}
.frames{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.frame-wrap{position:relative;display:inline-block;line-height:0}
.frames img{height:90px;width:auto;border:1px solid var(--line);border-radius:6px;cursor:zoom-in;display:block}
.frame-rect,.overlay-rects i{position:absolute;border:2px solid #e11d48;outline:1px solid rgba(255,255,255,.65);border-radius:2px;pointer-events:none}
.times{font-size:12px;color:var(--muted)}
.overlay{position:fixed;inset:0;background:rgba(12,20,28,.82);display:none;align-items:center;justify-content:center;z-index:9;cursor:zoom-out}
.overlay-wrap{position:relative;display:inline-block;line-height:0}
.overlay img{max-width:92vw;max-height:88vh;border-radius:8px;display:block}
.overlay-rects i{border-width:3px;border-radius:3px}
.overlay-nav{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.35);font-size:30px;line-height:1;z-index:2}
.overlay-nav:hover{background:rgba(255,255,255,.25)}
#overlay-prev{left:20px}
#overlay-next{right:20px}
.overlay-count{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:rgba(12,20,28,.72);color:#fff;font-size:12.5px;padding:2px 10px;border-radius:10px;pointer-events:none}
footer{max-width:1080px;margin:0 auto 28px;padding:0 16px;color:var(--muted);font-size:12px}
.preview{max-width:1080px;margin:12px auto 0;padding:0 16px}
.preview-head{display:flex;gap:8px;align-items:center;font-size:13px}
.preview-hint{color:var(--muted);font-size:12px}
.preview pre{margin:6px 0 0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;max-height:150px;overflow:auto;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:var(--ink)}
</style>
</head>
<body>
<header>
  <h1>术语提取确认页</h1>
  <span class="chip" id="stat-chip">…</span>
  <div class="controls">
    <input type="search" id="q" placeholder="搜索词/变体/上下文">
    <label>最低分数 <input type="number" id="min-score" value="" placeholder="不限" step="5" title="留空不限；可键入、滚轮悬停调整（±5）" style="width:64px"></label>
    <label>最多字数 <input type="number" id="max-len" value="12" min="1" title="超过该长度的候选默认隐藏（疑似整句字幕或 UI 文案）；清空显示全部；滚轮可调（±1）" style="width:64px"></label>
    <label>最少出现次数 <input type="number" id="min-events" value="0" min="0" title="按独立显示事件数过滤；滚轮可调（±1）" style="width:64px"></label>
    <select id="ai-filter">
      <option value="">全部 AI 判定</option>
      <option value="keep">AI 保留</option>
      <option value="reject">AI 排除</option>
      <option value="none">未筛选</option>
    </select>
    <button id="check-recommended">勾选推荐项</button>
    <button id="uncheck-all">清空勾选</button>
    <button id="export-btn" class="primary">导出热词 txt</button>
    <button id="copy-btn">复制清单</button>
  </div>
</header>
<section class="preview">
  <div class="preview-head"><b>导出预览</b><span class="chip" id="preview-count">0 个词</span><span class="preview-hint">随勾选实时更新，与「导出热词 txt」内容一致</span></div>
  <pre id="preview-body">（尚未勾选候选）</pre>
</section>
<main id="list"></main>
<footer id="foot"></footer>
<div class="overlay" id="overlay"><button class="overlay-nav" id="overlay-prev" title="上一张（←）">‹</button><div class="overlay-wrap"><img id="overlay-img" alt="证据帧大图"><div class="overlay-rects" id="overlay-rects"></div></div><button class="overlay-nav" id="overlay-next" title="下一张（→）">›</button><div class="overlay-count" id="overlay-count"></div></div>
<script type="application/json" id="candidate-data">__DATA_JSON__</script>
<script>
(function(){
"use strict";
var report=JSON.parse(document.getElementById("candidate-data").textContent);
var list=document.getElementById("list");
var boxes={};

function fmtTime(ms){var s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}

function rectStyle(r){
  return "left:"+(r[0]*100).toFixed(2)+"%;top:"+(r[1]*100).toFixed(2)+"%;width:"+(r[2]*100).toFixed(2)+"%;height:"+(r[3]*100).toFixed(2)+"%";
}
function rectsHtml(rects){
  return (rects||[]).map(function(r){return '<i style="'+rectStyle(r)+'"></i>';}).join("");
}

function renderCard(c,index){
  var card=document.createElement("div");
  card.className="card"+(c.export&&!c.export.ok?" off":"");
  var ai=c.ai||null;
  var reasons=(c.reasons||[]).map(function(r){
    return '<li><span class="'+(r.delta>=0?"plus":"minus")+'">'+(r.delta>=0?"+":"")+r.delta+"</span> "+esc(r.detail)+"</li>";
  }).join("");
  var variants=(c.variants||[]).map(function(v){return esc(v.text)+"×"+v.count;}).join("、");
  var byFrame={}, sizeByFrame={};
  (c.events||[]).forEach(function(e){(e.evidence||[]).forEach(function(v){
    if(!v||!v.frame)return;
    if(!byFrame[v.frame])byFrame[v.frame]=[];
    if(v.rect)byFrame[v.frame].push(v.rect);
    if(v.frameSize)sizeByFrame[v.frame]=v.frameSize;
  });});
  var frames=Object.keys(byFrame).slice(0,4);
  var times=(c.events||[]).slice(0,6).map(function(e){return fmtTime(e.startMs);}).join(" ");
  if(c.events&&c.events.length>6)times+=" …共"+c.events.length+"次";
  var badgeExport=c.export&&!c.export.ok?' <span class="badge noexport">不可导出：'+esc(c.export.reason)+"</span>":"";
  var badgeRec=c.recommended?' <span class="badge rec">推荐</span>':"";
  var badgeAi=ai?' <span class="badge ai-'+ai.verdict+'">AI '+(ai.verdict==="keep"?"保留":"排除")+"·"+esc(ai.type)+"</span>":' <span class="badge">AI 未判定</span>';
  card.innerHTML=
    '<label class="pick"><input type="checkbox" data-i="'+index+'"'+(c.export&&!c.export.ok?" disabled":"")+"></label>"+
    '<div><div class="head"><span class="word">'+esc(c.word)+'</span>'+
      '<span class="score">'+c.score+"分</span>"+
      (c.typeGuess?'<span class="badge">'+esc(c.typeGuess)+"</span>":"")+
      badgeRec+badgeAi+badgeExport+"</div>"+
    '<div class="meta">独立事件 '+c.eventCount+" 次 · 命中 "+c.hitCount+" 次 · 平均置信度 "+(c.avgConf||0).toFixed(2)+
      (variants?" · 变体："+esc(variants):"")+"</div>"+
    (reasons||c.contexts&&c.contexts.length||frames.length?
      '<details><summary>证据与理由</summary><ul class="reasons">'+reasons+"</ul>"+
      (c.contexts&&c.contexts.length?'<div class="meta">上下文：'+c.contexts.map(esc).join(" / ")+"</div>":"")+
      (frames.length?'<div class="frames">'+frames.map(function(f){
        var sz=sizeByFrame[f]||[];
        var dims=sz.length?' width="'+sz[0]+'" height="'+sz[1]+'"':"";
        return '<span class="frame-wrap"><img loading="lazy" decoding="async"'+dims+' src="frames/'+esc(f)+'" data-frame="'+esc(f)+'" alt="证据帧">'+rectsHtml(byFrame[f])+"</span>";
      }).join("")+"</div>":"")+
      (times?'<div class="times">出现时间 '+times+"</div>":"")+
      (ai&&ai.reason?'<div class="meta">AI 理由：'+esc(ai.reason)+"</div>":"")+
      "</details>":"");
  return card;
}

function currentFilter(){
  var q=document.getElementById("q").value.trim().toLowerCase();
  var rawMin=document.getElementById("min-score").value.trim();
  var min=rawMin===""?-Infinity:parseInt(rawMin,10)||0;
  var maxLen=parseInt(document.getElementById("max-len").value||"0",10)||0;
  var minEvents=parseInt(document.getElementById("min-events").value||"0",10)||0;
  var ai=document.getElementById("ai-filter").value;
  return report.candidates.filter(function(c){
    if((c.score||0)<min)return false;
    if(maxLen&&(c.word||"").length>maxLen)return false;
    if(minEvents&&(c.eventCount||0)<minEvents)return false;
    if(ai==="keep"&&(!c.ai||c.ai.verdict!=="keep"))return false;
    if(ai==="reject"&&(!c.ai||c.ai.verdict!=="reject"))return false;
    if(ai==="none"&&c.ai)return false;
    if(q){
      var hay=(c.word+" "+(c.variants||[]).map(function(v){return v.text;}).join(" ")+(c.contexts||[]).join(" ")).toLowerCase();
      if(hay.indexOf(q)<0)return false;
    }
    return true;
  });
}

var TIERS=[
  {id:"rec",name:"推荐",desc:"达到推荐线",cls:"rec"},
  {id:"maybe",name:"待定",desc:"接近推荐线",cls:"maybe"},
  {id:"weak",name:"观察",desc:"信号较弱",cls:"weak"},
  {id:"noise",name:"排除",desc:"忽略词、整句等负面评分",cls:"noise"}
];
var collapsed={weak:true,noise:true};
function tierOf(c){
  var s=c.score||0,line=report.minScore||60;
  if(s>=line)return "rec";
  if(s>=line-20)return "maybe";
  if(s>0)return "weak";
  return "noise";
}
function tierRange(id,line){
  if(id==="rec")return "≥"+line+" 分";
  if(id==="maybe")return (line-20)+"–"+(line-1)+" 分";
  if(id==="weak")return "1–"+Math.max(line-21,0)+" 分";
  return "≤0 分";
}

function refresh(){
  var checkedState={};
  Object.keys(boxes).forEach(function(i){if(boxes[i]&&boxes[i].checked)checkedState[i]=true;});
  list.innerHTML="";
  var shown=currentFilter();
  if(!shown.length){
    var empty=document.createElement("div");
    empty.className="empty";
    empty.textContent="当前筛选条件下没有候选";
    list.appendChild(empty);
  }
  var groups={};
  shown.forEach(function(c){(groups[tierOf(c)]=groups[tierOf(c)]||[]).push(c);});
  TIERS.forEach(function(t){
    var items=groups[t.id]||[];
    if(!items.length)return;
    var head=document.createElement("div");
    head.className="tier-head tier-"+t.cls;
    head.innerHTML='<span class="arrow">▾</span><span class="tier-dot"></span><b>'+t.name+"</b>"+
      '<span class="tier-range">'+tierRange(t.id,report.minScore||60)+" · "+t.desc+'</span>'+
      '<span class="tier-count">'+items.length+" 个</span>";
    var body=document.createElement("div");
    body.className="tier-body";
    function toggle(){
      collapsed[t.id]=!collapsed[t.id];
      body.style.display=collapsed[t.id]?"none":"";
      head.querySelector(".arrow").textContent=collapsed[t.id]?"▸":"▾";
    }
    head.addEventListener("click",toggle);
    if(collapsed[t.id]){body.style.display="none";head.querySelector(".arrow").textContent="▸";}
    items.forEach(function(c){
      var index=report.candidates.indexOf(c);
      var card=renderCard(c,index);
      card.classList.add("tier-"+t.cls);
      body.appendChild(card);
      var box=card.querySelector("input[type=checkbox]");
      if(checkedState[index])box.checked=true;
      boxes[index]=box;
    });
    list.appendChild(head);
    list.appendChild(body);
  });
  var kept=shown.filter(function(c){return c.ai&&c.ai.verdict==="keep";}).length;
  document.getElementById("stat-chip").textContent=
    "候选 "+report.candidates.length+" · 当前显示 "+shown.length+" · 推荐 "+
    report.candidates.filter(function(c){return c.recommended;}).length+" · AI 保留 "+kept;
  document.getElementById("foot").textContent=
    (report.video||"")+" · fps "+report.fps+" · "+(report.model||"")+" · AI 筛选"+(report.aiEnabled?"（"+(report.aiModel||"已启用")+"）":"未启用")+
    " · 推荐线 "+report.minScore+" 分 · 勾选后在右上导出，输出文件 hotwords.txt";
  updatePreview();
}

function selected(){
  return report.candidates.filter(function(c,i){return boxes[i]&&boxes[i].checked;});
}

document.getElementById("check-recommended").addEventListener("click",function(){
  Object.keys(boxes).forEach(function(i){var c=report.candidates[i];boxes[i].checked=!!(c.recommended&&!boxes[i].disabled);});
  updatePreview();
});
document.getElementById("uncheck-all").addEventListener("click",function(){
  Object.keys(boxes).forEach(function(i){boxes[i].checked=false;});
  updatePreview();
});
var qTimer=null;
["q","min-score","max-len","min-events","ai-filter"].forEach(function(id){
  document.getElementById(id).addEventListener(id==="q"?"input":"change",function(){
    if(id!=="q"){refresh();return;}
    if(qTimer)clearTimeout(qTimer);
    qTimer=setTimeout(function(){qTimer=null;refresh();},180);
  });
});
var wheelDefaults={"min-score":"0","max-len":"12","min-events":"0"};
["min-score","max-len","min-events"].forEach(function(id){
  var el=document.getElementById(id);
  el.addEventListener("wheel",function(ev){
    ev.preventDefault();
    if(el.value===""||el.value==null)el.value=wheelDefaults[id]||"0";
    try{if(ev.deltaY<0)el.stepUp();else el.stepDown();}catch(err){return;}
    el.dispatchEvent(new Event("change"));
  },{passive:false});
});
function updatePreview(){
  var picked=selected();
  var words=picked.map(function(c){return c.word;}).filter(function(w,i,a){return w&&a.indexOf(w)===i;});
  document.getElementById("preview-count").textContent=words.length+" 个词";
  document.getElementById("preview-body").textContent=words.length?words.join("\\n"):"（尚未勾选候选）";
}
list.addEventListener("change",function(ev){
  if(ev.target&&ev.target.type==="checkbox")updatePreview();
});
document.getElementById("export-btn").addEventListener("click",function(){
  var picked=selected();
  if(!picked.length){alert("请先勾选要保留的术语");return;}
  var lines=picked.map(function(c){return c.word;}).filter(function(w,i,a){return w&&a.indexOf(w)===i;});
  var blob=new Blob([lines.join("\\n")+"\\n"],{type:"text/plain;charset=utf-8"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);a.download="hotwords.txt";a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);},2000);
});
document.getElementById("copy-btn").addEventListener("click",function(){
  var picked=selected();
  if(!picked.length){alert("请先勾选要保留的术语");return;}
  var text=picked.map(function(c){return c.word;}).filter(function(w,i,a){return w&&a.indexOf(w)===i;}).join("\\n");
  var done=function(){alert("已复制 "+text.split("\\n").length+" 个术语");};
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done,function(){fallbackCopy(text,done);});
  }else{fallbackCopy(text,done);}
});
function fallbackCopy(text,done){
  var ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);
  ta.select();try{document.execCommand("copy");done();}catch(e){alert("复制失败，请手动导出 txt");}document.body.removeChild(ta);
}
var rectsByFrame={};
report.candidates.forEach(function(c){(c.events||[]).forEach(function(e){(e.evidence||[]).forEach(function(v){
  if(v&&v.frame&&v.rect){(rectsByFrame[v.frame]=rectsByFrame[v.frame]||[]).push(v.rect);}
});});});
var overlayFrames=[],overlayIndex=0;
function showOverlay(index){
  if(!overlayFrames.length)return;
  overlayIndex=(index+overlayFrames.length)%overlayFrames.length;
  var frame=overlayFrames[overlayIndex];
  document.getElementById("overlay-img").src="frames/"+frame;
  document.getElementById("overlay-rects").innerHTML=rectsHtml(rectsByFrame[frame]);
  var single=overlayFrames.length<2;
  document.getElementById("overlay-prev").style.display=single?"none":"";
  document.getElementById("overlay-next").style.display=single?"none":"";
  document.getElementById("overlay-count").textContent=single?"":(overlayIndex+1)+" / "+overlayFrames.length;
  document.getElementById("overlay").style.display="flex";
  [overlayIndex-1,overlayIndex+1].forEach(function(i){
    var f=overlayFrames[(i+overlayFrames.length)%overlayFrames.length];
    if(f){var pre=new Image();pre.src="frames/"+f;}
  });
}
function closeOverlay(){document.getElementById("overlay").style.display="none";}
list.addEventListener("click",function(ev){
  var img=ev.target&&ev.target.dataset&&ev.target.dataset.frame?ev.target:null;
  if(!img)return;
  var card=img.closest(".card");
  overlayFrames=[].map.call(card?card.querySelectorAll(".frames img"):[],function(el){return el.dataset.frame;});
  if(overlayFrames.indexOf(img.dataset.frame)<0)overlayFrames=[img.dataset.frame];
  showOverlay(overlayFrames.indexOf(img.dataset.frame));
});
document.getElementById("overlay").addEventListener("click",function(ev){
  if(ev.target.closest(".overlay-wrap")||ev.target.closest(".overlay-nav"))return;
  closeOverlay();
});
document.getElementById("overlay-prev").addEventListener("click",function(ev){ev.stopPropagation();showOverlay(overlayIndex-1);});
document.getElementById("overlay-next").addEventListener("click",function(ev){ev.stopPropagation();showOverlay(overlayIndex+1);});
document.addEventListener("keydown",function(ev){
  if(document.getElementById("overlay").style.display!=="flex")return;
  var t=ev.target;
  if(t&&(t.tagName==="INPUT"||t.tagName==="SELECT"||t.tagName==="TEXTAREA"||t.isContentEditable))return;
  if(ev.key==="ArrowLeft"){ev.preventDefault();showOverlay(overlayIndex-1);}
  else if(ev.key==="ArrowRight"){ev.preventDefault();showOverlay(overlayIndex+1);}
  else if(ev.key==="Escape"){closeOverlay();}
});
refresh();
})();
</script>
</body>
</html>
"""
