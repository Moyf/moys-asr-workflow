#!/usr/bin/env bash
# 构建 MAW Linux AppImage。产物：build-appimage/MAW-Linux-x86_64.AppImage
# 前置：系统需有 ffmpeg（生成图标）与 mksquashfs（appimagetool 内部使用）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUILD_DIR="$REPO_ROOT/build-appimage"
APP_DIR="$BUILD_DIR/MAW.AppDir"
APPIMAGE_TOOL="$BUILD_DIR/appimagetool-x86_64.AppImage"
APPIMAGE_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
mkdir -p "$BUILD_DIR"

echo "==> 1/6 PyInstaller 构建 dist/MAW"
uv run --group build pyinstaller --noconfirm --clean MAW.spec
# PyInstaller 6 places datas under _internal in an onedir bundle. Keep the
# user-facing FAQ at the AppImage root as well, where users can find it easily.
cp "FAQ-常见问题.txt" "dist/MAW/FAQ-常见问题.txt"

echo "==> 2/6 准备静态 ffmpeg（BtbN FFmpeg-Builds，固定 autobuild 版本）"
FFMPEG_VERSION="N-126134-gc48230eb86"
FFMPEG_TARBALL="$BUILD_DIR/ffmpeg-${FFMPEG_VERSION}-linux64-gpl.tar.xz"
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-14-13-16/ffmpeg-${FFMPEG_VERSION}-linux64-gpl.tar.xz"
FFMPEG_SHA256="9e49d517f47031140e45fae1813325482b1fd0a886a15d9977ac75cfec1cab05"
FFMPEG_DIR="$BUILD_DIR/ffmpeg-static"
# 静态版自包含 libstdc++ 依赖，不受 PyInstaller 的 _internal 旧库污染；
# 动态版 ffmpeg 若打进包内，AppRun 污染环境下照样会 GLIBCXX 报错。
# BtbN autobuild 固定版本 + 写死 SHA256：版本与校验双固定，完全可复现；
# 升级时改 FFMPEG_VERSION / FFMPEG_URL / FFMPEG_SHA256 三处即可
# （checksums 见 https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-08-14-13-16）。
if [ ! -x "$FFMPEG_DIR/bin/ffmpeg" ]; then
    if [ ! -f "$FFMPEG_TARBALL" ]; then
        echo "    下载静态 ffmpeg..."
        curl -sL --retry 3 --retry-delay 2 -o "$FFMPEG_TARBALL" "$FFMPEG_URL"
    fi
    echo "    校验静态 ffmpeg 完整性..."
    if ! echo "$FFMPEG_SHA256  $FFMPEG_TARBALL" | sha256sum -c - >/dev/null; then
        echo "错误：ffmpeg 下载校验和不匹配（$FFMPEG_TARBALL），已删除请重试。" >&2
        rm -f "$FFMPEG_TARBALL"
        exit 1
    fi
    mkdir -p "$FFMPEG_DIR"
    tar -xf "$FFMPEG_TARBALL" -C "$FFMPEG_DIR" --strip-components=1
    chmod +x "$FFMPEG_DIR/bin/ffmpeg" "$FFMPEG_DIR/bin/ffprobe"
fi
# 放入 PyInstaller onedir 产物：frozen 时 _bundled_ffmpeg_directory() 查
# sys.executable.parent / ffmpeg / bin（即 dist/MAW/ffmpeg/bin）。BtbN 包内
# 二进制位于解压根目录的 bin/ 子目录（与 johnvansickle 的根目录布局不同）。
mkdir -p "dist/MAW/ffmpeg/bin"
cp "$FFMPEG_DIR/bin/ffmpeg" "$FFMPEG_DIR/bin/ffprobe" "dist/MAW/ffmpeg/bin/"
# GPL 合规：BtbN linux64-gpl 是 GPL 构建，分发须随附许可证文本与对应源码
# 获取方式（GPLv3 §4 传递许可证副本、§6 提供源码书面要约）。GPLv3 全文从
# gnu.org 拉取，SOURCE.txt 记录构建来源、归档地址与校验和。
curl --fail --location --retry 3 --silent --show-error \
    -o "dist/MAW/ffmpeg/GPLv3.txt" \
    "https://www.gnu.org/licenses/gpl-3.0.txt"
cat > "dist/MAW/ffmpeg/SOURCE.txt" <<EOF
FFmpeg $FFMPEG_VERSION — BtbN FFmpeg-Builds linux64-gpl static build
Build provider: https://github.com/BtbN/FFmpeg-Builds
Original archive: $FFMPEG_URL
Archive SHA-256: $FFMPEG_SHA256
License: GPL-3.0 (full text in GPLv3.txt)
Upstream FFmpeg source: https://github.com/FFmpeg/FFmpeg
This MAW package includes only ffmpeg and ffprobe from the original build.
EOF
echo "    静态 ffmpeg: $("$FFMPEG_DIR/bin/ffmpeg" -version 2>&1 | head -n 1)"

