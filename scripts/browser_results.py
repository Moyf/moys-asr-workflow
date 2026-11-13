"""Validate Playwright outcomes against the same job's sharded --list JSON."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

PORTABLE_REASON = "便携模式已弃维护，2.0 移除 HTML，见 #336 后回归分析"
PORTABLE_SKIPS = {
    ("editor-bundle.spec.mjs", ("minified portable bundle preserves non-default data, paths and generated language",)),
    ("editor-bundle.spec.mjs", ("file executes every source and preserves project/export/undo behavior",)),
    ("editor-text-tools.spec.mjs", ("portable file uses the same fade rules and SRT export settings",)),
    ("editor-text-tools.spec.mjs", ("portable editor saves and reloads presets in its browser storage",)),
    ("warma-presets.spec.mjs", ("portable pages reject a stale preset library save",)),
}


def collection(report: dict) -> dict:
    found = {}

    def walk(suites, parents=()):
        for suite in suites:
            # The top-level suite is the file, not a describe() title.
            titles = parents + ((suite["title"],) if parents or suite.get("line", 0) else ())
            for spec in suite.get("specs", []):
                file = spec["file"]
                if not file or "\\" in file or file.startswith("/") or ".." in file.split("/"):
                    raise ValueError("invalid browser file")
                title = titles + (spec["title"],)
                for test in spec["tests"]:
                    key = (file, title, test["projectName"])
                    if key in found:
                        raise ValueError(f"duplicate browser case: {key}")
                    if key[2] != "chromium":
                        raise ValueError("unexpected browser project")
                    found[key] = test
            walk(suite.get("suites", []), titles)
    walk(report["suites"])
    if not found:
        raise ValueError("empty browser collection")
    return found


def validate(listed: dict, actual: dict, current: int, total: int) -> dict:
    if not 1 <= current <= total:
        raise ValueError("invalid requested shard")
    for report in (listed, actual):
        if report.get("errors"):
            raise ValueError("global browser errors")
        if report["config"]["shard"] != {"current": current, "total": total}:
            raise ValueError("wrong browser shard coordinates")
    expected, observed = collection(listed), collection(actual)
    if expected.keys() != observed.keys():
        raise ValueError("missing or unexpected browser cases relative to --list")
    skipped = []
    for key, test in observed.items():
        for case in (expected[key], test):
            if case["expectedStatus"] not in {"passed", "skipped"}:
                raise ValueError(f"expected failure is not coverage: {key}")
            if any(a["type"] in {"fail", "fixme"} for a in case.get("annotations", [])):
                raise ValueError(f"xfail/fixme is not coverage: {key}")
        results = test["results"]
        if len(results) != 1 or results[0]["retry"] != 0:
            raise ValueError(f"retry or missing outcome: {key}")
        if results[0]["status"] == "skipped":
            reasons = [a.get("description", "") for a in test.get("annotations", []) if a["type"] == "skip"]
            if (key[:2] not in PORTABLE_SKIPS or reasons != [PORTABLE_REASON]
                    or test["status"] != "skipped" or test["expectedStatus"] != "skipped"):
                raise ValueError(f"unsupported skip (including capability skip): {key}")
            skipped.append({"file": key[0], "title": list(key[1]), "reason": reasons[0]})
        elif (test["expectedStatus"] != "passed" or test["status"] != "expected"
              or results[0]["status"] != "passed" or results[0].get("errors")):
            raise ValueError(f"browser case did not pass first attempt: {key}")
    stats = actual["stats"]
    if (any(stats[k] != 0 for k in ("unexpected", "flaky"))
            or stats["expected"] != len(observed) - len(skipped) or stats["skipped"] != len(skipped)):
        raise ValueError("browser statistics do not match validated cases")
    return {"selected": len(observed), "passed": len(observed) - len(skipped),
            "skips": skipped, "expected_failures": 0, "retries": 0,
            "shard": {"current": current, "total": total}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("listed", type=Path)
    parser.add_argument("actual", type=Path)
    parser.add_argument("--current", required=True, type=int)
    parser.add_argument("--total", required=True, type=int)
    args = parser.parse_args()
    result = validate(json.loads(args.listed.read_text(encoding="utf-8")),
                      json.loads(args.actual.read_text(encoding="utf-8")), args.current, args.total)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
