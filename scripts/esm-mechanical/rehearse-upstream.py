"""Replay pinned upstream PRs in an isolated repository; never merge the caller's checkout."""
from __future__ import annotations

import argparse
import ast
import difflib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
DERIVED = ("web/editor/boot/editor-bundle.js", "full-metafile.json")


def run(args, *, cwd=None, env=None, accepted=(0,), data=None):
    result = subprocess.run([str(x) for x in args], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, input=data)
    if result.returncode not in accepted:
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0:3]}\n"
                           + result.stderr.decode("utf-8", errors="replace")[-2000:])
    return result


def git(repository, *args, accepted=(0,), env=None, data=None):
    return run(["git", "-C", repository, *args], accepted=accepted, env=env, data=data)


def decode(result):
    return result.stdout.decode("utf-8").strip()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def validate_isolated_repository(repository):
    if (ROOT / ".worktrees").resolve() not in repository.parents or not (repository / ".git").is_dir():
        raise RuntimeError("Use a standalone isolated clone, not an existing managed worktree")
    directory = (repository / ".git").resolve()
    common = Path(decode(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"))).resolve()
    if directory.parent != repository or common != directory:
        raise RuntimeError("Git directory is shared or escapes the isolated clone")


def merge(repository, ours, theirs, ancestor=None):
    args = ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z"]
    if ancestor:
        args += [f"--merge-base={ancestor}"]
    result = git(repository, *args, ours, theirs, accepted=(0, 1))
    fields = result.stdout.decode("utf-8").split("\0")
    tree = fields[0]
    if len(tree) != 40:
        raise RuntimeError("merge-tree returned no valid tree")
    return {"clean": result.returncode == 0, "tree": tree,
            "conflicts": [field for field in fields[1:] if field]}


def export_tree(repository, ref, target):
    # Refuse sensitive paths before archive reads any tracked content.
    paths = git(repository, "ls-tree", "-rz", "--name-only", ref).stdout.decode("utf-8").split("\0")
    validate_export_paths(paths)
    if target.exists():
        raise RuntimeError("Export never overwrites an existing directory")
    target.mkdir(parents=True)
    if not any(paths):
        return  # Git emits a PAX-only archive for an empty tree.
    data = git(repository, "archive", "--format=tar", ref).stdout
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for member in archive:
            relative = PurePosixPath(member.name)
            if relative.is_absolute() or ".." in relative.parts or member.issym() or member.islnk():
                raise RuntimeError("Unsafe archive path or link")
            output = target.joinpath(*relative.parts)
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(archive.extractfile(member).read())


def validate_export_paths(paths):
    for name in filter(None, paths):
        path = PurePosixPath(name)
        if path.name == ".env":
            raise RuntimeError("Ref contains a tracked .env; export refused")
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError("Unsafe export path")


def attach_tools(target, dependencies, base):
    shutil.copytree(ROOT / "scripts/esm-mechanical", target / "scripts/esm-mechanical", dirs_exist_ok=True)
    save(target / ".esm-mechanical-sandbox.json", {"purpose": "esm-mechanical-research", "baseline": base})
    link = target / "node_modules"
    if os.name == "nt":
        env = dict(os.environ, MAW_REPLAY_LINK=str(link), MAW_REPLAY_DEPENDENCIES=str(dependencies))
        run(["powershell", "-NoProfile", "-Command",
             "New-Item -ItemType Junction -Path $env:MAW_REPLAY_LINK -Value $env:MAW_REPLAY_DEPENDENCIES | Out-Null"], env=env)
    else:
        link.symlink_to(dependencies, target_is_directory=True)


def commit_tree(repository, tree, parent, message):
    parents = [parent] if isinstance(parent, str) else list(parent)
    arguments = [argument for value in parents for argument in ("-p", value)]
    return decode(git(repository, "commit-tree", tree, *arguments, "-m", message))


def snapshot_case(repository, target, parent, *, stage=()):
    # A separate index prevents changing the isolated clone's own index, too.
    identity = hashlib.sha256(str(target).encode()).hexdigest()[:16]
    index = repository.parent / "indices" / (target.name + "-" + identity + ".index")
    index.parent.mkdir(exist_ok=True)
    env = dict(os.environ, GIT_INDEX_FILE=str(index.resolve()))
    command = ["git", f"--git-dir={repository / '.git'}", f"--work-tree={target}"]
    run(command + ["read-tree", parent], env=env)
    run(command + ["add", "-A", "--", "web", "edit.py", "tests", *stage], env=env)
    tree = decode(run(command + ["write-tree"], env=env))
    return commit_tree(repository, tree, parent, "Isolated ESM rehearsal snapshot")


def without_derived(repository, commit, label):
    index = repository.parent / "indices" / (label + "-" + uuid.uuid4().hex + ".index")
    index.parent.mkdir(exist_ok=True)
    env = dict(os.environ, GIT_INDEX_FILE=str(index.resolve()))
    git(repository, "read-tree", commit, env=env)
    git(repository, "update-index", "--force-remove", "--", *DERIVED, env=env)
    tree = decode(git(repository, "write-tree", env=env))
    return commit_tree(repository, tree, commit, "Isolated source-only comparison snapshot")


def convert(repository, classic_ref, target, dependencies):
    export_tree(repository, classic_ref, target)
    attach_tools(target, dependencies, classic_ref)
    validate_editor_manifest(target)
    result = run(["node", target / "scripts/esm-mechanical/full-convert.mjs", target])
    conversion = json.loads(result.stdout)
    run(["node", target / "scripts/esm-mechanical/full-build.mjs", "--write", target])
    run(["node", target / "scripts/esm-mechanical/adapt-tests.mjs", target])
    commit = snapshot_case(repository, target, classic_ref, stage=("full-conversion.json",))
    return commit, conversion


def validate_editor_manifest(root):
    files = [line.split("#")[0].strip() for line in (root / "web/editor-scripts.txt").read_text(encoding="utf-8").splitlines()
             if line.split("#")[0].strip()]
    if not files or len(files) != len(set(files)):
        raise RuntimeError("Empty or duplicate editor input manifest")
    web = (root / "web").resolve()
    for filename in files:
        path = PurePosixPath(filename)
        if not filename.endswith(".js") or "\\" in filename or ":" in filename or path.is_absolute() or any(
                part in ("", ".", "..") for part in filename.split("/")):
            raise RuntimeError("Invalid editor input path")
        target = (web / filename).resolve()
        if web not in target.parents or not target.is_file():
            raise RuntimeError("Missing or escaping editor input")
    return files


def project_merge(repository, migrated_base, fork_ref, migrated_incoming, label):
    # Drop generated JS in all three versions; merge source intent at the same
    # abstraction level. A real logic conflict remains a conflict.
    ancestor = without_derived(repository, migrated_base, label + "-base")
    ours = without_derived(repository, fork_ref, label + "-ours")
    theirs = without_derived(repository, migrated_incoming, label + "-incoming")
    return merge(repository, ours, theirs, ancestor=ancestor)


def audit_direct(repository, tree):
    def names(file):
        content = decode(git(repository, "show", tree + ":" + file))
        return [line.split("#")[0].strip() for line in content.splitlines()
                if line.split("#")[0].strip() and not line.startswith(("<<<<<<<", "=======", ">>>>>>>"))]
    required = names("web/editor-scripts.txt")
    inputs = names("web/editor-sources.txt")
    return {"requiredByIncomingClassicManifest": len(required), "esmInputCount": len(inputs),
            "missingEsmInputs": [file for file in required if file not in inputs]}


def additive_text(base, ours, theirs, filename):
    """Only pure insertions; Python definitions must remain unique and intact."""
    original = base.splitlines(keepends=True)
    def insertions(text):
        lines = text.splitlines(keepends=True)
        additions = {}
        for action, start, end, left, right in difflib.SequenceMatcher(a=original, b=lines, autojunk=False).get_opcodes():
            if action not in ("equal", "insert"):
                raise RuntimeError("Additive resolver refuses replacement or deletion")
            if action == "insert":
                additions[start] = lines[left:right]
        return additions
    left, right = insertions(ours), insertions(theirs)
    result = []
    for position in range(len(original) + 1):
        a, b = left.get(position, []), right.get(position, [])
        result += a + ([] if a == b else b)
        if position < len(original):
            result.append(original[position])
    merged = "".join(result)
    if filename.endswith(".py"):
        def functions(text):
            values = {}
            def visit(body, prefix=()):
                for node in body:
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        name = prefix + (node.name,)
                        if name in values:
                            raise RuntimeError("Duplicate Python definition; human resolution required")
                        values[name] = ast.dump(node, include_attributes=False)
                    elif isinstance(node, ast.ClassDef):
                        visit(node.body, prefix + (node.name,))
            visit(ast.parse(text).body)
            return values
        expected = functions(base)
        for side in (ours, theirs):
            for name, definition in functions(side).items():
                if name in expected and expected[name] != definition:
                    raise RuntimeError("Additive resolver refuses changed Python function semantics")
                expected[name] = definition
        if functions(merged) != expected:
            raise RuntimeError("Merged Python definitions differ from the union")
    elif not filename.endswith(".md"):
        raise RuntimeError("Only explicitly selected Markdown and Python addition conflicts are supported")
    return merged


def resolve_additions(repository, ours, theirs, attempt, allowed):
    ancestor = decode(git(repository, "merge-base", ours, theirs))
    index = repository.parent / "indices" / ("additions-" + uuid.uuid4().hex + ".index")
    index.parent.mkdir(exist_ok=True)
    env = dict(os.environ, GIT_INDEX_FILE=str(index.resolve()))
    git(repository, "read-tree", attempt["tree"], env=env)
    unresolved, resolved = [], []
    for filename in attempt["conflicts"]:
        if filename not in allowed:
            unresolved.append(filename)
            continue
        validate_export_paths([filename])
        try:
            source = [git(repository, "show", ref + ":" + filename).stdout.decode("utf-8")
                      for ref in (ancestor, ours, theirs)]
            text = additive_text(*source, filename)
            blob = decode(git(repository, "hash-object", "-w", "--stdin", data=text.encode("utf-8")))
            mode = decode(git(repository, "ls-tree", ours, "--", filename)).split()[0]
            git(repository, "update-index", "--cacheinfo", f"{mode},{blob},{filename}", env=env)
            resolved.append({"file": filename, "rule": "pure-additions; Python function AST union unchanged", "blob": blob})
        except Exception as error:
            unresolved.append(filename)
            resolved.append({"file": filename, "refused": str(error)})
    return {"clean": not unresolved, "tree": decode(git(repository, "write-tree", env=env)),
            "conflicts": unresolved, "originalConflicts": attempt["conflicts"], "additiveResolutions": resolved}


def validate(case, baseline, python):
    env = dict(os.environ, PYTHONIOENCODING="utf-8", MAW_ESM_FULL_ROOT=str(case),
               MAW_ESM_BASELINE_ROOT=str(baseline), MAW_ESM_PYTHON=str(python), MAW_E2E_PYTHON=str(python))
    commands = {
        "assembly": ["node", "--test", str(case / "scripts/esm-mechanical/assembly-contract.test.mjs")],
        "node": ["node", "--test", *[str(p) for p in sorted((case / "tests").glob("test_*.mjs"))]],
    }
    result = {}
    for label, command in commands.items():
        process = run(command, cwd=case, env=env, accepted=(0, 1))
        (case / (label + ".log")).write_bytes(process.stdout + process.stderr)
        result[label] = {"exit": process.returncode, "log": case.name + "/" + label + ".log"}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--dependencies", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--base", required=True, help="Classic fork commit, pinned before migration")
    parser.add_argument("--object-repo", help="Previously prepared isolated clone; optional")
    parser.add_argument("--no-fetch", action="store_true", help="All pinned heads must already exist locally")
    parser.add_argument("--no-validation", action="store_true", help="Record build-only coverage explicitly")
    parser.add_argument("--fork-ref", help="Actual migrated fork commit, for source-level three-way projection")
    parser.add_argument("--prs", help="Comma-separated PR subset; default is the entire snapshot")
    parser.add_argument("--sequence", help="Also replay this ordered PR sequence as one combined result")
    parser.add_argument("--sequence-only", action="store_true", help="Skip individual cases; validate only the ordered combination")
    parser.add_argument("--additive-paths", default="", help="Explicitly allow pure-addition resolution in these Markdown/Python paths")
    args = parser.parse_args()
    if args.sequence_only and not args.sequence:
        raise SystemExit("--sequence-only requires --sequence")
    destination = Path(args.destination).resolve()
    if (ROOT / ".worktrees").resolve() not in destination.parents or destination.exists():
        raise SystemExit("Destination must be a new directory inside .worktrees")
    dependencies = Path(args.dependencies).resolve()
    python = Path(args.python).resolve()
    snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
    if snapshot["repository"] != "Moyf/moys-asr-workflow":
        raise SystemExit("Unexpected upstream repository")
    if args.prs:
        selected = {int(n) for n in args.prs.split(",")}
        if selected - {p["number"] for p in snapshot["prs"]}:
            raise SystemExit("PR subset contains a number absent from the pinned snapshot")
        snapshot["prs"] = [p for p in snapshot["prs"] if p["number"] in selected]
    destination.mkdir(parents=True)
    repository = Path(args.object_repo).resolve() if args.object_repo else destination / "objects"
    if args.object_repo:
        if (ROOT / ".worktrees").resolve() not in repository.parents:
            raise SystemExit("Object repository must also be isolated")
    else:
        run(["git", "clone", "--shared", "--no-checkout", "--no-hardlinks", ROOT, repository])
    validate_isolated_repository(repository)
    for key in ("user.name", "user.email"):
        git(repository, "config", key, decode(git(ROOT, "config", "--get", key)))
    base = decode(git(repository, "rev-parse", args.base + "^{commit}"))
    if not args.no_fetch:
        url = "https://github.com/" + snapshot["repository"] + ".git"
        for pr in snapshot["prs"]:
            git(repository, "-c", "http.version=HTTP/1.1", "fetch", "--no-tags", url, pr["head"]["sha"])
    for pr in snapshot["prs"]:
        git(repository, "cat-file", "-e", pr["head"]["sha"] + "^{commit}")
    baseline = destination / "baseline"
    export_tree(repository, base, baseline)
    attach_tools(baseline, dependencies, base)
    migrated = destination / "migrated"
    migrated_commit, stats = convert(repository, base, migrated, dependencies)
    fork_commit = decode(git(repository, "rev-parse", args.fork_ref + "^{commit}")) if args.fork_ref else migrated_commit
    namespace = "refs/esm-rehearsal/" + hashlib.sha256(str(destination).encode()).hexdigest()[:16]
    git(repository, "update-ref", namespace + "/migration", migrated_commit)
    results = {"base": base, "snapshotSha256": hashlib.sha256(Path(args.snapshot).read_bytes()).hexdigest(),
               "migration": stats, "migrationCommit": migrated_commit, "forkCommit": fork_commit, "prs": [],
               "validationRequested": not args.no_validation, "refNamespace": namespace,
               "coreScriptSha256": {name: hashlib.sha256((ROOT / 'scripts/esm-mechanical' / name).read_bytes()).hexdigest()
                                    for name in ('full-convert.mjs', 'full-build.mjs', 'research.mjs', 'adapt-tests.mjs')}}
    save(destination / "results.json", results)
    for pr in ([] if args.sequence_only else snapshot["prs"]):
        head = pr["head"]["sha"]
        number = pr["number"]
        record = {"number": number, "head": head, "url": pr["url"],
                  "mergeBase": decode(git(repository, "merge-base", base, head)),
                  "classic": merge(repository, base, head), "direct": merge(repository, fork_commit, head)}
        record["direct"]["inputAudit"] = audit_direct(repository, record["direct"]["tree"])
        results["prs"].append(record)
        save(destination / "results.json", results)
        if not record["classic"]["clean"]:
            record["replay"] = {"status": "blocked-classic-conflict", "reason": "Resolve original source conflict first; never choose a side automatically"}
        else:
            try:
                classic_commit = commit_tree(repository, record["classic"]["tree"], [base, head], "Isolated classic PR merge")
                git(repository, "update-ref", namespace + f"/classic-pr-{number}", classic_commit)
                case = destination / f"pr-{number}"
                replay_commit, conversion = convert(repository, classic_commit, case, dependencies)
                projected = project_merge(repository, migrated_commit, fork_commit, replay_commit, f"pr-{number}")
                record["replay"] = {"status": "built", "commit": replay_commit, "conversion": conversion,
                                    "projected": projected}
                changed = git(repository, "diff", "--name-only", migrated_commit, replay_commit).stdout.decode("utf-8").splitlines()
                record["replay"]["changedPaths"] = changed
                (destination / f"pr-{number}.patch").write_bytes(git(repository, "diff", "--binary", migrated_commit, replay_commit).stdout)
                if not projected["clean"]:
                    record["replay"]["status"] = "blocked-fork-logic-conflict"
                else:
                    # Validate the actual three-way result, not just the incoming
                    # converted tree. Never transplant over the fork wholesale.
                    projected_commit = commit_tree(repository, projected["tree"], [fork_commit, replay_commit], "Isolated projected PR sources")
                    projected_case = destination / f"pr-{number}-projected"
                    export_tree(repository, projected_commit, projected_case)
                    attach_tools(projected_case, dependencies, base)
                    run(["node", projected_case / "scripts/esm-mechanical/full-build.mjs", "--write", projected_case])
                    final_commit = snapshot_case(repository, projected_case, projected_commit)
                    record["replay"]["finalCommit"] = final_commit
                    git(repository, "update-ref", namespace + f"/candidate-pr-{number}", final_commit)
                    (destination / f"pr-{number}-projected.patch").write_bytes(git(repository, "diff", "--binary", fork_commit, final_commit).stdout)
                    classic_case = destination / f"pr-{number}-classic"
                    export_tree(repository, classic_commit, classic_case)
                    attach_tools(classic_case, dependencies, base)
                    if not args.no_validation:
                        record["replay"]["validation"] = validate(projected_case, classic_case, python)
            except Exception as error:
                record.setdefault("replay", {})
                record["replay"].update({"status": "blocked-conversion-or-validation", "reason": str(error).replace(str(ROOT), "<repository>").replace(str(destination), "<experiment>")})
        save(destination / "results.json", results)
        print(json.dumps({"pr": number, "classicConflicts": len(record["classic"]["conflicts"]),
                          "directConflicts": len(record["direct"]["conflicts"]), "replay": record["replay"]["status"]}), flush=True)
    if args.sequence:
        order = [int(n) for n in args.sequence.split(",")]
        by_number = {p["number"]: p for p in snapshot["prs"]}
        if set(order) - by_number.keys() or len(order) != len(set(order)):
            raise SystemExit("Sequence must contain distinct selected PR numbers")
        combined = {"order": order, "steps": [], "status": "merging-classic"}
        results["combined"] = combined
        state = base
        for number in order:
            attempt = merge(repository, state, by_number[number]["head"]["sha"])
            incoming_head = by_number[number]["head"]["sha"]
            if not attempt["clean"] and args.additive_paths:
                attempt = resolve_additions(repository, state, incoming_head, attempt, set(args.additive_paths.split(",")))
            combined["steps"].append({"number": number, "oursCommit": state, "theirsCommit": incoming_head, **attempt})
            save(destination / "results.json", results)
            if not attempt["clean"]:
                combined["status"] = "blocked-original-logic-conflict"
                break
            state = commit_tree(repository, attempt["tree"], [state, by_number[number]["head"]["sha"]], "Isolated sequential classic PR merge")
        else:
            try:
                case = destination / "combined"
                incoming, conversion = convert(repository, state, case, dependencies)
                projected = project_merge(repository, migrated_commit, fork_commit, incoming, "combined")
                combined.update({"conversion": conversion, "projected": projected})
                if not projected["clean"]:
                    combined["status"] = "blocked-fork-logic-conflict"
                else:
                    commit = commit_tree(repository, projected["tree"], [fork_commit, incoming], "Isolated combined projected sources")
                    target = destination / "combined-projected"
                    export_tree(repository, commit, target)
                    attach_tools(target, dependencies, base)
                    run(["node", target / "scripts/esm-mechanical/full-build.mjs", "--write", target])
                    final = snapshot_case(repository, target, commit)
                    git(repository, "update-ref", namespace + "/classic-combined", state)
                    git(repository, "update-ref", namespace + "/candidate-combined", final)
                    (destination / "combined-projected.patch").write_bytes(git(repository, "diff", "--binary", fork_commit, final).stdout)
                    reference = destination / "combined-classic"
                    export_tree(repository, state, reference)
                    attach_tools(reference, dependencies, base)
                    combined.update({"status": "built", "finalCommit": final, "classicCommit": state})
                    if not args.no_validation:
                        combined["validation"] = validate(target, reference, python)
            except Exception as error:
                combined.update({"status": "blocked-conversion-or-validation", "reason": str(error).replace(str(ROOT), "<repository>")})
        save(destination / "results.json", results)
        print(json.dumps({"sequence": order, "status": combined["status"]}), flush=True)
    has_red = any(p["replay"]["status"].startswith("blocked") or
                  any(v["exit"] for v in p["replay"].get("validation", {}).values()) for p in results["prs"])
    if "combined" in results:
        has_red |= results["combined"]["status"].startswith("blocked") or any(
            v["exit"] for v in results["combined"].get("validation", {}).values())
    return 1 if has_red else 0


if __name__ == "__main__":
    raise SystemExit(main())
