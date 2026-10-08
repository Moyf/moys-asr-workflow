"""Read missing GitHub Git objects through gh; verify every original object SHA."""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import itertools
import json
from pathlib import Path, PurePosixPath
import subprocess
import time

API_CACHE = None


def call(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=40)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[-1500:])
    return result.stdout


def api(repository, suffix):
    cache = API_CACHE / (hashlib.sha256((repository + suffix).encode()).hexdigest() + ".json") if API_CACHE else None
    if cache and cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    for attempt in range(3):
        try:
            value = json.loads(call(["gh", "api", f"repos/{repository}/git/{suffix}"]))
            break
        except (RuntimeError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    if cache and not suffix.startswith("blobs/"):
        cache.write_text(json.dumps(value), encoding="utf-8", newline="\n")
    return value


def object_hash(kind, payload):
    return hashlib.sha1(f"{kind} {len(payload)}\0".encode() + payload).hexdigest()


def commit_payload(meta):
    """REST dates omit timezone; recover only if the exact commit hash matches."""
    verification = meta.get("verification", {})
    if verification.get("payload") and verification.get("signature"):
        header, body = verification["payload"].split("\n\n", 1)
        signature = verification["signature"].rstrip("\n").splitlines()
        signed = header + "\ngpgsig " + "\n ".join(signature) + "\n\n" + body
        if object_hash("commit", signed.encode()) == meta["sha"]:
            return signed.encode()
    # No inferred object is accepted. Unusual encodings, extra headers or date
    # offsets outside this finite set fail and require normal Git transport.
    offsets = ["+0000", "+0800", "-0700", "-0800"]
    offsets += [f"{'+' if minute >= 0 else '-'}{abs(minute)//60:02}{abs(minute)%60:02}"
                for minute in range(-12 * 60, 14 * 60 + 1, 15)]
    offsets = list(dict.fromkeys(offsets))
    prefix = "tree " + meta["tree"]["sha"] + "\n"
    prefix += "".join("parent " + p["sha"] + "\n" for p in meta["parents"])
    dates = {key: int(datetime.fromisoformat(meta[key]["date"].replace("Z", "+00:00")).timestamp())
             for key in ("author", "committer")}
    for author_offset, committer_offset, ending in itertools.product(offsets, offsets, ("", "\n")):
        content = prefix
        for key, offset in (("author", author_offset), ("committer", committer_offset)):
            identity = meta[key]
            content += f"{key} {identity['name']} <{identity['email']}> {dates[key]} {offset}\n"
        payload = (content + "\n" + meta["message"] + ending).encode("utf-8")
        if object_hash("commit", payload) == meta["sha"]:
            return payload
    raise RuntimeError(f"Cannot reconstruct exact commit {meta['sha']}; no synthetic replacement permitted")


def main():
    global API_CACHE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--object-repo", required=True)
    parser.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    repository = Path(args.object_repo).resolve()
    if (root / ".worktrees").resolve() not in repository.parents or not (repository / ".git").is_dir():
        raise SystemExit("Object writes are restricted to an isolated clone inside .worktrees")
    directory = (repository / ".git").resolve()
    common = Path(call(["git", "-C", str(repository), "rev-parse", "--path-format=absolute", "--git-common-dir"]).decode().strip()).resolve()
    if directory.parent != repository or common != directory:
        raise SystemExit("Shared or external Git directory; object writes refused")
    snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
    upstream = snapshot["repository"]
    if upstream != "Moyf/moys-asr-workflow":
        raise SystemExit("Unexpected upstream")
    API_CACHE = repository / ".git/esm-api-cache"
    API_CACHE.mkdir(exist_ok=True)
    def git(*arguments, data=None):
        return call(["git", "-C", str(repository), *arguments], data=data)
    known = {line.split()[0] for line in git("rev-list", "--objects", "--all").decode().splitlines()}
    checked = {}
    def exists(sha):
        if sha in known:
            return True
        if sha not in checked:
            checked[sha] = subprocess.run(["git", "-C", str(repository), "cat-file", "-e", sha], capture_output=True).returncode == 0
        return checked[sha]
    def store(kind, payload, sha):
        if object_hash(kind, payload) != sha:
            raise RuntimeError("GitHub object hash mismatch")
        actual = git("hash-object", "-w", "-t", kind, "--stdin", data=payload).decode().strip()
        if actual != sha:
            raise RuntimeError("Stored object differs from expected SHA")
    pending = [p["head"]["sha"] for p in snapshot["prs"]]
    commits = {}
    while pending:
        sha = pending.pop()
        if sha in commits or exists(sha):
            continue
        meta = api(upstream, "commits/" + sha)
        commits[sha] = {"meta": meta, "payload": commit_payload(meta)}
        pending += [p["sha"] for p in meta["parents"]]
    print(json.dumps({"missingCommits": len(commits), "phase": "fetch-trees"}), flush=True)
    missing_blobs = set()
    trees = {}
    for item in commits.values():
        sha = item["meta"]["tree"]["sha"]
        if sha in trees or exists(sha):
            continue
        entries = api(upstream, "trees/" + sha + "?recursive=1")
        if entries.get("truncated"):
            raise RuntimeError("Truncated tree is not usable")
        if any(PurePosixPath(e["path"]).name == ".env" for e in entries["tree"]):
            raise RuntimeError("Ref contains tracked .env; fetch refused")
        groups = {"": []}
        for entry in entries["tree"]:
            path = PurePosixPath(entry["path"])
            if path.is_absolute() or ".." in path.parts or entry["mode"] in ("120000", "160000"):
                raise RuntimeError("Unsupported link or unsafe tree path")
            parent = str(path.parent) if str(path.parent) != "." else ""
            groups.setdefault(parent, []).append((path.name, entry["mode"], entry["sha"]))
            if entry["type"] == "tree":
                groups.setdefault(str(path), [])
            elif entry["type"] == "blob" and not exists(entry["sha"]):
                missing_blobs.add(entry["sha"])
        subtree_oids = {e["path"]: e["sha"] for e in entries["tree"] if e["type"] == "tree"}
        subtree_oids[""] = sha
        for folder, children in groups.items():
            children.sort(key=lambda x: x[0].encode() + (b"/" if x[1] == "040000" else b""))
            payload = b"".join(str(int(mode)).encode() + b" " + name.encode() + b"\0" + bytes.fromhex(oid)
                               for name, mode, oid in children)
            trees[subtree_oids[folder]] = payload
    def fetch_blob(sha):
        blob = api(upstream, "blobs/" + sha)
        if blob.get("encoding") != "base64":
            raise RuntimeError("Unexpected blob encoding")
        store("blob", base64.b64decode(blob["content"]), sha)
        return sha
    print(json.dumps({"missingBlobs": len(missing_blobs), "phase": "fetch-blobs"}), flush=True)
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(fetch_blob, sorted(missing_blobs)))
    for sha, payload in trees.items():
        store("tree", payload, sha)
    for sha, item in commits.items():
        store("commit", item["payload"], sha)
    for pr in snapshot["prs"]:
        git("rev-list", "--objects", "--missing=error", pr["head"]["sha"])
        git("update-ref", f"refs/esm-rehearsal/upstream/pr-{int(pr['number'])}", pr["head"]["sha"])
    print(json.dumps({"commits": len(commits), "trees": len(trees), "blobs": len(missing_blobs),
                      "allPinnedHeadsComplete": True}), flush=True)


if __name__ == "__main__":
    main()
