"""Run a check with file-backed output, a deadline, and bounded diagnostics.

No dependencies or environment installation. Invoke from the checkout being tested:
python scripts/run_check.py --timeout 180 -- python -m unittest tests.test_compact_assertions
"""

from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid

LINE_LIMIT = 240
DIAGNOSTIC_LIMIT = 20
TAIL_LIMIT = 6
SCAN_LIMIT = 16 * 1024 * 1024
DIAGNOSTIC = re.compile(
    r"^(?:FAIL|ERROR|FAILED|Ran |OK\b|not ok|\s*at |\s*File \"|[✖×])"
    r"|(?:AssertionError|Error:|Error\b|failed|skipped|tests |pass |fail )",
    re.IGNORECASE,
)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def compact(text: str, *, keep_end: bool = False) -> str:
    text = ANSI.sub("", text)
    text = "".join(c if c.isprintable() else " " for c in text).strip()
    if len(text) <= LINE_LIMIT:
        return text
    return "..." + text[-(LINE_LIMIT - 3):] if keep_end else text[:LINE_LIMIT - 3] + "..."


def summarize(path: Path) -> dict:
    """Scan a bounded prefix plus tail; never read an unbounded log line."""
    diagnostics = []
    tail = deque(maxlen=TAIL_LIMIT)
    size = path.stat().st_size
    with path.open("rb") as stream:
        scanned = 0
        continuation = False
        while scanned < min(size, SCAN_LIMIT):
            part = stream.readline(min(4096, SCAN_LIMIT - scanned))
            if not part:
                break
            scanned += len(part)
            if not continuation:
                line = compact(part.decode("utf-8", errors="replace"))
                if line and DIAGNOSTIC.search(line) and line not in diagnostics:
                    if len(diagnostics) < DIAGNOSTIC_LIMIT:
                        diagnostics.append(line)
            continuation = not part.endswith(b"\n")
        stream.seek(max(0, size - 8192))
        end = stream.read(8192).decode("utf-8", errors="replace").splitlines()
        # The first fragment may start mid-line, but it may also be the entire
        # available final line. Keep its bounded suffix so the terminal error
        # survives giant single-line diagnostics.
        for line in end:
            if line.strip():
                tail.append(compact(line, keep_end=True))
    return {"bytes": size, "scan_limited": size > SCAN_LIMIT,
            "diagnostics": diagnostics, "tail": list(tail)}


def stop_tree(proc: subprocess.Popen) -> str | None:
    """Terminate only the process tree/group created by this invocation."""
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if result.returncode and proc.poll() is None:
                proc.kill()
                return "taskkill failed; only the root process was killed"
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except (OSError, subprocess.TimeoutExpired) as error:
        if proc.poll() is None:
            proc.kill()
        return compact(f"Process tree cleanup failed: {error}")
    return None


def run(command: list[str], timeout: float, log_root: Path) -> tuple[int, dict]:
    run_dir = log_root / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8])
    run_dir.mkdir(parents=True)
    log_path = run_dir / "output.log"
    started = time.monotonic()
    status = "completed"
    cleanup_error = None
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "NO_COLOR": "1"}
    options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    # Files, not pipes: inherited descriptors cannot block communicate()/EOF.
    with log_path.open("wb") as log:
        try:
            proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log,
                                    stderr=subprocess.STDOUT, env=env, **options)
        except OSError as error:
            log.write(str(error).encode("utf-8", errors="replace"))
            code, status = 127, "launch-error"
        else:
            try:
                code = proc.wait(timeout=timeout)
            except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                code, status = (124, "timeout") if isinstance(error, subprocess.TimeoutExpired) else (130, "interrupted")
                cleanup_error = stop_tree(proc)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    cleanup_error = "Root process still running after cleanup; inspect recorded PID"
    result = {"status": status, "exit_code": code, "command": command,
              "cwd": str(Path.cwd()), "pid": proc.pid if 'proc' in locals() else None,
              "duration_seconds": round(time.monotonic() - started, 2),
              "timeout_seconds": timeout, "cleanup_error": cleanup_error,
              "log": str(log_path.resolve()), **summarize(log_path)}
    (run_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return code, result


def main() -> int:
    # The wrapper itself also runs on Windows consoles whose default is GBK.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--log-dir", type=Path, default=Path(".debug-runs"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("Supply a command after -- and a finite positive timeout")
    code, result = run(command, args.timeout, args.log_dir)
    print(f"{result['status']}: exit={code}, seconds={result['duration_seconds']}, log_bytes={result['bytes']}")
    print(f"Log: {result['log']}")
    if result["cleanup_error"]:
        print(result["cleanup_error"])
    if result["scan_limited"]:
        print("Diagnostic scan limited to first 16 MiB plus last 8 KiB; inspect a targeted log range if needed.")
    for line in dict.fromkeys(result["diagnostics"] + result["tail"]):
        print(line)
    # POSIX signal exits must remain failures when used as a shell exit status.
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    raise SystemExit(main())
