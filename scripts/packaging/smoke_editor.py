"""Start the real packaged editor, fetch its page/assets, and stop our server."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener


def smoke(executable: Path, output: Path, timeout: int = 60) -> None:
    executable = executable.resolve(strict=True)
    output.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="run-", dir=output.resolve()))
    project = run / "maw-packaged-smoke.json"
    project.write_text('{"segments": []}\n', encoding="utf-8")
    env = {**os.environ, "MAW_APP_DATA_ROOT": str(run / "app-data"),
           "MAW_ENV_FILE": str(run / "unused-config"), "PYTHONUTF8": "1"}
    # A frozen app must stand alone, with no source/venv imports leaking in.
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    opener = build_opener(ProxyHandler({}))
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    with (run / "server.log").open("wb") as log:
        process = subprocess.Popen(
            [str(executable), "--server", str(port), str(project), "--no-open", "--no-waveform"],
            cwd=run, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **options)
        try:
            deadline = time.monotonic() + timeout
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"Packaged server exited before readiness: {process.returncode}")
                try:
                    with opener.open(url + "/", timeout=2) as response:
                        page = response.read().decode("utf-8")
                    break
                except (OSError, URLError):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Packaged editor did not become ready") from None
                    time.sleep(0.2)
            if 'id="fcp7-export-format"' not in page or project.name not in page:
                raise RuntimeError("Packaged response is not our PNG-capable editor project")
            assets = re.findall(r'<script\b[^>]*\bsrc="(/assets/[^"#]+)"', page)
            inline = re.findall(r"<script\b[^>]*>([\s\S]*?)</script>", page)
            if not assets and not any("AsrEditorUtils" in script and "MAWE_I18N" in script
                                      for script in inline):
                raise RuntimeError("Packaged editor has no application bundle")
            for asset in assets:
                with opener.open(url + asset, timeout=5) as response:
                    if response.status != 200 or not response.read(1):
                        raise RuntimeError("Packaged editor script is missing or empty")
            stopped = subprocess.run(
                [str(executable), "--stop-server", str(port)], cwd=run, env=env,
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, timeout=15, **options)
            if stopped.returncode != 0 or process.wait(timeout=15) != 0:
                raise RuntimeError("Packaged editor did not stop cleanly")
            (run / "result.json").write_text(json.dumps({
                "status": "passed", "pid": process.pid, "port": port,
                "externalScripts": len(assets), "inlineScripts": len(inline),
                "exitCode": process.returncode,
            }, indent=2) + "\n", encoding="utf-8")
            print(f"Packaged editor HTTP/bundle/start/stop passed ({len(assets)} external, {len(inline)} inline scripts)")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--output", type=Path, default=Path(".artifacts/packaged-editor-smoke"))
    parser.add_argument("--timeout", type=int, default=60, choices=range(1, 181), metavar="SECONDS")
    args = parser.parse_args()
    smoke(args.executable, args.output, args.timeout)


if __name__ == "__main__":
    main()
