"""Resolve a Linux static FFmpeg asset and its release tag from one snapshot."""
import json
import re
import sys


def select_release(release, branch):
    tag = release["tag_name"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", tag):
        raise ValueError("invalid FFmpeg release tag")
    names = [asset["name"] for asset in release["assets"]]
    branch_re = re.escape(branch)
    exact = rf"ffmpeg-n{branch_re}(?:-latest|\.\d+(?:-\d+-g[0-9a-f]+)?)-linux64-gpl-{branch_re}\.tar\.xz"
    matches = [name for name in names if re.fullmatch(exact, name)]
    legacy = f"ffmpeg-n{branch}-latest-linux64-gpl-{branch}.tar.xz"
    if names.count("checksums.sha256") != 1:
        raise ValueError("missing or ambiguous FFmpeg checksum manifest")
    if matches.count(legacy) == 1:
        return tag, legacy
    if len(matches) == 1:
        return tag, matches[0]
    raise ValueError(f"expected one static Linux x86_64 GPL FFmpeg {branch} archive")


if __name__ == "__main__":
    try:
        print(*select_release(json.load(sys.stdin), sys.argv[1]))
    except (KeyError, TypeError, ValueError) as error:
        sys.exit(f"Cannot resolve upstream FFmpeg: {error}")
