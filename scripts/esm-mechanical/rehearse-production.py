"""Replay the reviewed partial factory batch against pinned real upstream PRs."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import uuid

spec = importlib.util.spec_from_file_location("replay", Path(__file__).with_name("rehearse-upstream.py"))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)
ROOT = replay.ROOT
CONSUMERS = ("edit.py",)
TOOLS = ("scripts/build-editor.mjs", "scripts/migrate-editor-factories.mjs")


def resolve_text(text, rules):
    """Accept only reviewed, exact two-sided hunks; never select a whole file."""
    pattern = re.compile(r"^<<<<<<< [^\n]+\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]+\n", re.M | re.S)
    matches = list(pattern.finditer(text))
    if not matches or len(matches) != len(rules):
        raise RuntimeError("Reviewed hunk count differs from actual conflicts")
    output, previous = [], 0
    for match, rule in zip(matches, rules):
        if match.group(1) != rule["ours"] or match.group(2) != rule["theirs"]:
            raise RuntimeError("Conflict changed; reviewed resolution no longer applies")
        output.extend((text[previous:match.start()], rule["replacement"]))
        previous = match.end()
    output.append(text[previous:])
    result = "".join(output)
    if re.search(r"^(<<<<<<<|=======|>>>>>>>)", result, re.M):
        raise RuntimeError("Unresolved or nested conflict markers")
    return result


def resolve_reviewed(repository, attempt, definition, head):
    if definition.get("head") != head or set(definition.get("files", {})) != set(attempt["conflicts"]):
        raise RuntimeError("Resolution must match the pinned HEAD and every conflict file")
    index = repository.parent / "indices" / ("reviewed-" + uuid.uuid4().hex + ".index")
    index.parent.mkdir(exist_ok=True)
    env = dict(os.environ, GIT_INDEX_FILE=str(index.resolve()))
    replay.git(repository, "read-tree", attempt["tree"], env=env)
    evidence = []
    for filename, rules in definition["files"].items():
        replay.validate_export_paths([filename])
        source = replay.git(repository, "show", attempt["tree"] + ":" + filename).stdout.decode("utf-8")
        resolved = resolve_text(source, rules)
        blob = replay.decode(replay.git(repository, "hash-object", "-w", "--stdin", data=resolved.encode("utf-8")))
        mode = replay.decode(replay.git(repository, "ls-tree", attempt["tree"], "--", filename)).split()[0]
        replay.git(repository, "update-index", "--cacheinfo", f"{mode},{blob},{filename}", env=env)
        evidence.append({"file": filename, "reviewedHunks": len(rules), "blob": blob})
    return {"clean": True, "tree": replay.decode(replay.git(repository, "write-tree", env=env)),
            "conflicts": [], "originalConflicts": attempt["conflicts"], "reviewedResolutions": evidence}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--object-repo", required=True)
    parser.add_argument("--base", required=True, help="Classic baseline before migration")
    parser.add_argument("--migration-ref", required=True, help="Reviewed production migration commit")
    parser.add_argument("--fork-ref", required=True, help="Actual partial ESM fork, including type fixes")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--dependencies", required=True)
    parser.add_argument("--resolutions", help="Reviewed exact-hunk JSON; changed hunks always stop")
    parser.add_argument("--adapt-types", action="store_true", help="Apply reviewed type-only adapters for exact pinned heads")
    parser.add_argument("--prs", help="Explicit comma-separated PR subset from the snapshot")
    args = parser.parse_args()
    destination = Path(args.destination).resolve()
    repository = Path(args.object_repo).resolve()
    dependencies = Path(args.dependencies).resolve()
    if (ROOT / ".worktrees").resolve() not in destination.parents or destination.exists():
        raise SystemExit("Use a new destination inside .worktrees")
    replay.validate_isolated_repository(repository)
    if not (dependencies / "esbuild").is_dir():
        raise SystemExit("Installed esbuild dependency directory is required")
    refs = [replay.decode(replay.git(repository, "rev-parse", value + "^{commit}"))
            for value in (args.base, args.migration_ref, args.fork_ref)]
    base, migration, fork = refs
    batch = json.loads(replay.git(repository, "show", migration + ":web/editor-modules.json").stdout)
    selected = [module["file"] for module in batch["modules"]]
    snapshot_path = Path(args.snapshot)
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if snapshot["repository"] != "Moyf/moys-asr-workflow":
        raise SystemExit("Unexpected upstream repository")
    if args.prs:
        selected_prs = {int(value) for value in args.prs.split(',')}
        if selected_prs - {pr['number'] for pr in snapshot['prs']}:
            raise SystemExit('Selected PR absent from snapshot')
        snapshot['prs'] = [pr for pr in snapshot['prs'] if pr['number'] in selected_prs]
    resolutions = json.loads(Path(args.resolutions).read_text(encoding="utf-8")) if args.resolutions else {}
    destination.mkdir(parents=True)

    def prepare(classic, target):
        replay.export_tree(repository, classic, target)
        replay.attach_tools(target, dependencies, base)
        replay.validate_editor_manifest(target)
        # This batch's consumer adaptation is only valid when the incoming PR
        # leaves those classic consumers unchanged. Otherwise require review.
        for filename in CONSUMERS:
            baseline = replay.git(repository, "show", base + ":" + filename).stdout
            if (target / filename).read_bytes() != baseline:
                raise RuntimeError("Incoming consumer changed; manual adaptation required: " + filename)
            (target / filename).write_bytes(replay.git(repository, "show", migration + ":" + filename).stdout)
        for filename in TOOLS:
            output = target / filename
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / filename, output)
        replay.run(["node", "--input-type=module", "-e",
                    "const {applyMigration}=await import(process.argv[1]); "
                    "console.log(JSON.stringify(applyMigration(process.argv[2],JSON.parse(process.argv[3]))));",
                    (target / TOOLS[1]).as_uri(), target, json.dumps(selected)])
        replay.run(["node", target / TOOLS[0], "--write", target])
        return replay.snapshot_case(repository, target, classic, stage=TOOLS)

    # All three trees must use exactly the same mechanical representation.
    projected_base = prepare(base, destination / "migrated-base")
    replay.DERIVED = ("web/editor/boot/editor-bundle.js", "web/editor/boot/editor-bundle.meta.json")
    results = {"scope": "actual partial production fork; individual PR build + Node + type validation",
               "base": base, "migration": migration, "fork": fork, "esmFactories": len(selected),
               "snapshotSha256": hashlib.sha256(snapshot_path.read_bytes()).hexdigest(),
               "toolHashes": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in TOOLS},
               "projectedBase": projected_base,
               "prs": []}
    if args.resolutions:
        results["resolutionSha256"] = hashlib.sha256(Path(args.resolutions).read_bytes()).hexdigest()
    failed = False
    for pr in snapshot["prs"]:
        head, number = pr["head"]["sha"], pr["number"]
        row = {"number": number, "head": head, "url": pr["url"],
               "classic": replay.merge(repository, base, head), "direct": replay.merge(repository, fork, head)}
        results["prs"].append(row)
        replay.save(destination / "results.json", results)
        if not row["classic"]["clean"]:
            row["status"] = "blocked-original-conflict"
            failed = True
        else:
            try:
                classic = replay.commit_tree(repository, row["classic"]["tree"], [base, head], "Isolated classic production rehearsal")
                incoming = prepare(classic, destination / f"pr-{number}-incoming")
                projected = replay.project_merge(repository, projected_base, fork, incoming, f"production-{number}")
                row["unresolvedProjection"] = projected
                if not projected["clean"] and str(number) in resolutions:
                    projected = resolve_reviewed(repository, projected, resolutions[str(number)], head)
                row["projected"] = projected
                if not projected["clean"]:
                    row["status"] = "blocked-fork-source-conflict"
                    failed = True
                else:
                    candidate = replay.commit_tree(repository, projected["tree"], [fork, incoming], "Isolated partial ESM projection")
                    target = destination / f"pr-{number}-projected"
                    replay.export_tree(repository, candidate, target)
                    replay.attach_tools(target, dependencies, base)
                    if args.adapt_types and number in (177, 179, 180):
                        adapter = ROOT / "scripts/esm-mechanical/adapt-production-types.mjs"
                        row["typeAdapterSha256"] = hashlib.sha256(adapter.read_bytes()).hexdigest()
                        replay.run(["node", adapter, target, number, head])
                    replay.run(["node", target / TOOLS[0], "--write", target])
                    row["sources"] = len(replay.validate_editor_manifest(target))
                    validation = replay.run(["node", "--test", *sorted((target / "tests").glob("test_*.mjs"))],
                                            cwd=target, accepted=(0, 1))
                    (target / "node.log").write_bytes(validation.stdout + validation.stderr)
                    row["nodeExit"] = validation.returncode
                    typecheck = replay.run(["node", target / "node_modules/typescript/bin/tsc", "-p", "tsconfig.typecheck.json"],
                                           cwd=target, accepted=(0, 1, 2))
                    (target / "typecheck.log").write_bytes(typecheck.stdout + typecheck.stderr)
                    row["typecheckExit"] = typecheck.returncode
                    row["typeDiagnostics"] = typecheck.stdout.count(b"error TS")
                    row["status"] = "validated-build-and-node" if not validation.returncode else "blocked-node-validation"
                    if typecheck.returncode:
                        row["status"] = "blocked-type-validation"
                    failed |= bool(validation.returncode or typecheck.returncode)
                    final = replay.snapshot_case(repository, target, candidate)
                    namespace = "refs/esm-rehearsal/production-" + hashlib.sha256(str(destination).encode()).hexdigest()[:12]
                    replay.git(repository, "update-ref", namespace + f"/candidate-{number}", final)
                    row["candidateRef"] = namespace + f"/candidate-{number}"
                    (destination / f"pr-{number}-projected.patch").write_bytes(replay.git(repository, "diff", "--binary", fork, final).stdout)
            except Exception as error:
                row["status"] = "blocked-adaptation-or-build"
                row["reason"] = str(error).replace(str(ROOT), "<repository>")
                failed = True
        replay.save(destination / "results.json", results)
        print(json.dumps({"pr": number, "directConflicts": len(row["direct"]["conflicts"]), "status": row["status"]}), flush=True)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
