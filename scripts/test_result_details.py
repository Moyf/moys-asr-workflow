"""Read failure IDs and full diagnostics from the runner's native reports."""
from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import xml.etree.ElementTree as ET

if __package__:
    from .browser_results import collection
else:
    from browser_results import collection


def _python(report, required):
    for detail in report["failure_details"]:
        kind = detail["kind"]
        if kind != "expected_failure" or required:
            yield detail["id"], kind, detail["traceback"]
    for skip in report["skips"]:
        if required and not skip["platform_not_applicable"]:
            yield skip["id"], "skip", skip["reason"]


def _browser_id(key):
    file, titles, project = key
    return f'{file}::{" > ".join(titles)} [{project}]'


def _node(root):
    for case in root.iter("testcase"):
        name, file = case.attrib["name"], case.get("file") or case.get("classname")
        identity = f"{file}::{name}" if file else name
        outcomes = [child for child in case if child.tag in {"failure", "error", "skipped"}]
        for child in outcomes:
            yield identity, child.tag, "".join(child.itertext()).strip() or child.get("message", "")
        if not outcomes and case.get("failure"):
            yield identity, "failure", case.attrib["failure"]


def _browser(report, listing):
    for index, error in enumerate(report.get("errors", []), 1):
        yield f"<global:{index}>", "error", error
    if listing:
        return
    for key, test in collection(report).items():
        identity = _browser_id(key)
        annotations = test.get("annotations", [])
        attempts = test["results"]
        statuses = [attempt["status"] for attempt in attempts]
        errors = [error for attempt in attempts
                  for error in attempt.get("errors", []) or ([attempt["error"]] if attempt.get("error") else [])]
        if statuses == ["skipped"]:
            reasons = [a.get("description", "") for a in annotations if a["type"] == "skip"]
            yield identity, "skip", reasons
        elif (statuses != ["passed"] or errors or test["status"] != "expected"
                or test["expectedStatus"] != "passed" or any(attempt["retry"] for attempt in attempts)
                or any(a["type"] in {"fail", "fixme"} for a in annotations)):
            yield identity, "browser", {"statuses": statuses, "status": test["status"],
                                        "expected_status": test["expectedStatus"], "errors": errors,
                                        "annotations": annotations}


def collect_failures(result, *, python_report: Path | None = None, node_report: Path | None = None,
                     browser_report: Path | None = None, browser_listing: Path | None = None) -> dict:
    """Collect available failures without overwriting the process or gate outcome."""
    failures, issues = [], []
    log = result.get("log")

    def add(identity, kind, error):
        failures.append({"gate": result["gate"], "id": identity, "kind": kind, "error": error, "log": log})

    command = result.get("command", [])
    process_code = result.get("process_exit_code", result.get("exit_code"))
    status = result.get("process_status", result.get("status"))
    report_path = python_report or node_report or browser_report
    if report_path:
        try:
            if node_report:
                entries = _node(ET.parse(node_report).getroot())
            else:
                report = json.loads(report_path.read_text(encoding="utf-8"))
                if python_report:
                    log = report.get("full_log") or log
                    entries = _python(report, "--required" in command)
                    if len(report["selected_ids"]) != report["run"]:
                        issues.append(f'Python selected {len(report["selected_ids"])} cases but ran {report["run"]}')
                    counts = Counter(item["kind"] for item in report["failure_details"])
                    for kind, field in (("failure", "failures"), ("error", "errors"), ("expected_failure", "expected_failures"),
                                        ("unexpected_success", "unexpected_successes")):
                        if field in report and counts[kind] != report[field]:
                            issues.append(f"Python report counts {report[field]} {field} but contains {counts[kind]} details")
                else:
                    entries = _browser(report, "--list" in command)
            for identity, kind, error in entries:
                add(identity, kind, error)
            if browser_listing:
                listed = collection(json.loads(browser_listing.read_text(encoding="utf-8")))
                observed = collection(report)
                missing, extra = listed.keys() - observed.keys(), observed.keys() - listed.keys()
                if missing or extra:
                    issues.append(f"Browser execution differs from discovery: {len(missing)} missing, {len(extra)} extra")
                for key in sorted(missing):
                    add(_browser_id(key), "not_run", "Case was listed but is missing from execution evidence")
                for key in sorted(extra):
                    add(_browser_id(key), "unexpected_case", "Case ran outside the listed collection")
        except (OSError, ValueError, KeyError, TypeError, AttributeError, ET.ParseError) as error:
            issues.append(f"Cannot read failure details from {report_path}: {error}")
    if status in {"timeout", "interrupted", "launch-error"}:
        issues.append(f"Process {status}; the selected cases may not have run")
    if result.get("error"):
        issues.append(result["error"])
    if result.get("cleanup_error"):
        issues.append(result["cleanup_error"])
    if result.get("exit_code") and not failures:
        if report_path and process_code:
            issues.append(f"Process exited {process_code} without a failing case in its report")
        add(result["gate"], "process" if process_code or not report_path else "report",
            result.get("error") or f"{status or 'command'}; exit {process_code}")
    return {"failures": failures, "report_errors": issues, "complete": not issues}
