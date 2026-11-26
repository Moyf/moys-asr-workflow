# 固定 Linux FFmpeg 独立审查

以 `Moyf/moys-asr-workflow:main` 的 `ba9f33b3` 为基线。Linux 发布前的媒体测试和 AppImage 共用同一份 SHA-256 锁定的 mifi `8.1-2` 归档。包内保留 `bin/`、`lib/` 和原始 GPLv3 许可，`SOURCE.txt` 记录镜像、对应 FFmpeg 提交以及 BtbN 构建脚本和依赖锁定提交。

| 发现 | 处置 |
| --- | --- |
| 来源说明原先没有固定 BtbN 构建脚本和依赖快照 | 核对 2026-10-20 的 `autobuild-2026-10-20-13-08`，补入构建提交 `63ac3265`。 |
| 重复解包累积多个约 204 MiB 的目录，同分支升级可能命中旧归档 | 只缓存校验过的归档，按镜像标签分目录。测试和 AppImage 各自直接解包到使用目录。缓存校验失败时指出待清理的文件。 |
| 无字体环境中 FFmpeg 会成功写文件，字幕像素却没有变化 | 保留 CI 字体安装，在包内实际编码并比较烧录前后的帧。正常 Fontconfig 可发现字体时，独立测试确认画面有字幕。 |

独审检查了实际归档的 RPATH、动态符号、库加载、失败即退出和分支手动构建的 tag 发布门禁。`bin/` 和 `lib/` 的最高导入 glibc 符号版本为 2.28。已调整的两项契约测试在基线调用链上失败，新调用链通过。正式分发随发布流程复核许可与相应源码。[镜像归档](https://github.com/mifi/ffmpeg-builds/releases/tag/8.1-2) · [BtbN 依赖锁定提交](https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/63ac3265b0789ea16c7b1f8351cd2ad195a28722)
