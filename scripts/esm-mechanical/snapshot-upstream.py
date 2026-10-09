"""Save a read-only, pinned snapshot of open upstream PRs without PR bodies or credentials."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", "--paginate", "--slurp", path], encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--replace", action="store_true", help="Explicitly replace an earlier snapshot")
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists() and not args.replace:
        raise SystemExit("Snapshot exists; choose a new filename or explicitly use --replace")
    repository = "Moyf/moys-asr-workflow"
    prs = []
    for page in api(f"repos/{repository}/pulls?state=open&per_page=100"):
        for pr in page:
            files = api(f"repos/{repository}/pulls/{pr['number']}/files?per_page=100")
            latest = api(f"repos/{repository}/pulls/{pr['number']}")[0]
            if latest["head"]["sha"] != pr["head"]["sha"] or latest["base"]["sha"] != pr["base"]["sha"]:
                raise SystemExit("PR changed while collecting metadata; rerun to obtain a consistent snapshot")
            prs.append({"number": pr["number"], "title": pr["title"], "url": pr["html_url"],
                        "draft": pr["draft"], "updatedAt": pr["updated_at"],
                        "base": {"ref": pr["base"]["ref"], "sha": pr["base"]["sha"]},
                        "head": {"ref": pr["head"]["ref"], "sha": pr["head"]["sha"]},
                        "files": [{"path": f["filename"], "previousPath": f.get("previous_filename"),
                                   "status": f["status"], "additions": f["additions"], "deletions": f["deletions"]}
                                  for entries in files for f in entries]})
    snapshot = {"repository": repository, "retrievedAt": datetime.now(timezone.utc).isoformat(),
                "source": "GitHub REST API via gh", "prs": prs}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"count": len(prs), "numbers": [p["number"] for p in prs]}))


if __name__ == "__main__":
    main()
