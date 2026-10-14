# Filmstrip lab

Issue #229 的独立实验工具，不是正式产品入口。运行方式、三路线比较、实测矩阵、缓存/授权边界与未验证项见 [实验报告](../../docs/engineering/FILMSTRIP_EXPLORATION.md)。

前端源码位于 `web/experiments/filmstrip/`；fixture、sprite、截图和原始测量位于根 `.artifacts/filmstrip/`，不入 Git。服务仅绑定 127.0.0.1，启动时 CLI 精确授权媒体，Ctrl+C 或 idle timeout 退出。
