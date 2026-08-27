"""下载并校验当前发布平台的 Python 引导资产。"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from maw.runtime_bootstrap import (  # noqa: E402
    BootstrapAsset,
    GET_PIP_ASSET,
    asset_matches,
    bootstrap_for_key,
    current_bootstrap_key,
    supported_bootstrap_keys,
)

DEFAULT_OUTPUT = ROOT / "build" / "bootstrap"


def prepare_asset(asset: BootstrapAsset, output_dir: Path, *, attempts: int = 3) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / asset.filename
    if asset_matches(target, asset):
        print(f"已验证：{target}")
        return target
    if target.exists():
        target.unlink()

    partial = target.with_name(target.name + ".part")
    if partial.exists():
        partial.unlink()
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(asset.url, headers={"User-Agent": "MAW-runtime-bootstrap/1"})
            with urllib.request.urlopen(request, timeout=300) as response, partial.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if not asset_matches(partial, asset):
                raise ValueError(
                    f"SHA-256 不匹配：{asset.filename}\n期望 {asset.sha256}"
                )
            os.replace(partial, target)
            print(f"已准备：{target}")
            return target
        except (OSError, ValueError) as error:
            last_error = error
            if partial.exists():
                partial.unlink()
            if attempt < attempts:
                time.sleep(attempt)
    raise SystemExit(f"无法准备引导资产 {asset.filename}：{last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description="准备 MAW 跨平台 Python 引导资产")
    parser.add_argument("--platform", choices=supported_bootstrap_keys(), default=current_bootstrap_key())
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    bootstrap = bootstrap_for_key(args.platform)
    prepare_asset(bootstrap.asset, args.output)
    prepare_asset(GET_PIP_ASSET, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
