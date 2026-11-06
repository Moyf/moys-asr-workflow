"""Observable legacy import boundary; strict validation stays in project.py."""

from __future__ import annotations

import copy
from dataclasses import dataclass

from maw.project import (
    ProjectValidationFailed, ProjectValidationResult, repair_project_timing_ranges,
    validate_project,
)
from maw.project_preview import JsonDict, JsonValue


def project_changes(before: JsonValue, after: JsonValue, path: str = "$") -> list[JsonDict]:
    """JSON differences, including presence, without exposing unrelated content."""
    if isinstance(before, dict) and isinstance(after, dict):
        changes: list[JsonDict] = []
        for key in sorted(before.keys() | after.keys()):
            child = f"{path}.{key}"
            if key not in before:
                changes.append({"path": child, "kind": "add", "after": after[key]})
            elif key not in after:
                changes.append({"path": child, "kind": "remove", "before": before[key]})
            else:
                changes.extend(project_changes(before[key], after[key], child))
        return changes
    if isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        return [change for i, (left, right) in enumerate(zip(before, after))
                for change in project_changes(left, right, f"{path}[{i}]")]
    if type(before) is not type(after) or before != after:
        return [{"path": path, "kind": "replace", "before": before, "after": after}]
    return []


@dataclass(frozen=True)
class ProjectImportResult:
    validation: ProjectValidationResult
    changes: tuple[JsonDict, ...]

    def to_json(self) -> JsonDict:
        return {**self.validation.to_json(), "changes": list(self.changes)}


def prepare_project(project: JsonValue, *, repair: bool = True) -> ProjectImportResult:
    """Validate first, then repair only numeric timing violations on a copy.

    Missing legacy IDs/schema/defaults are reported as additions. Invalid types,
    IDs, references and future schemas never enter a destructive normalizer.
    """
    result = validate_project(project)
    timing_messages = {
        "must be non-negative", "must be greater than start",
        "must be >= previous segment end", "must be within segment bounds",
        "must be within segment bounds and >= start", "must be >= previous item end",
    }
    if not result.ok and repair and all(
        error.path.endswith((".start", ".end")) and error.message in timing_messages
        for error in result.errors
    ):
        candidate = copy.deepcopy(project)
        repair_project_timing_ranges(candidate)
        result = validate_project(candidate)
    changes = project_changes(project, result.project) if result.ok else []
    return ProjectImportResult(result, tuple(changes))


def import_project(project: JsonValue) -> JsonDict:
    """Convenience boundary for CLI readers; emit the same report as the server."""
    result = prepare_project(project)
    if result.validation.project is None:
        raise ProjectValidationFailed(result.validation.errors)
    timing = [change for change in result.changes if change["kind"] == "replace"
              and str(change["path"]).endswith((".start", ".end"))]
    if timing:
        print("[project] repaired timing: " + ", ".join(str(change["path"]) for change in timing))
    return result.validation.project


def main() -> int:
    """Read-only diagnostic CLI; never writes the candidate over the input."""
    import argparse
    import json
    from pathlib import Path

    parser = argparse.ArgumentParser(description="Validate/import a legacy MAW project without writing it")
    parser.add_argument("project", type=Path)
    parser.add_argument("--strict", action="store_true", help="do not repair timing ranges")
    args = parser.parse_args()
    result = prepare_project(json.loads(args.project.read_text(encoding="utf-8")), repair=not args.strict)
    print(json.dumps(result.to_json(), ensure_ascii=False))
    return 0 if result.validation.ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