echo "==> 3/6 组装 AppDir"
if [ -d "$APP_DIR" ]; then
    rm -r "$APP_DIR"
fi
mkdir -p "$APP_DIR"
cp -a dist/MAW/. "$APP_DIR/"

# PyInstaller 会把构建机（ubuntu-22.04，GCC 11）的 libstdc++/libgcc_s 收进
# _internal。在系统 libstdc++ 更新的发行版（如 SteamOS 的 GCC 14）上，这两把
# 旧库会抢先于系统库被加载，导致系统 Mesa 驱动链（radeonsi → libLLVM →
# libstdc++）与 libSPIRV-Tools 因缺 GLIBCXX_3.4.32 加载失败，QtWebEngine
# 无可用渲染后端而 abort。libstdc++ ABI 向后兼容，直接剔除、使用系统版本；
# 后续如需支持系统库过老的发行版，再引入 compat 目录按需加载。
# 同理剔除 libgbm.so.1：libQt6WebEngineCore（Chromium GPU 进程）直接链接它，
# 包内的是构建机 Mesa 22 旧版，会抢先于系统 gbm（SteamOS Mesa 24+）被加载；
# 系统 libgbm 导出符号是旧版的超集（Chromium 所需 20 个 gbm_* 符号全覆盖），
# 剔除后由系统版本接管，行为正确。
rm -f "$APP_DIR/_internal/libstdc++.so.6" "$APP_DIR/_internal/libgcc_s.so.1" \
      "$APP_DIR/_internal/libgbm.so.1"

# AppRun：QtWebEngine 在 AppImage（squashfs 只读、无 SUID sandbox helper）环境
# 必须禁用 Chromium 沙箱，否则 Launcher 页面无法渲染。
cat > "$APP_DIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(CDPATH= cd -- "$(dirname -- "$(readlink -f "$0")")" && pwd)"
export QTWEBENGINE_DISABLE_SANDBOX=1
export QTWEBENGINE_CHROMIUM_FLAGS="${QTWEBENGINE_CHROMIUM_FLAGS:+$QTWEBENGINE_CHROMIUM_FLAGS }--no-sandbox"
exec "$HERE/MAW" "$@"
EOF
chmod +x "$APP_DIR/AppRun"

cat > "$APP_DIR/MAW.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=MAW
Name[zh_CN]=MAW
Comment=Moy's ASR Workflow - subtitle transcription and editing
Comment[zh_CN]=Moy 的 ASR 工作流 - 字幕转写与编辑
Exec=MAW
Icon=MAW
Terminal=false
Categories=AudioVideo;AudioVideoEditing;
StartupWMClass=MAW
EOF

ffmpeg -y -loglevel error -i assets/show.webp -vf "scale=256:256:flags=lanczos" "$APP_DIR/MAW.png"
# 标准 hicolor 图标布局（appimagetool 与 AppImageLauncher / 文件管理器识别依赖它）
mkdir -p "$APP_DIR/usr/share/icons/hicolor/256x256/apps"
ffmpeg -y -loglevel error -i assets/show.webp -vf "scale=256:256:flags=lanczos" "$APP_DIR/usr/share/icons/hicolor/256x256/apps/MAW.png"
mkdir -p "$APP_DIR/usr/share/icons/hicolor/512x512/apps"
ffmpeg -y -loglevel error -i assets/show.webp -vf "scale=512:512:flags=lanczos" "$APP_DIR/usr/share/icons/hicolor/512x512/apps/MAW.png"
mkdir -p "$APP_DIR/usr/share/applications"
cp "$APP_DIR/MAW.desktop" "$APP_DIR/usr/share/applications/MAW.desktop"

echo "==> 4/6 准备 appimagetool"
if [ ! -x "$APPIMAGE_TOOL" ]; then
    curl -sL --retry 3 --retry-delay 2 -o "$APPIMAGE_TOOL" "$APPIMAGE_URL"
    chmod +x "$APPIMAGE_TOOL"
    # 校验下载的是 ELF 二进制而非 HTML 错误页
    if ! file "$APPIMAGE_TOOL" | grep -q 'ELF'; then
        echo "错误：appimagetool 下载失败（非 ELF 二进制），请检查网络或手动放置。" >&2
        rm -f "$APPIMAGE_TOOL"
        exit 1
    fi
fi

echo "==> 5/6 打包 AppImage"
"$APPIMAGE_TOOL" --appimage-extract-and-run "$APP_DIR" "$BUILD_DIR/MAW-Linux-x86_64.AppImage"

echo "==> 6/6 生成缩略图缓存（缺 libappimage 的系统上让文件管理器显示图标）"
if uv run python "$REPO_ROOT/scripts/make-appimage-thumbnail.py" "$BUILD_DIR/MAW-Linux-x86_64.AppImage"; then
    echo "    缩略图缓存已生成"
else
    echo "    警告：缩略图缓存生成失败（不影响 AppImage 本身）"
fi

echo "==> 完成：$BUILD_DIR/MAW-Linux-x86_64.AppImage"
