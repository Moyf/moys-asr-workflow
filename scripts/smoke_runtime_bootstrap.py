"""用真实归档冒烟验证 Python 解压、启动与 pip 引导。"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from maw.runtime_bootstrap import (  # noqa: E402
    GET_PIP_ASSET,
    asset_matches,
    bootstrap_for_key,
    current_bootstrap_key,
    extract_python_bootstrap,
    supported_bootstrap_keys,
)

DEFAULT_ASSET_DIR = ROOT / "build" / "bootstrap"


def main() -> int:
    parser = argparse.ArgumentParser(description="冒烟验证 MAW Python 引导资产")
    parser.add_argument("--platform", choices=supported_bootstrap_keys(), default=current_bootstrap_key())
    parser.add_argument("--asset-dir", type=Path, default=DEFAULT_ASSET_DIR)
    args = parser.parse_args()

    bootstrap = bootstrap_for_key(args.platform)
    archive = args.asset_dir / bootstrap.asset.filename
    get_pip = args.asset_dir / GET_PIP_ASSET.filename
    if not asset_matches(archive, bootstrap.asset) or not asset_matches(
        get_pip, GET_PIP_ASSET
    ):
        raise SystemExit("引导资产缺失或校验失败，请先运行 prepare_runtime_bootstrap.py。")

    environment = dict(os.environ)
    environment.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    with tempfile.TemporaryDirectory(prefix="maw-bootstrap-smoke-") as temp_name:
        python = extract_python_bootstrap(archive, Path(temp_name) / "python", bootstrap)
        subprocess.run([str(python), "--version"], check=True, env=environment)
        subprocess.run(
            [str(python), str(get_pip), "--disable-pip-version-check"],
            check=True,
            env=environment,
        )
        subprocess.run([str(python), "-m", "pip", "--version"], check=True, env=environment)
    print(f"引导冒烟验证通过：{bootstrap.key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
