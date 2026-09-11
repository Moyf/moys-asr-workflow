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
# 生成托管 Runtime 的 frozen requirements txt（MAW.spec datas 条件追加打包）；
# 主清单与 CPU 变体统一由 freezer 模块执行（与 build-windows.ps1 /
# release.yml / 源码模式自动补齐完全同源）。
mkdir -p build
uv run python -m maw.runtimes.freezer freeze --force
uv run --group build pyinstaller --noconfirm --clean MAW.spec
# PyInstaller 6 places datas under _internal in an onedir bundle. Keep the
# user-facing FAQ at the AppImage root as well, where users can find it easily.
cp "FAQ-常见问题.txt" "dist/MAW/FAQ-常见问题.txt"

echo "==> 2/6 准备静态 ffmpeg（BtbN FFmpeg-Builds，latest release 的稳定分支资产）"
FFMPEG_BRANCH="8.1"
FFMPEG_ASSET="ffmpeg-n${FFMPEG_BRANCH}-latest-linux64-gpl-${FFMPEG_BRANCH}.tar.xz"
FFMPEG_TARBALL="$BUILD_DIR/$FFMPEG_ASSET"
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/$FFMPEG_ASSET"
FFMPEG_CHECKSUMS="$BUILD_DIR/btbn-checksums.sha256"
FFMPEG_DIR="$BUILD_DIR/ffmpeg-static"
# 静态版自包含 libstdc++ 依赖，不受 PyInstaller 的 _internal 旧库污染；
# 动态版 ffmpeg 若打进包内，AppRun 污染环境下照样会 GLIBCXX 报错。
# BtbN 只保留最近十来天的 dated autobuild release，写死 dated tag（连同其内
# N-xxxx 版本与 SHA256）迟早被删成 404，2026-09-10 v1.6.0-beta.3 的 Linux
# 打包即因此失败。`latest` release 永远存在且始终携带各稳定分支资产，
# releases/latest/download/<asset> 是永久直链；n8.1 资产跟随 FFmpeg 8.1
# 稳定分支维护更新，与 Windows（gyan 8.1.2）/ macOS（osxexperts 8.1）大版本
# 对齐。内容随维护更新，无法写死 SHA256，改为随包下载上游 checksums.sha256
# 比对完整性（curl --fail 保证 404 / 断流直接报错，不再静默存下错误页），
# 解压后另校验 ffmpeg 自报版本包含分支号。升级大版本只改 FFMPEG_BRANCH。
if [ ! -x "$FFMPEG_DIR/bin/ffmpeg" ]; then
    echo "    下载静态 ffmpeg（$FFMPEG_ASSET）..."
    if ! curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
            -o "$FFMPEG_TARBALL" "$FFMPEG_URL"; then
        echo "错误：ffmpeg 下载失败（$FFMPEG_URL）。" >&2
        rm -f "$FFMPEG_TARBALL"
        exit 1
    fi
    echo "    对照上游 checksums.sha256 校验静态 ffmpeg 完整性..."
    if ! curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
            -o "$FFMPEG_CHECKSUMS" \
            "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/checksums.sha256" \
        || ! bash "$REPO_ROOT/scripts/verify_sha256.sh" "$FFMPEG_CHECKSUMS" "$FFMPEG_ASSET" "$FFMPEG_TARBALL"; then
        echo "错误：ffmpeg 完整性校验失败或 checksums.sha256 不可得（$FFMPEG_TARBALL），已删除。" >&2
        rm -f "$FFMPEG_TARBALL" "$FFMPEG_CHECKSUMS"
        exit 1
    fi
    rm -f "$FFMPEG_CHECKSUMS"
    mkdir -p "$FFMPEG_DIR"
    tar -xf "$FFMPEG_TARBALL" -C "$FFMPEG_DIR" --strip-components=1
    chmod +x "$FFMPEG_DIR/bin/ffmpeg" "$FFMPEG_DIR/bin/ffprobe"
fi
# 资产名固定在 8.1 分支，仍校验二进制自报版本，防同名资产内容异常。
"$FFMPEG_DIR/bin/ffmpeg" -version 2>&1 | head -n 1 | grep -q "$FFMPEG_BRANCH" || {
    echo "错误：解压出的 ffmpeg 版本异常（未包含 $FFMPEG_BRANCH）：" >&2
    "$FFMPEG_DIR/bin/ffmpeg" -version 2>&1 | head -n 1 >&2
    exit 1
}
# 实际打进包的归档哈希写入 SOURCE.txt；复用缓存目录且归档已清理时如实标注。
if [ -f "$FFMPEG_TARBALL" ]; then
    FFMPEG_TARBALL_SHA256="$(sha256sum "$FFMPEG_TARBALL" | cut -d ' ' -f1)"
else
    FFMPEG_TARBALL_SHA256="unavailable (reused cached ffmpeg-static; archive not kept)"
fi
# 放入 PyInstaller onedir 产物：frozen 时 _bundled_ffmpeg_directory() 查
# sys.executable.parent / ffmpeg / bin（即 dist/MAW/ffmpeg/bin）。BtbN 包内
# 二进制位于解压根目录的 bin/ 子目录（与 johnvansickle 的根目录布局不同）。
mkdir -p "dist/MAW/ffmpeg/bin"
cp "$FFMPEG_DIR/bin/ffmpeg" "$FFMPEG_DIR/bin/ffprobe" "dist/MAW/ffmpeg/bin/"
# GPL 合规：BtbN linux64-gpl 是 GPL 构建，分发须随附许可证文本与对应源码
# 获取方式（GPLv3 §4 传递许可证副本、§6 提供源码书面要约）。GPLv3 全文
# 优先从 gnu.org 拉取，失败时回退 GitHub 官方 SPDX 镜像（GitHub hosted
# runner 上 gnu.org 偶发连接超时，curl (28) 会导致 AppImage 构建连带失败）；
# SOURCE.txt 记录构建来源、归档地址与校验和。
_GPL_TARGET="dist/MAW/ffmpeg/GPLv3.txt"
_GPL_TMP="${_GPL_TARGET}.tmp"
rm -f "$_GPL_TMP"
if curl --fail --location --silent --show-error --connect-timeout 15 --max-time 90 \
    -o "$_GPL_TMP" "https://www.gnu.org/licenses/gpl-3.0.txt" \
    || curl --fail --location --silent --show-error --connect-timeout 15 --max-time 90 --retry 1 \
        -o "$_GPL_TMP" \
        "https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt"; then
    :
else
    rm -f "$_GPL_TMP"
    echo "GPL 许可证文本下载失败（gnu.org 与 SPDX 镜像均不可达）" >&2
    exit 1
fi
grep -q "GNU GENERAL" "$_GPL_TMP" || { rm -f "$_GPL_TMP"; echo "GPL 许可证文本内容校验失败" >&2; exit 1; }
mv -f "$_GPL_TMP" "$_GPL_TARGET"
test -s "$_GPL_TARGET"
cat > "dist/MAW/ffmpeg/SOURCE.txt" <<EOF
FFmpeg n${FFMPEG_BRANCH}-latest (${FFMPEG_BRANCH} stable branch) — BtbN FFmpeg-Builds linux64-gpl static build
Build provider: https://github.com/BtbN/FFmpeg-Builds
Original archive: $FFMPEG_URL
Archive SHA-256: $FFMPEG_TARBALL_SHA256
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
      "$APP_DIR/_internal/libgbm.so.1" "$APP_DIR"/_internal/libreadline.so.*

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
    curl --fail --location --silent --show-error --retry 3 --retry-delay 2 -o "$APPIMAGE_TOOL" "$APPIMAGE_URL"
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
