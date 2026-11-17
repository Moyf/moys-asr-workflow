#!/usr/bin/env python3
"""Impact-selected development and CI checks, with explicit release gates."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET

if __package__:
    from .run_check import run
    from .browser_results import validate as validate_browser
    from .test_policy import PYTHON_PACKS, WINDOWS_FFMPEG_TESTS
    from .local_test_impact import CHECKLIST_NODE, CHECKLIST_PYTHON, CHECKLIST_SPECS, DEV_NODE, DEV_PYTHON, node_pack, select_packs
else:
    from run_check import run
    from browser_results import validate as validate_browser
    from test_policy import PYTHON_PACKS, WINDOWS_FFMPEG_TESTS
    from local_test_impact import CHECKLIST_NODE, CHECKLIST_PYTHON, CHECKLIST_SPECS, DEV_NODE, DEV_PYTHON, node_pack, select_packs

ROOT = Path(__file__).resolve().parents[1]
PACKS = ("docs", "release", "common", "browser", "smoke", "media", "long-media", "lifecycle", "tools", "e2e", "editor-e2e", "website", "manual")


def changed_paths(base_ref: str | None, *, deleted_only: bool = False) -> list[str]:
    args = ["git", "diff", "--name-only", "--no-renames", "-z"]
    if deleted_only:
        args.append("--diff-filter=D")
    comparisons = [[*args, f"{base_ref}...HEAD"]] if base_ref else [args, [*args, "--cached"]]
    paths = []
    for comparison in comparisons:
        result = subprocess.run(comparison, cwd=ROOT, capture_output=True, check=True)
        paths.extend(p for p in result.stdout.decode("utf-8").split("\0") if p)
    if not base_ref and not deleted_only:
        untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard", "-z"],
                                  cwd=ROOT, capture_output=True, check=True)
        paths.extend(p for p in untracked.stdout.decode("utf-8").split("\0") if p)
    return sorted(set(paths))


def preparation(packs, specs=(), tools_scope="all"):
    """Unknown/mixed browser consumers retain the existing application/media prep."""
    checklist_only = bool(specs) and set(specs).issubset(CHECKLIST_SPECS)
    app = bool(set(packs) & {"common", "browser", "smoke", "editor-e2e", "media", "long-media"}
               or "tools" in packs and tools_scope != "checklist"
               or "e2e" in packs and not checklist_only)
    media = bool(set(packs) & {"media", "long-media", "editor-e2e"}
                 or "e2e" in packs and not checklist_only)
    return {"application": app, "real_media": media}


def _pack_commands(packs: list[str], report_dir: Path, *, dev: bool = False, component: str = "all", specs=(), tools_scope="all"):
    python = sys.executable
    node = shutil.which("node") or "node"
    playwright = [node, "node_modules/@playwright/test/cli.js", "test", "--config=tests/config/playwright.config.mjs", "--project=chromium",
                  "--forbid-only", "--workers=2", "--retries=0", "--shard=1/1"]
    if dev:
        if component in {"python", "all"}:
            yield "python-kernel", [python, "scripts/run_tests.py", "--required", *DEV_PYTHON], 60
        if component in {"editor", "all"}:
            yield "editor-kernel", [node, "--test", *(f"tests/{name}" for name in DEV_NODE)], 60
        if component in {"launcher", "all"}:
            yield "launcher-kernel", [python, "scripts/run_tests.py", "--required", "tests.test_launcher_contract"], 60
        return
    if "common" in packs or "tools" in packs and tools_scope != "checklist":
        yield "python-lint", [python, "-m", "ruff", "check"], 60
    if preparation(packs, specs, tools_scope)["application"]:
        yield "build", [node, "scripts/build-editor.mjs", "--write"], 60
        yield "build-launcher", [node, "scripts/build-launcher.mjs", "--write"], 60
        yield "typecheck", [node, "node_modules/typescript/bin/tsc", "-p", "web/tsconfig.typecheck.json"], 120
    for pack in packs:
        if pack == "lifecycle" and os.name == "nt":
            yield "python-windows-ffmpeg", [python, "scripts/run_tests.py", "--required",
                   "--report", str(report_dir / "python-windows-ffmpeg.json"), *WINDOWS_FFMPEG_TESTS], 60
        if pack == "docs":
            yield "docs-navigation", [python, "scripts/check_docs.py"], 60
            yield "release-docs", [python, "scripts/prepare_release_notes.py", "--check-all"], 60
            if "tools" not in packs or tools_scope == "checklist":
                yield "docs-regressions", [python, "scripts/run_tests.py", "--required", "tests.test_docs_check", "tests.test_release_notes",
                                           "tests.test_release_site", "tests.test_release_publication"], 120
        if pack in PYTHON_PACKS:
            targets = list(CHECKLIST_PYTHON) if pack == "tools" and tools_scope == "checklist" else ["--pack", pack]
            # Pack discovery retains unittest package/import/load_tests semantics.
            # The measured file-parallel engine remains available for full discovery.
            yield f"python-{pack}", [python, "scripts/run_tests.py", *targets, "--required",
                   "--report", str(report_dir / f"python-{pack}.json")], 300 if pack == "long-media" else 240
        if pack in {"common", "browser", "lifecycle", "tools"}:
            targets = [str(p.relative_to(ROOT)) for p in sorted((ROOT / "tests").glob("*.mjs")) if node_pack(p.name) == pack]
            if pack == "tools" and tools_scope == "checklist":
                targets = [CHECKLIST_NODE]
            if not targets:
                raise ValueError(f"No Node tests found for required pack: {pack}")
            yield f"node-{pack}", [node, "--test", "--test-reporter=spec", "--test-reporter-destination=stdout",
                   "--test-reporter=junit", f"--test-reporter-destination={report_dir / ('node-' + pack + '.xml')}", *targets], 240
        if pack == "smoke":
            yield "editor-http-smoke", [*playwright, "--reporter=line,json", f"--output={report_dir / 'smoke-artifacts'}", "tests/e2e/editor-bundle.spec.mjs", "tests/e2e/editor-transactions.spec.mjs"], 300
        if pack == "editor-e2e":
            # Includes Launcher specs: shared browser/host code crosses both UIs.
            yield "browser-regressions", [*playwright, "--reporter=line,json", f"--output={report_dir / 'browser-artifacts'}",
                   ], 900
        if pack == "e2e":
            yield "browser-regressions", [*playwright, "--reporter=line,json", f"--output={report_dir / 'browser-artifacts'}",
                   *specs], 900
        if pack == "website":
            yield "website-docs", [node, "website/scripts/sync-maw-docs.mjs"], 60
            yield "website-releases", [python, "scripts/build_release_site.py", "--preview"], 180
            yield "website-build", [shutil.which("pnpm") or "pnpm", "--dir", "website", "build"], 240


def command_layer(name: str) -> str:
    if name in {"python-lint", "build", "build-launcher", "typecheck"}:
        return "prepare"
    if name in {"docs-navigation", "release-docs", "release-site", "tools-docs"}:
        return "docs"
    if name.startswith("website-"):
        return "website"
    if name.startswith("node-"):
        return "node"
    if name in {"editor-http-smoke", "browser-regressions"}:
        return "browser"
    return "python"


def website_before_browser(steps):
    website = [step for step in steps if command_layer(step[0]) == "website"]
    remaining = [step for step in steps if command_layer(step[0]) != "website"]
    index = next((i for i, step in enumerate(remaining) if command_layer(step[0]) == "browser"), len(remaining))
    return remaining[:index] + website + remaining[index:]


def commands(packs: list[str], report_dir: Path, *, dev: bool = False, component: str = "all",
             specs=(), tools_scope="all", selection=None, layer="all", shard=(1, 1)):
    """Execute the same concrete selection locally and in each CI layer."""
    if not selection or selection.get("mode") != "targeted":
        steps = list(_pack_commands(packs, report_dir, dev=dev, component=component, specs=specs, tools_scope=tools_scope))
        if "website" in packs and "editor-e2e" in packs and layer == "all":
            steps = website_before_browser(steps)
        for step in steps:
            if step[0] == "editor-http-smoke" and "editor-e2e" in packs:
                continue  # Same Chromium cases/configuration are in the full collection.
            if layer in {"all", command_layer(step[0])}:
                if command_layer(step[0]) == "browser":
                    step = (step[0], [f"--shard={shard[0]}/{shard[1]}" if arg.startswith("--shard=") else arg
                                     for arg in step[1]], step[2])
                yield step
        return

    python = sys.executable
    node = shutil.which("node") or "node"
    prep = selection["preparation"]
    steps = []
    if prep.get("lint"):
        paths = [path for path in selection.get("changed_paths", []) if path.endswith(".py") and (ROOT / path).is_file()]
        steps.append(("python-lint", [python, "-m", "ruff", "check", *paths], 60))
    if prep.get("application"):
        steps.extend((
            ("build", [node, "scripts/build-editor.mjs", "--write"], 60),
            ("build-launcher", [node, "scripts/build-launcher.mjs", "--write"], 60),
            ("typecheck", [node, "node_modules/typescript/bin/tsc", "-p", "web/tsconfig.typecheck.json"], 120),
        ))
    if "docs" in packs:
        steps.append(("docs-navigation", [python, "scripts/check_docs.py"], 60))
    if "release" in packs:
        steps.append(("release-docs", [python, "scripts/prepare_release_notes.py", "--check-all"], 60))
        if "website" not in packs:
            steps.append(("release-site", [python, "scripts/build_release_site.py", "--preview"], 180))
    if "tools" in packs:
        steps.append(("tools-docs", [node, "scripts/build-tool-docs.mjs", "--check"], 60))
    targets = selection["python_tests"]
    if targets:
        steps.append(("python-selected", [python, "scripts/run_tests.py", "--automated", "--required", "--report",
                      str(report_dir / "python-selected.json"), *targets], 300))
    targets = selection["node_tests"]
    if targets:
        steps.append(("node-selected", [node, "--test", "--test-reporter=spec", "--test-reporter-destination=stdout",
                      "--test-reporter=junit", f"--test-reporter-destination={report_dir / 'node-selected.xml'}",
                      *targets], 240))
    if specs:
        steps.append(("browser-regressions", [node, "node_modules/@playwright/test/cli.js", "test",
                      "--config=tests/config/playwright.config.mjs", "--project=chromium", "--forbid-only",
                      "--workers=2", "--retries=0", f"--shard={shard[0]}/{shard[1]}", "--reporter=line,json",
                      f"--output={report_dir / 'browser-artifacts'}", *specs], 900))
    if "website" in packs:
        steps.extend((
            ("website-docs", [node, "website/scripts/sync-maw-docs.mjs"], 60),
            ("website-releases", [python, "scripts/build_release_site.py", "--preview"], 180),
            ("website-check", [shutil.which("pnpm") or "pnpm", "--dir", "website", "run", "check"], 180),
            ("website-build", [shutil.which("pnpm") or "pnpm", "--dir", "website", "build"], 240),
        ))
    # A browser contract may serve website/dist. Prepare that input before the
    # browser consumes it, including on a clean local checkout.
    if "tests/e2e/editor-entry-retirement.spec.mjs" in specs and layer == "all":
        steps = website_before_browser(steps)
    for step in steps:
        if layer in {"all", command_layer(step[0])}:
            yield step


def read_selection(path: Path) -> dict:
    plan = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(plan, dict) or plan.get("mode") not in {"targeted", "full"}:
        raise ValueError("selection plan requires targeted/full mode")
    if plan.get("head"):
        current = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        if plan["head"] != current:
            raise ValueError("selection plan belongs to a different commit")
    for key in ("packs", "python_tests", "node_tests", "e2e_specs", "reasons"):
        if not isinstance(plan.get(key), list) or any(not isinstance(item, str) for item in plan[key]):
            raise ValueError(f"invalid selection list: {key}")
        if len(plan[key]) != len(set(plan[key])):
            raise ValueError(f"duplicate selection entries: {key}")
    if not isinstance(plan.get("preparation"), dict):
        raise ValueError("selection plan requires preparation flags")
    for key, suffix in (("python_tests", ".py"), ("node_tests", ".mjs"), ("e2e_specs", ".spec.mjs")):
        for target in plan[key]:
            parts = target.split("/")
            if not target.startswith("tests/") or not target.endswith(suffix) or "\\" in target or any(
                    part in {"", ".", ".."} for part in parts) or not (ROOT / target).is_file():
                raise ValueError(f"invalid concrete test path: {target}")
    if set(plan["packs"]) - set(PACKS) or len(plan["packs"]) != len(set(plan["packs"])):
        raise ValueError("selection plan contains unknown or duplicate packs")
    return plan


def execute(name: str, command: list[str], timeout: int) -> dict:
    print(f"Running {name} (deadline {timeout}s)", flush=True)
    _, result = run(command, timeout, ROOT / ".artifacts/checks")
    print(f"{name}: exit={result['exit_code']}; seconds={result['duration_seconds']}; log={result['log']}", flush=True)
    return {"gate": name, **result}


def prepare_browser(name, command, directory, specs, selection, results):
    # A single shard already discovers every selected case. Only a real split
    # needs a separate unsharded collection for a later union check.
    if any(arg.startswith("--shard=") and arg != "--shard=1/1" for arg in command):
        full_path = directory / f"{name}-full.json"
        os.environ["PLAYWRIGHT_JSON_OUTPUT_FILE"] = str(full_path.resolve())
        full_command = [arg for arg in command if not arg.startswith("--shard=")]
        result = execute(f"{name}-full-discover", [*full_command, "--list"], 60)
        results.append(result)
        if result["exit_code"]:
            raise ValueError(f"Browser full discovery failed; log={result['log']}")
        full = json.loads(full_path.read_text(encoding="utf-8"))
        if full.get("errors") or full.get("config", {}).get("shard") is not None:
            raise ValueError("invalid full browser discovery")
    report_path = directory / f"{name}-list.json"
    os.environ["PLAYWRIGHT_JSON_OUTPUT_FILE"] = str(report_path.resolve())
    result = execute(f"{name}-discover", [*command, "--list"], 60)
    results.append(result)
    if result["exit_code"]:
        raise ValueError(f"Browser discovery failed; log={result['log']}")
    listed = json.loads(report_path.read_text(encoding="utf-8"))
    return listed


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=("dev", "merge", "release"), default="dev")
    parser.add_argument("--component", choices=("all", "python", "editor", "launcher"),
                        help="explicit fixed development kernel; default dev uses impact selection")
    parser.add_argument("--pack", action="append", choices=PACKS)
    parser.add_argument("--changed", action="append", help="explicit changed path (repeatable); no shell patterns")
    parser.add_argument("--base-ref", help="Git base for committed branch changes; diff failure stops selection")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--e2e-specs", help="JSON concrete spec paths for an explicit e2e pack")
    parser.add_argument("--tools-scope", choices=("all", "checklist"), help="explicit tool consumer scope for reproduction")
    parser.add_argument("--selection-plan", type=Path, help="execute a saved concrete selection for this commit")
    parser.add_argument("--layer", choices=("all", "docs", "website", "python", "node", "browser", "prepare"), default="all")
    parser.add_argument("--report-dir", type=Path, help="fresh evidence directory (default: unique local run)")
    parser.add_argument("--shard", default="1/1", help="browser shard CURRENT/TOTAL; all other layers stay unchanged")
    args = parser.parse_args(argv)
    try:
        current, total = (int(value) for value in args.shard.split("/"))
        if not 1 <= current <= total:
            raise ValueError
    except ValueError:
        parser.error("shard must be CURRENT/TOTAL with 1 <= CURRENT <= TOTAL")
    if args.stage == "release" and args.pack:
        parser.error("release runs the full required set; use --stage merge for a partial pack")
    if args.selection_plan and (args.changed or args.base_ref or args.pack or args.e2e_specs or args.tools_scope):
        parser.error("selection-plan cannot be combined with selection overrides")
    if args.stage == "release" and (args.selection_plan or args.component or args.layer != "all"):
        parser.error("release requires the complete collection, without layer or saved-selection overrides")
    if args.stage == "release" and total != 1:
        parser.error("release requires all browser cases in this run; use merge/CI for verified shards")
    if args.component and (args.stage != "dev" or args.pack or args.selection_plan):
        parser.error("component selects an explicit development kernel only")
    os.chdir(ROOT)
    try:
        plan = read_selection(args.selection_plan) if args.selection_plan else None
        paths = plan.get("changed_paths", []) if plan else args.changed if args.changed is not None else changed_paths(args.base_ref)
        deleted = [] if args.selection_plan or args.changed is not None else changed_paths(args.base_ref, deleted_only=True)
        plan = plan or select_packs(paths, release=args.stage == "release", base_ref=args.base_ref)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    selection_fingerprint = hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=True,
                                                     separators=(",", ":")).encode("utf-8")).hexdigest()
    packs = args.pack or plan["packs"]
    specs = json.loads(args.e2e_specs) if args.e2e_specs else plan["e2e_specs"]
    if not isinstance(specs, list) or any(not isinstance(path, str) or not path.startswith("tests/e2e/") or not path.endswith(".spec.mjs")
            or ".." in Path(path).parts or not (ROOT / path).is_file() for path in specs):
        parser.error("e2e-specs must contain existing repository spec paths")
    if "e2e" in packs and not specs:
        parser.error("e2e requires concrete specs; use editor-e2e for the full collection")
    if args.component:
        packs = []
    if "e2e" in packs and "editor-e2e" in packs:
        parser.error("e2e and editor-e2e are mutually exclusive")
    if len(packs) != len(set(packs)):
        parser.error("duplicate packs would repeat the same gate")
    tools_scope = args.tools_scope or ("all" if args.pack else plan.get("tools_scope", "all"))
    if args.stage == "release" or set(packs) - {"docs", "tools", "e2e", "website"} or (
            "e2e" in packs and not (specs and set(specs).issubset(CHECKLIST_SPECS))):
        tools_scope = "all"
    prep = plan.get("preparation") if plan.get("preparation") and not args.pack else preparation(packs, specs, tools_scope)
    head = plan.get("head") or subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    plan.update(head=head, stage=args.stage, changed_paths=paths, deleted_paths=deleted, packs=packs, e2e_specs=specs,
                tools_scope=tools_scope, requested_layer=args.layer, preparation=prep)
    if args.pack or args.component:
        plan["mode"] = "explicit-pack" if args.pack else "development-kernel"
    output_dir = (args.report_dir or ROOT / ".artifacts/test-workflow" / uuid.uuid4().hex[:12]).resolve()
    if output_dir.exists():
        parser.error("report-dir must be fresh; existing evidence cannot be reused")
    output_dir.mkdir(parents=True)
    (output_dir / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    print(f"Evidence: {output_dir.relative_to(ROOT)}")
    if args.plan_only:
        return 0
    # Validate dependencies with their selected commands. A missing media
    # capability must not prevent an unrelated standard-library check.
    # Explicit interpreter settings avoid implicit environment synchronization.
    os.environ.setdefault("MAW_TEST_PYTHON", sys.executable)
    os.environ.setdefault("MAW_E2E_PYTHON", sys.executable)
    results = []
    try:
        steps = list(commands(packs, output_dir, dev=bool(args.component), component=args.component or "all", specs=specs,
                              tools_scope=tools_scope, selection=plan, layer=args.layer, shard=(current, total)))
    except ValueError as error:
        report = {"status": "invalid-plan", "error": str(error), "exit_code": 1, "plan": plan}
        (output_dir / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(str(error))
        return 1
    for name, command, timeout in steps:
        browser_record = None
        if name in {"editor-http-smoke", "browser-regressions"}:
            try:
                browser_record = prepare_browser(name, command, output_dir,
                    specs if "e2e" in packs and name == "browser-regressions" else [],
                    "smoke" if name == "editor-http-smoke" else "e2e" if "e2e" in packs else "editor-e2e", results)
            except (OSError, ValueError, KeyError, TypeError) as error:
                print(str(error))
                results.append({"gate": name, "status": "invalid-discovery", "exit_code": 1, "error": str(error)})
                break
        browser_report = output_dir / f"{name}.json"
        os.environ["PLAYWRIGHT_JSON_OUTPUT_FILE"] = str(browser_report.resolve())
        result = execute(name, command, timeout)
        code = result["exit_code"]
        try:
            if not code and name.startswith("node-"):
                xml = ET.parse(output_dir / f"{name}.xml")
                if not xml.findall(".//testcase") or any(xml.findall(f".//{tag}") for tag in ("skipped", "failure", "error")):
                    raise ValueError("Required Node report is empty or contains non-passing cases")
            if not code and browser_record:
                report = json.loads(browser_report.read_text(encoding="utf-8"))
                validated = validate_browser(browser_record, report, current, total)
                (output_dir / f"{name}-validated.json").write_text(
                    json.dumps(validated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
            code = 1
            result.update(exit_code=1, status="invalid-required-report", error=str(error))
            print(str(error))
        results.append(result)
        if code:
            print("\n".join(dict.fromkeys(result["diagnostics"] + result["tail"])))
            break
    summary = {"plan": plan, "results": results, "head": head,
               "selection_fingerprint": selection_fingerprint, "shard": {"current": current, "total": total},
               "requested_layer": args.layer, "selected_gates": [name for name, _, _ in steps],
               "status": "not-selected" if not steps else "failed" if any(r["exit_code"] for r in results) else "passed",
               "exit_code": next((r["exit_code"] for r in results if r["exit_code"]), 0)}
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 1 if summary["exit_code"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
