#!/usr/bin/env python3
"""Impact-selected development and CI checks, with explicit release gates."""
from __future__ import annotations

import argparse
from functools import cache, partial
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
    from .browser_results import collection, validate_shard_partition, validate as validate_browser
    from .test_policy import PYTHON_PACKS, WINDOWS_FFMPEG_TESTS
    from .local_test_impact import CHECKLIST_NODE, CHECKLIST_PYTHON, CHECKLIST_SPECS, DEV_NODE, DEV_PYTHON, node_pack, select_packs
    from .test_prerequisites import PREPARATIONS, partition_command, test_requirements
    from .test_result_details import collect_failures
else:
    from run_check import run
    from browser_results import collection, validate_shard_partition, validate as validate_browser
    from test_policy import PYTHON_PACKS, WINDOWS_FFMPEG_TESTS
    from local_test_impact import CHECKLIST_NODE, CHECKLIST_PYTHON, CHECKLIST_SPECS, DEV_NODE, DEV_PYTHON, node_pack, select_packs
    from test_prerequisites import PREPARATIONS, partition_command, test_requirements
    from test_result_details import collect_failures

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
    if prep.get("editor_bundle", prep.get("application")):
        steps.append(("build", [node, "scripts/build-editor.mjs", "--write"], 60))
    if prep.get("launcher_bundle", prep.get("application")):
        steps.append(("build-launcher", [node, "scripts/build-launcher.mjs", "--write"], 60))
    if prep.get("application"):
        steps.append(("typecheck", [node, "node_modules/typescript/bin/tsc", "-p", "web/tsconfig.typecheck.json"], 120))
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


def execute(name: str, command: list[str], timeout: int, *, log_root: Path | None = None) -> dict:
    print(f"Running {name} (deadline {timeout}s)", flush=True)
    _, result = run(command, timeout, log_root or ROOT / ".artifacts/checks")
    print(f"{name}: exit={result['exit_code']}; seconds={result['duration_seconds']}; log={result['log']}", flush=True)
    return {"gate": name, **result}


def execute_browser(name, command, timeout, report):
    key = "PLAYWRIGHT_JSON_OUTPUT_FILE"
    previous = os.environ.get(key)
    os.environ[key] = str(report.resolve())
    try:
        return execute(name, command, timeout, log_root=report.parent / "checks")
    finally:
        if previous is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = previous


def prepare_browser(name, command, directory, specs, selection, results):
    full = None
    # A single shard already discovers every selected case. Only a real split
    # needs a separate unsharded collection for a later union check.
    if any(arg.startswith("--shard=") and arg != "--shard=1/1" for arg in command):
        full_path = directory / f"{name}-full.json"
        full_command = [arg for arg in command if not arg.startswith("--shard=")]
        result = execute_browser(f"{name}-full-discover", [*full_command, "--list"], 60, full_path)
        result["report"] = str(full_path)
        results.append(result)
        if result["exit_code"]:
            raise ValueError(f"Browser full discovery failed; log={result['log']}")
        full = json.loads(full_path.read_text(encoding="utf-8"))
        if full.get("errors") or full.get("config", {}).get("shard") is not None:
            raise ValueError("invalid full browser discovery")
    report_path = directory / f"{name}-list.json"
    result = execute_browser(f"{name}-discover", [*command, "--list"], 60, report_path)
    result["report"] = str(report_path)
    results.append(result)
    if result["exit_code"]:
        raise ValueError(f"Browser discovery failed; log={result['log']}")
    listed = json.loads(report_path.read_text(encoding="utf-8"))
    if full is not None:
        _, value = next(arg.split("=", 1) for arg in command if arg.startswith("--shard="))
        current, total = map(int, value.split("/"))
        shards = []
        for index in range(1, total + 1):
            if index == current:
                shards.append(listed)
                continue
            sibling_path = directory / f"{name}-list-{index}.json"
            sibling_command = [*full_command, f"--shard={index}/{total}", "--list"]
            result = execute_browser(f"{name}-discover-{index}", sibling_command, 60, sibling_path)
            result["report"] = str(sibling_path)
            results.append(result)
            if result["exit_code"]:
                raise ValueError(f"Browser sibling discovery failed; log={result['log']}")
            shards.append(json.loads(sibling_path.read_text(encoding="utf-8")))
        validate_shard_partition(full, shards, total)
        if not collection(listed, allow_empty=True):
            return None
    return listed


