"""Synthetic, API-free projects for offline translation review browser tests."""
from __future__ import annotations

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from maw.postprocess import LlmPostprocessRequest, OutputMode, merge_bilingual_project, run_llm_postprocess
from maw.postprocess_io import read_project, write_artifacts
from maw.project import normalize_project


def main():
    if sys.argv[1] == "--validate":
        read_project(Path(sys.argv[2]))
        return
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    source = {"schema": "moy.asr.project.v1", "segments": [
        {"id": "main-001", "start": 0, "end": 1000, "text": "介绍 API。", "items": [{"start": 0, "end": 1000, "text": "介绍 API。"}]},
        {"id": "main-002", "start": 1200, "end": 2500, "text": "它可以处理字幕。"},
    ], "user_metadata": {"example": "保留元数据"},
        "markers": {"schema": "moy.asr.markers.v1", "items": [{"id": "user-marker", "start": 100, "note": "用户备注", "name": "用户", "color": "#3e63dd"}]},
        "overlay_track": {"enabled": False, "segments": [{"id": "overlay", "start": 0, "end": 800, "text": "隐藏轨"}]}}
    cases = {}
    for mode in ("single", "backfill", "bilingual"):
        path = directory / f"fixture-{mode}-source.mosp"
        path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
        def complete(_prompt, cues):
            return {"groups": [{"id": row["id"], "text": "Introduce the API." if row["id"] == "c0001" else "It processes subtitles."} for row in cues],
                    "annotations": [
                        {"source_ids": ["c0001"], "kind": "note", "message": "API 指接口；<script>window.__bad=true</script>"},
                        {"source_ids": ["c0002"], "kind": "review", "message": "It 的指代需要结合上下文确认"}]}
        artifact = run_llm_postprocess(LlmPostprocessRequest(path, None, OutputMode.BOTH, "translate_en", "", generate_comparison=True,
                                      merge_bilingual=mode == "bilingual", embed_translations=mode == "backfill", bilingual_line_order="original_first"), complete=complete)
        cases[mode] = {"html": str(artifact.comparison_path), "project": str(artifact.project_path)}
    boundary_source = normalize_project({"segments": [
        {"id": "main-space", "start": 0, "end": 1000, "text": " API "},
        {"id": "main-token", "start": 1200, "end": 2500, "text": "{{REVIEW_SCRIPT}} {{DATA}} <script>window.__bad=true</script>"},
    ], "user_metadata": {"literal": "{{REVIEW_SCRIPT}} {{DATA}}"}})
    boundary_translation = normalize_project({"segments": [
        {"id": "main-space", "start": 0, "end": 1000, "text": "API"},
        {"id": "main-token", "start": 1200, "end": 2500, "text": "translated {{REVIEW_SCRIPT}} {{DATA}}"},
    ]})
    boundary_result = merge_bilingual_project(boundary_source, boundary_translation, translation_target="en", line_order="original_first")
    artifact = write_artifacts(boundary_result, source_project_path=directory / "fixture-boundary-source.mosp",
                               source_srt_path=None, operation="translate_en-bilingual",
                               write_project=True, write_srt=True, comparison_source=boundary_source,
                               comparison_translation=boundary_translation, bilingual_line_order="original_first")
    cases["boundary"] = {"html": str(artifact.comparison_path), "project": str(artifact.project_path)}
    (directory / "cases.json").write_text(json.dumps(cases, ensure_ascii=False), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
