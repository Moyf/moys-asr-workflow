"""Supplemental matrix execution and fail-closed aggregate gate (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

if __package__:
    from . import browser_results, ci_impact
    from .run_tests import report_code
    from .test_policy import allowed_platform_skip, python_pack
else:
    import browser_results
    import ci_impact
    from run_tests import report_code
    from test_policy import allowed_platform_skip, python_pack

SYSTEMS = ("ubuntu-latest", "windows-latest")


def validate_plan(value: dict) -> dict:
    if set(value) != {"version", "mode", "profile", "light", "reason", "base", "head", "trusted_diff"}:
        raise ValueError("malformed CI plan fields")
    if type(value["version"]) is not int or value["version"] != ci_impact.VERSION:
        raise ValueError("unsupported CI plan version")
    canonical = ci_impact.plan(value["profile"], value["reason"], base=value["base"],
                               head=value["head"], trusted=value["trusted_diff"])
    if value != canonical or type(value["light"]) is not bool or type(value["trusted_diff"]) is not bool:
        raise ValueError("inconsistent CI plan")
    if not isinstance(value["reason"], str) or not value["reason"] or not ci_impact.SHA.fullmatch(value["head"]):
        raise ValueError("missing CI plan provenance")
    if value["trusted_diff"]:
        if not ci_impact.SHA.fullmatch(value["base"]):
            raise ValueError("invalid trusted base")
    elif value["mode"] != "full" or value["base"]:
        raise ValueError("untrusted diff cannot reduce coverage")
    return value


def fingerprint(plan: dict) -> str:
    return hashlib.sha256(json.dumps(validate_plan(plan), sort_keys=True).encode()).hexdigest()


def cells(plan: dict) -> list[dict]:
    validate_plan(plan)
    result = []
    if plan["mode"] == "full":
        result += [{"os": system, "layer": layer, "cell": f"{system}-{layer}"}
                   for system in SYSTEMS for layer in ("python", "node")]
    total = 4 if plan["mode"] == "full" else 1
    if plan["mode"] != "light":
        result += [{"os": system, "layer": "browser", "shard": n, "total": total,
                    "cell": f"{system}-browser-{n}-{total}"}
                   for system in SYSTEMS for n in range(1, total + 1)]
    return result


def gate(plan: dict, needs: dict, receipts: list[dict]) -> None:
    expected = {cell["cell"] for cell in cells(plan)}
    required = {"selection": "success", "full-tests": "success" if plan["mode"] == "full" else "skipped",
                "browser": "skipped" if plan["mode"] == "light" else "success"}
    if set(needs) != set(required) or any(needs[k]["result"] != v for k, v in required.items()):
        raise ValueError("missing, failed, cancelled, or unexpectedly skipped matrix job")
    outputs = needs["selection"]["outputs"]
    if outputs["mode"] != plan["mode"] or json.loads(outputs["plan"]) != plan:
        raise ValueError("selector outputs do not match persisted plan")
    found = [r["cell"] for r in receipts]
    if len(found) != len(set(found)) or set(found) != expected:
        raise ValueError("missing, duplicate, or unexpected matrix receipt")
    if any(r["fingerprint"] != fingerprint(plan) or r["status"] != "success" for r in receipts):
        raise ValueError("failed or mismatched matrix receipt")
    for receipt in receipts:
        if receipt["cell"].endswith("-python"):
            reports = receipt.get("reports", {})
            if (set(reports) != {"python.json", "media-required.json"}
                    or any(reports[name].get("validated") is not True
                           or reports[name].get("required") is not required
                           for name, required in (("python.json", False), ("media-required.json", True)))):
                raise ValueError("Python receipt lacks validated full/required report evidence")


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def validate_python_report(report: dict, *, required: bool) -> dict:
    """Check report accounting without turning ordinary discovery into required.

    unittest fixture-level skips do not increment testsRun; subtest skips do.
    Keep those standard semantics, but never trust serialized platform waivers.
    """
    counters = ("run", "failures", "errors", "expected_failures", "unexpected_successes", "exit_code")
    if not isinstance(report, dict) or any(type(report.get(k)) is not int or report[k] < 0 for k in counters):
        raise ValueError("invalid Python report counters")
    selected = report.get("selected_ids")
    if (not isinstance(selected, list) or not selected
            or any(not isinstance(i, str) or not i.strip() or i != i.strip()
                   or any(ord(c) < 32 or ord(c) == 127 for c in i) for i in selected)
            or len(set(selected)) != len(selected)):
        raise ValueError("empty, invalid or duplicate Python selected IDs")
    identities = set(selected)
    if not 0 < report["run"] <= len(identities):
        raise ValueError("invalid Python run count")
    if not isinstance(report.get("skips"), list):
        raise ValueError("missing Python skip records")
    skips, setup_covered, skipped_cases, skip_ids = [], set(), set(), set()
    for skip in report["skips"]:
        if (not isinstance(skip, dict) or not isinstance(skip.get("id"), str)
                or not isinstance(skip.get("reason"), str) or not skip["reason"].strip()):
            raise ValueError("invalid Python skip")
        identity = skip["id"]
        if identity in identities:
            if identity in skip_ids:
                raise ValueError("duplicate Python case skip")
            skip_ids.add(identity)
            skipped_cases.add(identity)
        elif match := re.fullmatch(r"(setUpClass|setUpModule|tearDownClass|tearDownModule) \(([^)]+)\)", identity):
            if identity in skip_ids:
                raise ValueError("duplicate Python fixture skip")
            skip_ids.add(identity)
            covered = {i for i in identities if i.startswith(match[2] + ".")}
            if not covered:
                raise ValueError("Python fixture skip outside selected collection")
            if match[1].startswith("setUp"):
                if setup_covered & covered:
                    raise ValueError("overlapping Python setup skips")
                setup_covered.update(covered)
        elif not any(identity.startswith(i + " (") or identity.startswith(i + " [") for i in identities):
            raise ValueError("Python skip outside selected collection")
        # Repeated parameterless (or identically parameterized) subtests have
        # the same unittest ID. Preserve every skip record, not a case-level
        # de-duplication: required must evaluate all of their reasons below.
        skips.append({"id": identity, "reason": skip["reason"],
                      "platform_not_applicable": allowed_platform_skip(identity, skip["reason"])})
    if (setup_covered & skipped_cases or report["run"] != len(identities) - len(setup_covered)
            or len(skipped_cases) + report["expected_failures"] > report["run"]):
        raise ValueError("Python run/skip/outcome accounting does not match selected collection")
    normalized = {**report, "skips": skips}
    if report["exit_code"] != 0 or report_code(normalized, required):
        raise ValueError("Python report contains failed or unsupported required outcomes")
    return {"validated": True, "required": required, "selected": len(selected), "run": report["run"],
            "skips": len(skips), "expected_failures": report["expected_failures"], "exit_code": 0}


def python_evidence(root: Path) -> dict:
    evidence, reports = {}, {}
    for name, required in (("python.json", False), ("media-required.json", True)):
        raw = (root / name).read_bytes()  # Missing, corrupt or empty reports must fail before receipt.
        reports[name] = json.loads(raw)
        evidence[name] = {**validate_python_report(reports[name], required=required),
                          "sha256": hashlib.sha256(raw).hexdigest()}
    expected_media = {i for i in reports["python.json"]["selected_ids"] if python_pack(i) == "media"}
    if set(reports["media-required.json"]["selected_ids"]) != expected_media:
        raise ValueError("required media collection differs from full discovery ownership")
    return evidence


def run_cell(plan: dict, identity: str, root: Path) -> None:
    selected = next((c for c in cells(plan) if c["cell"] == identity), None)
    if selected is None:
        raise ValueError("cell not selected by CI plan")
    root.mkdir(parents=True, exist_ok=True)
    # CI uses a fresh per-cell output directory. Refuse stale evidence instead
    # of allowing an exit-zero/no-report command to reuse an earlier success.
    outputs = ("receipt.json", "python.json", "media-required.json", "browser-list.json", "browser-results.json")
    if any((root / name).exists() for name in outputs):
        raise ValueError("matrix cell requires fresh report/receipt paths")
    env = {**os.environ, "MAW_TEST_PYTHON": sys.executable, "MAW_E2E_PYTHON": sys.executable}
    evidence = {}

    def run(command, *, report=None):
        child_env = dict(env)
        if report:
            child_env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = str(report.resolve())
        subprocess.run([sys.executable, "scripts/run_check.py", "--timeout", "600", "--", *command],
                       env=child_env, check=True)

    if selected["layer"] == "python":
        run([sys.executable, "scripts/run_tests.py", "--report", str(root / "python.json"), "--github-summary"])
        # Complete discovery reports private-fixture/platform skips. Real-media
        # capabilities are separately mandatory, never waived as platform skips.
        run([sys.executable, "scripts/run_tests.py", "--pack", "media", "--required",
             "--report", str(root / "media-required.json")])
        evidence = python_evidence(root)
    elif selected["layer"] == "node":
        run(["node", "--test", "tests/*.mjs"])
    else:
        command = ["node", "node_modules/@playwright/test/cli.js", "test",
                   "--config=tests/config/playwright.config.mjs", "--project=chromium",
                   "--workers=2", "--retries=0", "--forbid-only", "--reporter=json",
                   f"--shard={selected['shard']}/{selected['total']}",
                   *ci_impact.BROWSER_FILES[plan["profile"]]]
        run([*command, "--list"], report=root / "browser-list.json")
        run(command, report=root / "browser-results.json")
        summary = browser_results.validate(json.loads((root / "browser-list.json").read_text(encoding="utf-8")),
                                           json.loads((root / "browser-results.json").read_text(encoding="utf-8")),
                                           selected["shard"], selected["total"])
        write_json(root / "browser-validated.json", summary)
    write_json(root / "receipt.json", {"cell": identity, "fingerprint": fingerprint(plan), "status": "success",
                                      "reports": evidence})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("expand", "run", "gate"))
    parser.add_argument("--plan", type=Path, default=Path(".artifacts/ci-plan.json"))
    parser.add_argument("--cell")
    parser.add_argument("--root", type=Path, default=Path(".artifacts/matrix"))
    args = parser.parse_args()
    plan = validate_plan(json.loads(args.plan.read_text(encoding="utf-8")))
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if event and event != "pull_request" and plan["mode"] != "full":
        raise ValueError("non-PR workflow event requires a full CI plan")
    if os.environ.get("GITHUB_SHA") and plan["head"] != os.environ["GITHUB_SHA"]:
        raise ValueError("plan HEAD differs from workflow commit")
    if args.action == "expand":
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8", newline="\n") as stream:
            for key, layer in (("full_matrix", {"python", "node"}), ("browser_matrix", {"browser"})):
                # A placeholder keeps fromJSON a valid matrix on intentional skip.
                include = [c for c in cells(plan) if c["layer"] in layer] or [{"os": "ubuntu-latest", "cell": "not-selected"}]
                stream.write(f"{key}={json.dumps({'include': include}, separators=(',', ':'))}\n")
    elif args.action == "run":
        run_cell(plan, args.cell, args.root)
    else:
        receipts = [json.loads(p.read_text(encoding="utf-8")) for p in args.root.rglob("receipt.json")]
        gate(plan, json.loads(os.environ["CI_NEEDS"]), receipts)
        print(f"Matrix gate passed: {plan['mode']}/{plan['profile']}, {len(receipts)} verified cells; "
              "non-selected layers intentionally skipped")


if __name__ == "__main__":
    main()
