"""Launcher-only local project history. Stores paths and timestamps, never contents."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
from threading import Lock


class RecentProjects:
    LIMIT = 30

    def __init__(self, path: Path):
        self.path = path
        self.lock = Lock()

    def _load(self) -> dict:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        entries = raw.get("entries", [])
        if not isinstance(entries, list):
            entries = []
        normalized = []
        seen = set()
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            path = entry.get("path")
            opened = entry.get("openedAt")
            if not isinstance(path, str) or not path.strip() or not isinstance(opened, str):
                continue
            candidate = Path(path)
            if not candidate.is_absolute() or candidate.suffix.lower() not in {".mosp", ".json"}:
                continue
            key = os.path.normcase(str(candidate))
            if key in seen:
                continue
            seen.add(key)
            normalized.append({"path": str(candidate), "openedAt": opened})
        return {"enabled": raw.get("enabled") is not False, "entries": normalized[:self.LIMIT]}

    def _save(self, value: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=self.path.parent, delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(value, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
            temporary.replace(self.path)
        finally:
            # Only our short-lived temporary file is removed, never a user project.
            if temporary is not None and temporary.exists():
                temporary.unlink()

    @staticmethod
    def _payload(value: dict) -> dict:
        entries = []
        for entry in value["entries"]:
            try:
                exists = Path(entry["path"]).is_file()
            except (OSError, ValueError):
                exists = False
            entries.append({**entry, "exists": exists})
        return {"ok": True, "enabled": value["enabled"], "entries": entries, "limit": RecentProjects.LIMIT}

    def get(self) -> dict:
        with self.lock:
            return self._payload(self._load())

    def update(self, payload: dict) -> dict:
        with self.lock:
            value = self._load()
            action = payload.get("action")
            if action == "enabled":
                if not isinstance(payload.get("enabled"), bool):
                    raise ValueError("enabled must be a boolean")
                value["enabled"] = payload["enabled"]
            elif action == "clear":
                value["entries"] = []
            elif action in {"remember", "relocate", "remove"}:
                raw = payload.get("path")
                if not isinstance(raw, str) or not raw.strip():
                    raise ValueError("Project path is required")
                path = Path(raw).expanduser()
                if not path.is_absolute() or path.suffix.lower() not in {".mosp", ".json"}:
                    raise ValueError("An absolute .mosp or .json path is required")
                path = path.resolve()
                key = os.path.normcase(str(path))
                if action == "remove":
                    value["entries"] = [entry for entry in value["entries"] if os.path.normcase(entry["path"]) != key]
                else:
                    if not path.is_file():
                        raise ValueError("Project file does not exist")
                    if action == "relocate":
                        old = payload.get("previousPath")
                        if not isinstance(old, str) or not any(entry["path"] == old for entry in value["entries"]):
                            raise ValueError("Previous project is not in history")
                        original = next(entry for entry in value["entries"] if entry["path"] == old)
                        value["entries"] = [entry for entry in value["entries"] if entry["path"] != old and os.path.normcase(entry["path"]) != key]
                        value["entries"].insert(0, {"path": str(path), "openedAt": original["openedAt"]})
                    elif value["enabled"]:
                        value["entries"] = [entry for entry in value["entries"] if os.path.normcase(entry["path"]) != key]
                        value["entries"].insert(0, {"path": str(path), "openedAt": datetime.now(timezone.utc).isoformat()})
                        value["entries"] = value["entries"][:self.LIMIT]
            else:
                raise ValueError("Unknown recent project action")
            self._save(value)
            return self._payload(value)
