# eMudhra 证书事件与 2026-10 Node/Rust 安全修复

核查日期：2026-10-22。代码基线：`upstream/main` 的 `e6a2fa4b`。

## 影响与处理

| 组件 | 在 MAW 中的使用 | 本次处理 |
| --- | --- | --- |
| certifi | 主程序 requests、local/OCR/MOSS 的 Python HTTPS | 声明安全下界 `>=2026.10.19`；`uv.lock` 从 `2026.7.22` 定向更新到 `2026.10.19`；MOSS 独立声明同步下界 |
| urllib3 | 主程序 LLM 的 requests 流式响应，以及模型环境 HTTPS | 主程序/local/OCR/MOSS 声明 `>=2.8.0`，锁文件由 2.7.0 定向更新到 2.8.0，阻止异常 chunk-size 字段无界缓冲 |
| pip 的内置 certifi | Windows embedded Python 引导、Linux/macOS 宿主 venv 引导 | 固定 Python 官方公告中的 `pip 26.2.2` wheel URL 和 SHA-256，防止旧 ensurepip 的 CA 留在新模型环境中 |
| hf-xet 的 Rust TLS | Hugging Face 模型下载；Python certifi 更新不会更改其原生 TLS 根库 | worker 环境强制 `HF_HUB_DISABLE_XET=1`，通过 huggingface_hub 的 Python HTTPS 回退下载；不安装未修复的稳定版或预发行版 |
| Node.js | 编辑器/Launcher/官网源码构建与测试 | 开发版本范围 `^22.23.4 || ^24.22.1 || >=26.12.1`；现有 Node 22 CI 固定到 `22.23.4`；不变更 npm 依赖 |
| uv | 锁定、导出、模型环境安装工具；自身含 Rust TLS | CI 固定 `0.13.4`，源码指南要求此版本或更新的安全版 |
| quapeaks 2026.0.0 | 本地波形/频谱计算的 Rust 扩展 | PyPI sdist 的 Cargo 声明/锁文件未包含 rustls/webpki/reqwest/native-tls；不升级 |
| tokenizers 0.22.2 / safetensors 0.8.0 | Rust Python 原生包 | PyPI sdist：tokenizers Python bindings 未启用 Rust http/rustls 特性，下载委托 Python Hub；safetensors Cargo 声明未发现上述 TLS 依赖，不升级 |
| Rust/rustup、PHP | 仓库没有 Cargo 工程、rustup 引导或 PHP 执行路径 | 不增加编译工具链或 PHP 依赖，不为本次漏洞进行无效升级 |

主程序是 Python/PyInstaller/pywebview；本次 Windows 产物不包含 Node 可执行文件。Node 公告中的 DNS/TLS、Brotli、HTTP、快照随机数与权限模型问题属于开发/构建工具的风险面；更新系统 Node 不会修复已分发安装包里的 Python CA，故两条链分别处理。

local/OCR/MOSS 的运行时版本分别由 7/3/2 提升到 8/4/3，使旧模型环境进入已有的升级/修复流程；不会自动下载模型权重。源码开发者也应同步分支后执行 `uv sync --frozen`，不能仅手工更新 `.venv` 而保留旧锁文件。

## Rust 依赖证据与剩余边界

锁定的 hf-xet 1.6.0 对应 xet-core tag `v1.6.0`（`de71453d952bd8b806edaa997c72313051a49050`）。其 Cargo.lock 包含 `rustls-webpki 0.103.13`、`webpki-root-certs 1.0.6`；xet_client 默认启用 rustls-tls，Python wheel 的 maturin 配置未选择 native-tls。当前稳定版 1.7.0 的锁文件仍为 WebPKI 0.103.15 / root-certs 1.0.6，也未达到修复版本，因此没有顺带升级 hf-xet。

[RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html) 的修复版本是 `rustls-webpki >=0.103.16`（或对应的 0.104 alpha 安全版本）；[RUSTSEC-2026-0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html) 要求 `webpki-root-certs >=1.0.10`。二者关联 CVE-2026-111943。