def report_command(name, command, output_dir, *, partial_for=None):
    """Make the native report available for development kernels as well as packs."""
    reports = {}
    if any(str(arg).replace("\\", "/").endswith("scripts/run_tests.py") for arg in command):
        if "--report" not in command:
            command = [*command, "--report", str(output_dir / f"{name}.json")]
        elif partial_for:
            command[command.index("--report") + 1] = str(output_dir / f"{name}.json")
        reports["python_report"] = Path(command[command.index("--report") + 1])
    if "--test" in command:
        report = output_dir / f"{name}.xml"
        if "--test-reporter=junit" not in command:
            command = [*command[:2], "--test-reporter=spec", "--test-reporter-destination=stdout",
                       "--test-reporter=junit", f"--test-reporter-destination={report}", *command[2:]]
        reports["node_report"] = report
    if name in {"editor-http-smoke", "browser-regressions"}:
        reports["browser_report"] = output_dir / f"{name}.json"
    return command, reports


def run_steps(steps, output_dir, plan, *, metadata, blocked_preparation=()):
    """Run the selected independent groups and persist bounded evidence locations."""
    unavailable = set(blocked_preparation)
    results, failures, report_errors = [], [], []
    selected = [name for name, _, _ in steps]
    finished = set()
    shard = metadata.get("shard", {"current": 1, "total": 1})
    requirements = cache(partial(test_requirements, root=ROOT))

    def record(result, **reports):
        observed = result["exit_code"] if result["status"] == "completed" else None
        result.setdefault("process_exit_code", observed)
        if result["status"] != "blocked":
            details = collect_failures(result, **reports)
            if details["report_errors"] and reports and not result["exit_code"]:
                result.update(exit_code=1, status="invalid-required-report", error=details["report_errors"][0])
            failures.extend(details["failures"])
            report_errors.extend({"gate": result["gate"], "error": error} for error in details["report_errors"])
            if result["exit_code"]:
                for line in dict.fromkeys(result.get("diagnostics", []) + result.get("tail", [])):
                    print(line)
        results.append(result)

    def save():
        not_run = [name for name in selected if name not in finished]
        failed = [item["gate"] for item in results if item["status"] != "blocked" and item["exit_code"]]
        blocked = [item["gate"] for item in results if item["status"] == "blocked"]
        code = int(bool(failed or blocked or not_run))
        summary = {**metadata, "plan": plan, "results": results, "selected_gates": selected,
                   "failed": failed, "blocked": blocked, "not_run": not_run,
                   "status": "not-selected" if not selected else "failed" if code else "passed",
                   "exit_code": code, "failures_file": "failures.json"}
        for filename, value in (("failures.json", {"failures": failures, "report_errors": report_errors}),
                                ("summary.json", summary)):
            path = output_dir / filename
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
            temporary.replace(path)
        return summary

    summary = save()
    for selected_gate, original, timeout in steps:
        name = selected_gate
        partial_for = None
        command, blocked, available = partition_command(name, original, unavailable, ROOT, requirements)
        if blocked:
            # Pack discovery imports modules before it assigns cases to packs.
            pack_discovery = "--pack" in original and name not in blocked
            group = f"{name}-discovery" if pack_discovery else f"{name}-blocked" if command else name
            field = "blocked_discovery" if pack_discovery else "blocked_tests"
            record({"gate": group, "status": "blocked", "process_exit_code": None, "exit_code": 1,
                    field: blocked,
                    "blocked_by": sorted({dependency for dependencies in blocked.values() for dependency in dependencies})})
            scope = "discovery file(s)" if pack_discovery else "selected group(s)"
            print(f"{group}: preparation unavailable for {len(blocked)} {scope}", flush=True)
        if command is None:
            unavailable.add(name)
        if available:
            partial_for = name
            name = f"{name}-partial"
            command = [*original, "--partial-discovery", *available]
        if command is not None:
            command, reports = report_command(name, command, output_dir, partial_for=partial_for)
            discovers = []
            browser = reports.get("browser_report")
            process = None
            try:
                if browser:
                    listed = prepare_browser(name, command, output_dir, (), "", discovers)
                    reports["browser_listing"] = output_dir / f"{name}-list.json"
                    if listed is None:
                        process = {"gate": name, "command": command, "exit_code": 0,
                                   "status": "verified-empty-shard", "browser_listing": str(reports["browser_listing"])}
                        reports = {}
                        browser = None
                    else:
                        process = execute_browser(name, command, timeout, browser)
                else:
                    process = execute(name, command, timeout, log_root=output_dir / "checks")
                result = {**process, "process_exit_code": process["exit_code"] if process["status"] == "completed" else None,
                          "process_status": process["status"]}
                if result.get("cleanup_error"):
                    result.update(exit_code=result["exit_code"] or 1, status="cleanup-error")
                if not result["exit_code"] and "node_report" in reports and name.startswith("node-"):
                    xml = ET.parse(reports["node_report"])
                    if not xml.findall(".//testcase") or any(xml.findall(f".//{tag}") for tag in ("skipped", "failure", "error")):
                        raise ValueError("Required Node report is empty or contains non-passing cases")
                if not result["exit_code"] and browser:
                    actual = json.loads(browser.read_text(encoding="utf-8"))
                    validated = validate_browser(listed, actual, shard["current"], shard["total"])
                    (output_dir / f"{name}-validated.json").write_text(
                        json.dumps(validated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
                if process:
                    result.update(exit_code=result["exit_code"] or 1, status="invalid-required-report", error=str(error))
                else:
                    result = {"gate": name, "command": command, "exit_code": 1, "process_exit_code": None,
                              "status": "invalid-discovery" if browser else "execution-error", "error": str(error)}
                    reports = {}
            for discovery in discovers:
                report = Path(discovery["report"])
                record(discovery, browser_report=report if discovery["exit_code"] else None)
            if partial_for:
                result["partial_for"] = partial_for
            record(result, **reports)
            if result["exit_code"]:
                unavailable.add(name)
                print(f"{name}: failed; evidence: {output_dir / 'failures.json'}", flush=True)
        finished.add(selected_gate)
        summary = save()
        if any(item.get("process_status", item["status"]) == "interrupted" for item in results):
            break
    return summary


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
    parser.add_argument("--blocked-preparation", action="append", choices=PREPARATIONS, default=[],
                        help="A failed preparation from the calling workflow (repeatable)")
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
    root = ROOT.resolve()
    print(f"Evidence: {output_dir.relative_to(root) if output_dir.is_relative_to(root) else output_dir}")
    if args.plan_only:
        return 0
    # Validate dependencies with their selected commands. A missing media
    # capability must not prevent an unrelated standard-library check.
    # Explicit interpreter settings avoid implicit environment synchronization.
    os.environ.setdefault("MAW_TEST_PYTHON", sys.executable)
    os.environ.setdefault("MAW_E2E_PYTHON", sys.executable)
    try:
        steps = list(commands(packs, output_dir, dev=bool(args.component), component=args.component or "all", specs=specs,
                              tools_scope=tools_scope, selection=plan, layer=args.layer, shard=(current, total)))
    except ValueError as error:
        report = {"status": "invalid-plan", "error": str(error), "exit_code": 1, "plan": plan}
        (output_dir / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(str(error))
        return 1
    metadata = {"head": head, "selection_fingerprint": selection_fingerprint, "shard": {"current": current, "total": total},
                "requested_layer": args.layer, "blocked_preparation": sorted(set(args.blocked_preparation))}
    summary = run_steps(steps, output_dir, plan, metadata=metadata, blocked_preparation=args.blocked_preparation)
    return summary["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
