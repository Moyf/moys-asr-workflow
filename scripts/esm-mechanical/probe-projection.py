"""Concrete fork-change and clean-Git/absent-feature counterexamples using saved real PR trees."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("esm_replay", Path(__file__).with_name("rehearse-upstream.py"))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--object-repo", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--dependencies", required=True)
    parser.add_argument("--python", required=True)
    args = parser.parse_args()
    destination, repository = Path(args.destination).resolve(), Path(args.object_repo).resolve()
    workspace = (replay.ROOT / ".worktrees").resolve()
    if workspace not in destination.parents or destination.exists() or workspace not in repository.parents:
        raise SystemExit("Use a new destination and an existing isolated repository inside .worktrees")
    replay.validate_isolated_repository(repository)
    dependencies, python = Path(args.dependencies).resolve(), Path(args.python).resolve()
    results_path = Path(args.results).resolve()
    data = json.loads(results_path.read_text(encoding="utf-8"))
    base = data["migrationCommit"]
    prs = {p["number"]: p for p in data["prs"]}
    incoming = prs[180]["replay"]["commit"]
    destination.mkdir(parents=True)
    proof = {}
    fork = destination / "fork"
    replay.export_tree(repository, base, fork)
    replay.attach_tools(fork, dependencies, data["base"])
    boot = fork / "web/editor/boot/editor-boot.js"
    source = boot.read_text(encoding="utf-8")
    if source.count("yield;\n") != 1:
        raise RuntimeError("Unknown boot shape; refuse fixture injection")
    boot.write_text(source.replace("yield;\n", 'yield;\nwindow.__forkMergeRehearsal = "preserved";\n', 1), encoding="utf-8", newline="\n")
    replay.run(["node", fork / "scripts/esm-mechanical/full-build.mjs", "--write", fork])
    fork_ref = replay.snapshot_case(repository, fork, base)
    merged = replay.project_merge(repository, base, fork_ref, incoming, "real-fork")
    if not merged["clean"]:
        raise RuntimeError("Nonoverlapping real fork fixture unexpectedly conflicted")
    target = destination / "fork-projected"
    ref = replay.commit_tree(repository, merged["tree"], [fork_ref, incoming], "Isolated real fork preservation probe")
    replay.export_tree(repository, ref, target)
    replay.attach_tools(target, dependencies, data["base"])
    replay.run(["node", target / "scripts/esm-mechanical/full-build.mjs", "--write", target])
    result = replay.run(["node", target / "scripts/esm-mechanical/verify-upstream.mjs", target, python, "--fork-probe"])
    proof["nonoverlappingFork"] = {"merge": merged, "browser": json.loads(result.stdout)}
    overlap = destination / "fork-overlap"
    replay.export_tree(repository, base, overlap)
    replay.attach_tools(overlap, dependencies, data["base"])
    file = overlap / "web/editor/styles/editor-wiring-ass-preview.js"
    source = file.read_text(encoding="utf-8")
    old = "return assPreviewExportFontSize(style, metrics) * metrics.scaleY * assPreviewFontScale(style);"
    if source.count(old) != 1:
        raise RuntimeError("Unknown ASS font calculation; refuse overlap fixture")
    file.write_text(source.replace(old, old[:-1] + " * 1.1;"), encoding="utf-8", newline="\n")
    overlap_ref = replay.snapshot_case(repository, overlap, base)
    conflict = replay.project_merge(repository, base, overlap_ref, incoming, "real-overlap")
    if conflict["clean"] or "web/editor/styles/editor-wiring-ass-preview.js" not in conflict["conflicts"]:
        raise RuntimeError("Real overlapping logic must remain a conflict")
    proof["overlappingFork"] = conflict
    for number in (177, 178):
        direct = destination / f"direct-{number}"
        replay.export_tree(repository, prs[number]["direct"]["tree"], direct)
        replay.attach_tools(direct, dependencies, data["base"])
        expected = results_path.parent / f"pr-{number}-classic"
        result = replay.run(["node", direct / "scripts/esm-mechanical/verify-upstream.mjs", direct, python,
                             "--expected-root", expected], accepted=(1,))
        verdict = json.loads(result.stdout)
        if verdict["freshness"]:
            raise RuntimeError("Direct clean merge unexpectedly repaired the artifact")
        if number == 177 and (verdict["file"]["checks"].get("wordTiming") or verdict["http"]["checks"].get("wordTiming")):
            raise RuntimeError("The missing word timing module counterexample was not reproduced")
        proof[f"direct{number}"] = verdict
        replay.save(destination / "proof.json", proof)
    replay.save(destination / "proof.json", proof)
    print(json.dumps({"forkPreserved": True, "overlapReported": True, "direct177And178RemainRed": True}))


if __name__ == "__main__":
    main()
