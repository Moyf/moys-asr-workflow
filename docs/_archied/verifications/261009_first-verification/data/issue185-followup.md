# #185 后续补充内容核查（2026-10-09）

PR #185「fix(runtimes): 打包版 Linux 不再把包内旧动态库传给宿主解释器」已 squash 合并
（9ca3f75b），CHANGELOG 已补记（60d823bb）。合并后的两条后续，当前 main 均未落实：

## 1. 贡献者 V-Conet 的补充补丁（评论 2026-10-09 11:37，未应用）

自述：`我貌似没有完全覆盖，可能会在下载模型的时候报错`。补丁两点：

- MAW.spec `datas` 补 `maw/moss_runtime.py` 与 `maw/runtimes/freezer.py`
  （→ `local-runtime/maw/`）。已核对当前 MAW.spec L72-86：datas 列表确实缺这两个文件；
  注意 L201/L205 的 hiddenimports 已有 `maw.moss_runtime` / `maw.runtimes.freezer`，
  但宿主解释器按 datas 文件路径导入，hiddenimports 不能替代。
- tests/test_packaging_contract.py `_local_import_modules` 删除 L45 的 `continue`，
  使 `from maw.x import y`（ImportFrom）在包本身命中后继续收集子模块别名。

结论：两点均未应用，仓库中无对应的新 PR / commit。

## 2. 维护者合并评论承认的两个同族遗漏（未修）

- `server-editor/serve.py:1920` `open_backup_directory` 的 `xdg-open` 直接 Popen，
  未还原 LD_LIBRARY_PATH（GUI 侧 `_open_external` 已处理，serve 侧是既有遗漏）；
- `maw/notify.py:117` `_notify_linux` 的 `notify-send` 同样继承包内 LD_LIBRARY_PATH。

维护者备注：这两处不是解释器子进程，实际影响未复现，不阻塞合并，欢迎另开 PR。
已核对当前代码：两处均保持原样。

## 待维护者决策（写入清单打勾项）

1. 是否应用 V-Conet 补丁（MAW.spec datas + 测试收集逻辑），需要 Linux 打包环境实测下载模型路径；
2. 是否修 serve.py / notify.py 两处遗漏（低风险小改）；
3. 或明确挂起并在 issue 里回复贡献者。
