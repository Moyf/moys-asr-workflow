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

# bundle 是构建产物（不入库）：打包前显式构建；MAW.spec 会在缺失时 fail fast。
echo "==> 0/6 构建 web bundle（esbuild 产物，不入库）"
command -v pnpm >/dev/null 2>&1 || {
    echo "错误：构建 web bundle 需要 pnpm（先安装 Node.js 22.23.4+ (22.x), 24.22.1+ (24.x) or 26.12.1+ 与 pnpm）。" >&2
    exit 1
}
pnpm install --frozen-lockfile
pnpm run build

echo "==> 1/6 PyInstaller 构建 dist/MAW"
# 生成托管 Runtime 的 frozen requirements txt（MAW.spec datas 条件追加打包）；
# 主清单与 CPU 变体统一由 freezer 模块执行（与 build-windows.ps1 /
# release.yml / 源码模式自动补齐完全同源）。
mkdir -p build
uv run python -m maw.runtimes.freezer freeze --force
uv run --group build pyinstaller --noconfirm --clean scripts/packaging/MAW.spec
# PyInstaller 6 places datas under _internal in an onedir bundle. Keep the
# user-facing FAQ at the AppImage root as well, where users can find it easily.
cp "docs/user/FAQ-常见问题.txt" "dist/MAW/FAQ-常见问题.txt"

echo "==> 2/6 准备已锁定的 Linux FFmpeg"
# 保留 bin/ 与 lib/ 的相对位置，供 FFmpeg 的 $ORIGIN/../lib 查找共享库。
bash scripts/prepare_linux_ffmpeg.sh build/linux-ffmpeg-cache dist/MAW/ffmpeg

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