本次缓解覆盖 MAW 的源码 CLI、托管模型 worker 与未安装托管环境时的源码对齐回退：包初始化仅用标准库提前设置禁用 Xet 的环境，早于可选 huggingface_hub / 模型库的导入；worker 子进程另强制该策略，覆盖父进程显式设为 0 的情况。依赖内的受影响 native 库仍存在，**不能称为 Rust 库已经修复**。外部程序直接调用 hf_xet、或在导入 huggingface_hub 后才修改环境，不在该 MAW 进程启动策略覆盖范围；源码集成者应在进程启动前设置 `HF_HUB_DISABLE_XET=1`。待上游发布修复后的稳定 wheel，再单独升级并验证是否恢复 Xet；当前回退可能降低模型下载吞吐，已有权重缓存继续使用。

## 验证

在独立干净工作树中执行，未复用既有项目的 .venv 或 node_modules：

- `uv sync --frozen --group build` 成功，主程序 certifi 为 2026.10.19；`pnpm install --frozen-lockfile` 成功，pnpm 锁文件没有变化。
- `uv lock --check` 成功。按包名/版本映射比较，锁文件仅 certifi 和 urllib3 发生版本变化。uv 0.13.4 将 lock revision 从 3 规范化为 5，并调整 marker 表达；对主程序/build/local/OCR 导出，在 Python 3.11–3.15 × Windows/Linux/macOS 共 60 组环境中比较，除 certifi/urllib3 外的依赖选择与版本保持一致。
- 安全依赖、模型运行时、Hub 下载与打包契约 108 项，以及对齐相关 14 项定向测试通过；Ruff 与 TypeScript 类型检查通过。
- `pwsh -NoProfile -File scripts/build-windows.ps1 -SkipTests` 实际完成 PyInstaller Windows onedir 构建；`dist/MAW/MAW.exe --smoke-import` 退出 0。测试已单独执行。Windows PowerShell 5.1 对现有 UTF-8 无 BOM 脚本产生解析错误，本次使用 PowerShell 7 验证。
- 产物的 local/local-cpu/OCR/MOSS/MOSS-cpu 五份 frozen requirements 均包含 `certifi==2026.10.19` 与 `urllib3==2.8.0`；从实际 EXE 的 PYZ 归档读取 urllib3 版本常量，确认为 2.8.0。产物 CA bundle 含 120 张证书，不含 emSign ECC Root CA - G3 的 DER SHA-256 `86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B`。
- 使用产物实际 CA bundle 进行正常 TLS 握手：`www.python.org` 通过；`dv-g3b-emudhra.we-have-a-problem.com` 与 `dv-g3b-aaa-emudhra.we-have-a-problem.com` 均因证书验证失败被拒绝；没有绕过 TLS 验证。
- 使用产物的 embedded Python ZIP、get-pip.py 与生产 `_get_pip_command` 完成一次干净引导：pip 26.2.2、内置 certifi 2026.10.19。
- 安装锁定的 huggingface_hub 0.36.2 / hf-xet 1.6.0 及其最小依赖，启动前禁用 Xet；确认上游 `is_xet_available()` 为 false，并成功无凭据下载公开 gpt2 `.gitattributes`（445 字节）。该检查验证 HTTP 回退，不代表完成真实大模型/长媒体推理验收。

补齐 urllib3 前的全量 Python 回归运行了 2725 项：2697 通过、27 跳过、1 失败。唯一失败为未改动的 `test_real_progress_pipe_is_drained_during_process_execution`，其断言要求在 0.3 秒子进程存活窗口内观察进度；独立单项复跑通过，但模块整组复跑仍失败；在未改动基线 e6a2fa4b 的完整源码上，同模块 31 项同样仅此项失败，确认是基线可复现问题。整组结果仍记为失败，不以单项复跑替代全量通过；没有为本次安全修复改动该媒体任务测试或实现。

没有在本机完整安装三套大型 GPU/CPU 模型环境，没有验证 macOS/Linux 实际安装包，也没有执行真实模型推理；这些验收仍由对应平台/模型流程覆盖。Windows 本次产物为本地验证产物，不是签名 Release。embedded Python 仍沿用当前工程的 3.11.9（OpenSSL 3.0.13），本次修复其 pip/CA，不跨 Python 大版本改变模型兼容性；这也不代表完成该旧解释器所有历史 CVE 的审计。

