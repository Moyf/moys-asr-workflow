#!/usr/bin/env python3
"""PyPI mirror speed tester for MAW runtime installs.

MAW 的本地 ASR / OCR runtime 用 `pip install --target ... --index-url <mirror>`
拉依赖（torch 等体积很大），国内用户直连 pypi.org 往往很慢。
本工具并发探测各候选源的 HTTP 延迟与下载速度，选最快的镜像供
`--index-url` 使用。纯标准库实现，可独立运行，也可被
maw/local_runtime.py / maw/ocr_runtime.py import 使用。

用法:
  python scripts/runtime_mirror_picker.py            # 人类可读输出 + FASTEST line
  python scripts/runtime_mirror_picker.py --json     # 完整 JSON
  python scripts/runtime_mirror_picker.py --source https://pypi.org/simple

可导入 API:
  pick_fastest_mirror(timeout=5.0) -> str       # 最快镜像 base URL，全失败兜底官方源
  measure_sources(timeout=5.0) -> list[dict]    # 每源: url/latency_ms/bytes_per_sec/ok/error

候选源: 官方 + 国内常用镜像，可用环境变量 MAW_PIP_INDEX（逗号分隔 URL）
覆盖（想"追加"就把需要的默认源一并写进去）。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

#: 内置候选源: 官方 + 国内常用镜像（腾讯/华为/中科大等实测可用；豆瓣已停更、搜狐已废弃，均不列入）
DEFAULT_SOURCES = [
    "https://pypi.org/simple",
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple/",
    "https://mirror.sjtu.edu.cn/pypi/web/simple",
    "https://mirrors.cloud.tencent.com/pypi/simple/",
    "https://mirrors.huaweicloud.com/repository/pypi/simple",
    "https://pypi.mirrors.ustc.edu.cn/simple/",
]

#: 全部源都失败时的兜底（官方源，功能必然可用，只是可能慢）
FALLBACK_SOURCE = "https://pypi.org/simple"

#: 测速探针: simple 页面的包目录（几十 KB ~ 几百 KB，同时覆盖延迟与带宽）
_PROBE_PACKAGE = "setuptools"
#: 单源最多读取的探针字节数（防止某些源的 simple 页面过大拖慢/耗流量）
_MAX_PROBE_BYTES = 256 * 1024
#: 读取分块大小
_READ_CHUNK_BYTES = 64 * 1024
#: 首块字节数（取其到达时间作为"首字节"）
_FIRST_CHUNK_BYTES = 1024

_USER_AGENT = "MAW-RuntimeMirrorPicker/1.0"

_HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.IGNORECASE)


def _normalize_base(url: str) -> str:
    """去掉首尾空白与结尾斜杠，便于拼探针 URL。"""
    return url.strip().rstrip("/")


def _probe_url(source: str) -> str:
    """构造某源的探针 URL: {base}/setuptools/"""
    return f"{_normalize_base(source)}/{_PROBE_PACKAGE}/"


def _make_ssl_context(*, verify: bool) -> ssl.SSLContext:
    """构造 HTTPS 上下文。verify=False 时忽略证书校验（国内镜像证书链偶有问题）。"""
    if verify:
        return ssl.create_default_context()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _is_cert_error(exc: BaseException) -> bool:
    """判断异常是否由 TLS 证书校验失败引起（含被 URLError 包裹的情况）。"""
    if isinstance(exc, ssl.SSLError):
        return True
    if (isinstance(exc, urllib.error.URLError)
            and exc.reason is not None
            and not isinstance(exc, urllib.error.HTTPError)):
        return _is_cert_error(exc.reason)
    return False


def _open_probe(source: str, timeout: float, *, use_verified_context: bool):
    """对探针 URL 发起 GET，返回 response 对象（不校验证书抛错时由调用方重试）。"""
    context = _make_ssl_context(verify=use_verified_context)
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context))
    request = urllib.request.Request(
        _probe_url(source), headers={"User-Agent": _USER_AGENT}
    )
    return opener.open(request, timeout=timeout)


def _error_label(exc: BaseException) -> str:
    """把异常压缩成一行短描述，便于 CLI 展示。"""
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}"
    label = str(exc) or type(exc).__name__
    return label if len(label) <= 80 else label[:77] + "..."


def _parse_simple_links(html: str) -> list[str]:
    """从 simple 页面 HTML 中提取所有 href 链接（用于校验响应确实是包索引页）。"""
    return [match.group(1) for match in _HREF_RE.finditer(html)]


def _measure_one(source: str, timeout: float) -> dict:
    """测单个源: 记录连接+首字节延迟(latency_ms)与样本下载速度(bytes_per_sec)。

    绝不抛异常 —— 任何失败都折进返回值（ok=False + error）。
    """
    result = {
        "url": source,
        "ok": False,
        "latency_ms": None,
        "bytes_per_sec": None,
        "error": None,
    }
    try:
        started = time.perf_counter()
        try:
            response = _open_probe(source, timeout=timeout, use_verified_context=True)
        except (urllib.error.URLError, ssl.SSLError, OSError) as exc:
            if not _is_cert_error(exc):
                raise
            # 证书验证失败（国内镜像证书链偶发不完整）: 用不校验证书的上下文兜底重试
            response = _open_probe(source, timeout=timeout, use_verified_context=False)

        with response:
            status = getattr(response, "status", None)
            if status is not None and not (200 <= status < 300):
                raise RuntimeError(f"HTTP {status}")
            first_chunk = response.read(_FIRST_CHUNK_BYTES)
            latency_ms = (time.perf_counter() - started) * 1000.0
            total_bytes = len(first_chunk)
            while total_bytes < _MAX_PROBE_BYTES:
                chunk = response.read(_READ_CHUNK_BYTES)
                if not chunk:
                    break
                total_bytes += len(chunk)
            elapsed_ms = (time.perf_counter() - started) * 1000.0

        download_ms = max(elapsed_ms - latency_ms, 1.0)
        result.update(
            ok=True,
            latency_ms=latency_ms,
            bytes_per_sec=(total_bytes / download_ms) * 1000.0,
        )
    except Exception as exc:  # noqa: BLE001 - 单源失败绝不拖垮整体测速
        result["error"] = _error_label(exc)
    return result


def candidate_sources() -> list[str]:
    """返回本次候选源列表。

    环境变量 MAW_PIP_INDEX（逗号分隔的 URL 列表）非空时作为唯一候选
    （覆盖内置列表; 想保留内置源就把它们一并写进去）。
    """
    override = os.environ.get("MAW_PIP_INDEX", "").strip()
    if override:
        sources = [item.strip() for item in override.split(",") if item.strip()]
        if sources:
            return sources
    return list(DEFAULT_SOURCES)


def measure_sources(timeout: float = 5.0, sources: list[str] | None = None) -> list[dict]:
    """并发测速全部候选源，返回结果列表（保持传入顺序）。

    每项字段: url / ok / latency_ms / bytes_per_sec / error。
    """
    candidates = list(sources if sources else candidate_sources())
    results_by_source: dict[str, dict] = {}

    def _run(source: str) -> tuple[str, dict]:
        try:
            return source, _measure_one(source, timeout)
        except Exception as exc:  # noqa: BLE001 - 兜底保护，理论上 _measure_one 已全捕获
            item = {"url": source, "ok": False, "latency_ms": None,
                    "bytes_per_sec": None, "error": _error_label(exc)}
            return source, item

    max_workers = max(1, min(16, len(candidates)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(_run, source) for source in candidates]
        for future in concurrent.futures.as_completed(futures):
            source, item = future.result()
            results_by_source[source] = item
    return [results_by_source[source] for source in candidates]


def _pick_fastest(results: list[dict]) -> str:
    """从测量结果里选最快可用源；全部失败返回官方源兜底。

    主指标: latency_ms 升序; 同延迟时取 bytes_per_sec 高者。
    """
    ok_results = [item for item in results if item["ok"] and item["latency_ms"] is not None]
    if not ok_results:
        return FALLBACK_SOURCE
    ok_results.sort(key=lambda item: (item["latency_ms"], -(item["bytes_per_sec"] or 0.0)))
    return ok_results[0]["url"]


def pick_fastest_mirror(timeout: float = 5.0) -> str:
    """返回当前最快镜像的 base URL（可直接用作 pip --index-url）。

    全部源失败时返回官方 https://pypi.org/simple 兜底。
    """
    return _pick_fastest(measure_sources(timeout=timeout))


def _fmt_speed(bytes_per_sec: float | None) -> str:
    """把 bytes/s 格式化成人类可读字符串。"""
    if not bytes_per_sec or bytes_per_sec < 1:
        return "n/a"
    if bytes_per_sec >= 1024 * 1024:
        return f"{bytes_per_sec / (1024 * 1024):.2f} MiB/s"
    return f"{bytes_per_sec / 1024:.1f} KiB/s"


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="PyPI mirror speed tester for MAW runtime pip install."
    )
    parser.add_argument("--json", action="store_true",
                        help="print full results as JSON instead of a table")
    parser.add_argument("--timeout", type=float, default=5.0,
                        help="per-source timeout in seconds (default: 5)")
    parser.add_argument("--source", action="append", metavar="URL",
                        help="extra/ad-hoc source to probe; repeatable")
    args = parser.parse_args(argv)

    sources: list[str] = candidate_sources()
    if args.source:
        sources = list(dict.fromkeys(sources + args.source))
    results = measure_sources(timeout=args.timeout, sources=sources)
    fastest = _pick_fastest(results)

    if args.json:
        print(json.dumps({"fastest": fastest, "results": results},
                         ensure_ascii=False, indent=2))
        return 0

    for item in results:
        if item["ok"]:
            print(f"{item['url']:<55} latency={item['latency_ms']:7.1f} ms  "
                  f"speed={_fmt_speed(item['bytes_per_sec'])}")
        else:
            print(f"{item['url']:<55} FAILED ({item['error']})")
    print(f"FASTEST {fastest}")
    return 0


if __name__ == "__main__":
    sys.exit(_main())