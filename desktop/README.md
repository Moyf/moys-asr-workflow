# MOSE — Electron 桌面壳（发布路线决策）

MOSE（Moy's Open Subtitle Editor）是 MAW 的 Windows x64 独立编辑器。仓库已经确定
**以 Electron 作为桌面壳的发布路线**：Electron 只负责窗口、单实例、文件关联、
下载对话框与它启动的 `MAW.exe` 生命周期；编辑器前端继续唯一来自 `web/`，后端继续
唯一来自 `server-editor/serve.py`，不为桌面版维护第二套实现。

## 决策记录（2026-10-08）

- 本目录曾保留 Tauri 2.x 实验工程（2026-07-30 引入，`desktop/src-tauri/`）。
  经评估后移除：Tauri 方案在 Rust 侧重复实现了 Server 契约（工程保存、媒体、
  波形等），需要同时维护 Python 与 Rust 两套后端并引入 Rust 工具链；而 Electron
  套件（MAW + MOSE 统一套件、Inno Setup Installer、软件内更新器、`.mosp` 关联）
  已完整实现并实测可用。
- Tauri 实验的历史代码见 git 历史（`a8c2669b` 至移除前）；实验结论以本页为准。
- 完整的 Electron MOSE 套件代码当前位于 `merge/starlit-main` 集成分支
  （`desktop/src/main.cjs`、`preload.cjs` 等），后续合回 main 后本目录即为其
  唯一开发目录。

## 套件结构（Electron 路线）

```text
MAW/
├── MAW.exe                # PyInstaller 主程序（Launcher / Server）
├── MOSE/
│   ├── MOSE.exe           # Electron 壳，启动同套件 MAW.exe
│   └── resources/…
└── ffmpeg/…
```

MOSE 不能脱离同套件的 `MAW.exe` 单独运行；`.mosp` 关联指向
`MAW.exe --open-project`，双击工程先经过 Launcher 更新检查再打开 MOSE。

**web/ 永远是编辑器真源；`server-editor/serve.py` 永远是后端唯一真源。**

License: AGPL-3.0-only（与 MAW 主仓库一致）。
