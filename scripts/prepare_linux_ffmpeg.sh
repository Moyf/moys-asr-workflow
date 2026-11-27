#!/usr/bin/env bash
# Prepare the pinned Linux x86_64 tools for both media tests and AppImage packaging.
set -euo pipefail

cache=${1:?Usage: prepare_linux_ffmpeg.sh CACHE_DIRECTORY TOOLS_DIRECTORY}
tools=${2:?Missing tools directory}
mirror_tag=8.1-2
branch=${mirror_tag%-*}
asset="ffmpeg-n$branch-latest-linux64-gpl-shared-$branch.tar.xz"
mirror=https://github.com/mifi/ffmpeg-builds/releases
url="$mirror/download/$mirror_tag/$asset"
sha256=e38c73e90720e4ec26f93a959c888657f865bf513e1ea6a92ce2fc15730280b8
version=n8.1.3-18-g46d899d7a0-20261020
cache="$cache/$mirror_tag"
mkdir -p "$cache"
archive="$cache/$asset"

input=$archive
if [[ ! -f "$archive" ]]; then
    input=$(mktemp "$cache/download.XXXXXXXX")
    trap 'rm -f -- "$input"' EXIT
    curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 120 \
        --output "$input" "$url"
fi
if ! printf '%s  %s\n' "$sha256" "$input" | sha256sum --check --strict; then
    if [[ "$input" == "$archive" ]]; then
        printf 'Cached FFmpeg archive is invalid. Remove %s and retry.\n' "$archive" >&2
    fi
    exit 1
fi
if [[ "$input" != "$archive" ]]; then
    mv -f -- "$input" "$archive"
fi

mkdir "$tools"
tar -xf "$archive" -C "$tools" --strip-components=1 --wildcards \
    '*/bin/ffmpeg' '*/bin/ffprobe' '*/lib/lib*.so*' '*/LICENSE.txt'
mv "$tools/LICENSE.txt" "$tools/GPLv3.txt"
for tool in ffmpeg ffprobe; do
    actual=$("$tools/bin/$tool" -version | awk 'NR == 1 { print $3 }')
    if [[ "$actual" != "$version" ]]; then
        printf '%s: expected %s, got %s\n' "$tool" "$version" "$actual" >&2
        exit 1
    fi
done
cat > "$tools/SOURCE.txt" <<EOF
FFmpeg $version — BtbN Linux x86_64 gpl-shared build mirrored by LosslessCut.
Build provider: https://github.com/BtbN/FFmpeg-Builds
BtbN build recipe and dependency pins (autobuild-2026-10-20-13-08): https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/63ac3265b0789ea16c7b1f8351cd2ad195a28722
Mirror release: $mirror/tag/$mirror_tag
Original archive: $url
Archive SHA-256: $sha256
Corresponding FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/46d899d7a02bc63237472cc4897258d5ddf274ac
License: GPL-3.0 (GPLv3.txt is the original archive's LICENSE.txt).
The AppImage includes ffmpeg, ffprobe, and their libav* and libsw* shared libraries.
EOF
