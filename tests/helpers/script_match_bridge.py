"""JSON-lines test bridge: real LauncherApi matching, synthetic disk inputs."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from maw import postprocess_match
from maw.gui_web import LauncherApi, LauncherPaths
from scripts import mosp_match_text


def main() -> None:
    output_lock = threading.Lock()

    def send(message):
        with output_lock:
            print(json.dumps(message, ensure_ascii=True), flush=True)

    with tempfile.TemporaryDirectory(prefix="maw-match-browser-") as directory:
        root = Path(directory)
        fixtures = {}
        for timed in (False, True):
            group = "timed" if timed else "plain"
            fixtures[group] = []
            for index, text in enumerate(("甲乙" * 6000, "今天开始测试")):
                folder = root / f"{group}-{index}"
                folder.mkdir()
                project = folder / "source.mosp"
                script = folder / "script.txt"
                segment = {"start": 0, "end": max(1000, len(text) * 2), "text": text}
                if timed:
                    segment["items"] = [{"start": 0, "end": segment["end"], "text": text}]
                project.write_text(json.dumps({"segments": [segment]}, ensure_ascii=False), encoding="utf-8")
                script.write_text(text + "。", encoding="utf-8")
                fixtures[group].append({"projectPath": str(project), "scriptPath": str(script)})

        api = LauncherApi(paths=LauncherPaths(root=root, env_path=root / "unused.env", launcher_html=root / "launcher.html"), window_getter=lambda: None)
        api.pump.start = lambda: None
        api._emit = lambda event: send({"event": event})
        factory = mosp_match_text.cancellable_sequence_matcher

        def observe_search(*args, **kwargs):
            matcher = factory(*args, **kwargs)
            longest = matcher.find_longest_match

            def search(*args, **kwargs):
                send({"searchStarted": True})
                return longest(*args, **kwargs)

            matcher.find_longest_match = search
            return matcher

        workers = []

        def run(message):
            try:
                result = getattr(api, message["method"])(message["payload"])
                send({"id": message["id"], "result": result})
            except Exception as error:
                send({"id": message["id"], "error": str(error)})

        with mock.patch("maw.output_naming.subfolder_prefs", return_value=(False, False)), mock.patch.object(postprocess_match, "cancellable_sequence_matcher", side_effect=observe_search), mock.patch.object(mosp_match_text, "cancellable_sequence_matcher", side_effect=observe_search):
            send({"fixtures": fixtures})
            for line in sys.stdin:
                message = json.loads(line)
                if message["method"] == "inspect":
                    folder = Path(message["payload"]["projectPath"]).parent
                    send({"id": message["id"], "result": {"files": sorted(path.name for path in folder.iterdir())}})
                elif message["method"] == "run_script_match":
                    worker = threading.Thread(target=run, args=(message,), daemon=True)
                    workers.append(worker)
                    worker.start()
                elif message["method"] == "shutdown":
                    break
                else:
                    run(message)
            for operation in tuple(api._postprocess_operations.values()):
                operation.cancel()
            for worker in workers:
                worker.join(3)


if __name__ == "__main__":
    main()
