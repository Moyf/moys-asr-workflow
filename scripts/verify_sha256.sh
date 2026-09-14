#!/usr/bin/env bash
# 按 checksums 清单校验单个文件的 SHA-256。
# 用法：verify_sha256.sh <checksums-file> <asset-name> <target-file>
# 退出码：0 通过；1 清单或文件缺失、清单无该资产条目、哈希不匹配；2 用法错误。
#
# 上游 checksums（如 BtbN FFmpeg-Builds）每行只写裸文件名。把这种行直接喂给
# `sha256sum -c` 时，文件名按调用方的当前目录解析，而下载物通常落在子目录
# （build-appimage/ 之于仓库根），于是报 "No such file or directory"，被误判成
# 完整性校验失败。这里对传入的目标路径自行计算哈希再比对，校验与当前目录无关。
set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "用法：$0 <checksums-file> <asset-name> <target-file>" >&2
    exit 2
fi

CHECKSUMS="$1"
ASSET="$2"
TARGET="$3"

if [ ! -f "$CHECKSUMS" ]; then
    echo "错误：checksums 清单不存在（$CHECKSUMS）。" >&2
    exit 1
fi
if [ ! -f "$TARGET" ]; then
    echo "错误：待校验文件不存在（$TARGET）。" >&2
    exit 1
fi

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1; exit }' "$CHECKSUMS")"
if [ -z "$EXPECTED" ]; then
    echo "错误：checksums 清单中没有 $ASSET 的条目（$CHECKSUMS）。" >&2
    exit 1
fi

# GNU coreutils 在文件名含反斜杠时会给整行加前导 "\" 转义标记，剥掉它才拿到纯哈希。
ACTUAL="$(sha256sum "$TARGET" | cut -d ' ' -f1)"
ACTUAL="${ACTUAL#\\}"
EXPECTED="${EXPECTED#\\}"
if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "错误：SHA-256 不匹配（$TARGET）。" >&2
    echo "  期望 $EXPECTED" >&2
    echo "  实际 $ACTUAL" >&2
    exit 1
fi
