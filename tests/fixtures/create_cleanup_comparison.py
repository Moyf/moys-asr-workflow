"""Generate a real offline cleanup comparison from a deterministic response."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup import AiCleanupRequest, run_ai_cleanup


directory = Path(sys.argv[1])
source = directory / "source.mosp"
texts = ["这个这个方法", "这个不能公开", "最终完成"]
segments = []
for index, text in enumerate(texts):
    start = index * 3000
    segments.append({"id": f"s{index + 1}", "start": start, "end": start + len(text) * 200, "text": text,
                     "items": [{"text": char, "start": start + offset * 200, "end": start + (offset + 1) * 200} for offset, char in enumerate(text)]})
source.write_text(json.dumps({"segments": segments}, ensure_ascii=False), encoding="utf-8")
artifact = run_ai_cleanup(AiCleanupRequest(source, None, None, OutputMode.BOTH, generate_comparison=True),
                          complete=lambda _p, _r: {"timeline": "[c001] ~~这个~~这个方法\n[c002] 这个不能公开 %待确认：否定条件需要回听%\n[c003] 最终完成"})
print(json.dumps({"comparison": str(artifact.comparison_path), "project": str(artifact.project_path)}, ensure_ascii=False))