## urllib3 的体验影响与补充验证

`maw/postprocess_llm.py` 通过 `requests.Session.post(stream=True)` 请求，并调用 `response.iter_lines()` 读取 SSE，属于 [GHSA-vxq7-64xx-v4gw / CVE-2026-97689](https://github.com/urllib3/urllib3/security/advisories/GHSA-vxq7-64xx-v4gw) 的实际受影响路径。恶意或遭入侵的服务端/代理可发送不含换行的超长 chunk-size 字段，使客户端耗尽内存等资源；该问题的安全影响是可用性，不能描述成必然泄露 API Key。CA 事件的机密性/完整性风险与此分别记录。

升级对正常 HTTP/SSE 预期无可感知变化，不要求修改 API 配置、模型、字幕或翻译数据。限制作用于分块长度字段，并非响应正文或回答总长度；正常大块内容仍可读取。异常第三方服务/代理会更早报响应错误，不应通过关闭验证、取消流式或放宽解析限制兼容异常服务。

补充验证：218 项安全、LLM 流式/中文/取消/异常诊断和打包契约测试通过；其中通过真实 requests → urllib3 → HTTPResponse 读取链验证 128 KiB 异常长度字段在有界读取后被拒绝，正常中文 SSE 正文约 90 KiB 仍完整读取。重新执行 frozen 安装与 Windows 正式打包，检查五份随包清单和 EXE 内实际 urllib3；未扩大其他依赖升级范围。后续 CI 结果应以包含此补充改动的新 head 为准。

## PR 294 入口覆盖复审

补齐 urllib3 的提交 `32760135` 已通过全部远端 CI：Windows 2728 项 Python 测试（17 跳过）、预览包构建与冒烟、编辑器 Node/浏览器检查和 Ruff。复审时 GitHub 没有已提交的人工审查或内联评论。

沿受支持调用入口复核时发现：仅给父进程创建的模型 worker 传环境变量，不能保护用户指南中的独立 `python -m maw.asr.local`，也不能保护公开 CLI 在没有托管环境时直接运行的文稿对齐。后者可能在设置模型缓存环境前已导入 Hub。该问题是本 PR 的 hf-xet 缓解覆盖缺口，不是新增的模型功能故障。

修复将 MAW 进程的禁用策略前移至包初始化，不导入 Hub 或大型模型依赖。全新子进程回归覆盖本地 CLI、公开 CLI 和两个模型 worker，父环境预设 `HF_HUB_DISABLE_XET=0`：修复前四个入口均复现缺口，修复后全部覆盖，且 Hub 保持延迟导入。相关安全/CLI/模型/对齐/打包契约 160 项通过，Ruff 通过；实际锁定 Hub 库与下载回退另做无凭据公开文件验证。新提交的远端检查按新 head 独立核对，不沿用旧提交通过状态。

## 上游与公告

提交前列出全部开放 PR，并搜索 certifi/emudhra；未发现重复安全修复。开放 PR 286 处理 Python 兼容和 Linux 轻量包，与本次修复目的不同，运行时安装附近代码可能需要后续协调。

- [Python 官方安全版本与带哈希 pip 引导](https://discuss.python.org/t/python-3-15-1-3-14-9-and-3-13-17-are-out/109595)
- [certifi 2026.10.19](https://pypi.org/project/certifi/2026.10.19/)
- [Node 2026-10-21 安全发布](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [uv 0.13.4](https://github.com/astral-sh/uv/releases/tag/0.13.4)
- [Hugging Face 的 HF_HUB_DISABLE_XET 及导入时机说明](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables#hfhubdisablexet)
- [hf-xet 1.6.0 Cargo.lock](https://github.com/huggingface/xet-core/blob/v1.6.0/Cargo.lock) / [1.7.0 Cargo.lock](https://github.com/huggingface/xet-core/blob/v1.7.0/Cargo.lock)
- [quapeaks 2026.0.0 官方发行文件](https://pypi.org/project/quapeaks/2026.0.0/#files)
