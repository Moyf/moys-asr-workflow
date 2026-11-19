"""Validate Playwright outcomes against the same job's sharded --list JSON."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

PORTABLE_REASON = "便携模式已弃维护，2.0 移除 HTML，见 #336 后回归分析"
PORTABLE_SKIPS = {
    ("editor-bundle.spec.mjs", ("minified portable bundle preserves non-default data, paths and generated language",)): PORTABLE_REASON,
    ("editor-bundle.spec.mjs", ("file executes every source and preserves project/export/undo behavior",)): PORTABLE_REASON,
    ("editor-text-tools.spec.mjs", ("portable file uses the same fade rules and SRT export settings",)): PORTABLE_REASON,
    ("editor-text-tools.spec.mjs", ("portable editor saves and reloads presets in its browser storage",)):
        "便携模式已弃维护，2.0 移除 HTML，见便携模式回归分析",
}


def collection(report: dict, *, allow_empty: bool = False) -> dict:
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
    if not found and not allow_empty:
        raise ValueError("empty browser collection")
    return found


def config_identity(report: dict) -> dict:
    """The argv and shard differ by invocation; the resolved test config must not."""
    config = report["config"]
    if not isinstance(config, dict) or not isinstance(config.get("version"), str) or not config["version"]:
        raise ValueError("missing Playwright config/version")
    identity = {key: value for key, value in config.items() if key not in {"argv", "shard"}}
    # These Playwright-provided runtime fields can be absent during --list.
    # Keep user/config metadata so a real configuration mismatch still fails.
    def metadata(value):
        if not isinstance(value, dict):
            raise ValueError("invalid browser metadata")
        return {key: item for key, item in value.items()
                if key not in {"actualWorkers", "ci", "gitCommit", "gitDiff"}}
    if "metadata" in identity:
        identity["metadata"] = metadata(identity["metadata"])
    if "projects" in identity:
        identity["projects"] = [{**project, "metadata": metadata(project.get("metadata", {}))}
                                for project in identity["projects"]]
    if "argv" in config:
        argv = config["argv"]
        if not isinstance(argv, list) or any(not isinstance(arg, str) for arg in argv):
            raise ValueError("invalid browser argv")
        identity["argv"] = [arg for arg in argv if arg != "--list" and not arg.startswith("--shard=")]
    return identity


def full_collection(report: dict) -> set:
    if not isinstance(report, dict) or report.get("errors") or report["config"]["shard"] is not None:
        raise ValueError("invalid unsharded browser discovery")
    config_identity(report)
    return set(collection(report))


def validate_shard_partition(full, shards, total):
    """Require disjoint shard listings that cover the entire unsharded collection."""
    if total < 2 or len(shards) != total:
        raise ValueError("incomplete browser shard discovery")
    remaining = full_collection(full)
    identity = config_identity(full)
    for index, report in enumerate(shards, start=1):
        if (report.get("errors") or report["config"]["shard"] != {"current": index, "total": total}
                or config_identity(report) != identity):
            raise ValueError("inconsistent browser shard discovery")
        cases = collection(report, allow_empty=True).keys()
        if not cases <= remaining:
            raise ValueError("unexpected or overlapping browser shard cases")
        remaining.difference_update(cases)
    if remaining:
        raise ValueError("browser cases missing from shard discovery")


def validate(listed: dict, actual: dict, current: int, total: int) -> dict:
    if not 1 <= current <= total:
        raise ValueError("invalid requested shard")
    for report in (listed, actual):
        if report.get("errors"):
            raise ValueError("global browser errors")
        if report["config"]["shard"] != {"current": current, "total": total}:
            raise ValueError("wrong browser shard coordinates")
    if config_identity(listed) != config_identity(actual):
        raise ValueError("browser discovery/runtime config mismatch")
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
            if (key[:2] not in PORTABLE_SKIPS or reasons != [PORTABLE_SKIPS[key[:2]]]
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
