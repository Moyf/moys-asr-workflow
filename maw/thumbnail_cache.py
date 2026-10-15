"""Versioned filmstrip sidecars and bounded cross-session frame storage.

Decode flights belong to thumbnail_jobs and enter through coordination hooks.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import sqlite3
import tempfile
import threading
import time
import uuid
import zipfile
from collections import OrderedDict
from dataclasses import replace
from pathlib import Path
from typing import Sequence

from maw.app_paths import default_app_data_root
from maw.output_naming import waveform_dirs
from maw.thumbnails import IMAGE_SPEC, FrameResult, ThumbnailCancelled, ThumbnailError, VideoInfo, base_interval_ms, batches, extract_frames, extract_keyframes, make_sprite, probe_video

SCHEMA = "moy.asr.thumbnails.v1"
GENERATOR_VERSION = 3
BASE_IDENTITY_FIELDS = ("schema", "generator_version", "source_signature", "video_stream_index", "duration_ms", "source_start_ms", "video_start_ms", "time_origin", "image_spec")
MAX_SPRITE_FRAMES = 64
MEDIA_QUOTA_BYTES = 64 * 1024 * 1024
GLOBAL_QUOTA_BYTES = 512 * 1024 * 1024
SESSION_QUOTA_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_ASSET_BYTES = 2 * 1024 * 1024
MAX_SIDECAR_BYTES = 512 * 1024 * 1024
MAX_SAMPLES = 250_000
MAX_INDEX_BYTES = 32 * 1024 * 1024
BASE_GENERATION_BYTES = 64 * 1024 * 1024
_lock = threading.RLock()
_video_memo: dict[str, VideoInfo | None] = {}
_base_memo: OrderedDict[tuple, dict] = OrderedDict()
_session: OrderedDict[tuple[str, int], FrameResult] = OrderedDict()
_session_assets: dict[tuple[str, str], bytes] = {}
_write_disabled: set[str] = set()
_session_bases: dict[str, dict] = {}
_session_pins: dict[tuple[str, str, str], float] = {}
_base_touch: dict[str, float] = {}


def cache_root() -> Path:
    return default_app_data_root() / "thumbnail-cache"


def base_path(media_path: Path | str) -> Path:
    media = Path(media_path)
    return waveform_dirs(media)[0] / (media.name + ".mothumbs")


def base_candidates(media_path: Path | str) -> list[Path]:
    media = Path(media_path)
    paths = [directory / (media.name + ".mothumbs") for directory in waveform_dirs(media)]
    try:
        paths.append(cache_root() / "bases" / (_source_key(media) + ".mothumbs"))
    except OSError:
        pass
    return paths


def source_signature(media_path: Path | str) -> dict:
    """Browser fields plus exact nanoseconds for persistent cache identity."""
    media = Path(media_path).resolve()
    stat = media.stat()
    return {"name": media.name, "size": stat.st_size,
            "modified_ms": stat.st_mtime_ns // 1_000_000,
            "modified_ns": stat.st_mtime_ns}


def _source_key(media_path: Path | str, signature: dict | None = None) -> str:
    media = Path(media_path).resolve()
    return hashlib.sha256(json.dumps([os.path.normcase(str(media)), signature if signature is not None else source_signature(media)], sort_keys=True).encode()).hexdigest()


def _info(media_path: Path | str, *, cancel=None, ffmpeg_path=None) -> VideoInfo | None:
    key = _source_key(media_path)
    with _lock:
        if key in _video_memo:
            return _video_memo[key]
    cached = load_base(media_path)
    video = VideoInfo(cached["video_stream_index"], cached["duration_ms"], cached["source_start_ms"], cached["video_start_ms"]) if cached else probe_video(media_path, cancel=cancel, ffmpeg_path=ffmpeg_path)
    if _source_key(media_path) != key:
        raise ThumbnailError("source changed during video probe")
    with _lock:
        if len(_video_memo) > 128:
            _video_memo.clear()
        _video_memo[key] = video
    return video


def identity_key(media_path: Path | str, info: VideoInfo | None = None, *, ffmpeg_path=None) -> str:
    video = info or _info(media_path, ffmpeg_path=ffmpeg_path)
    if video is None:
        raise ThumbnailError("media contains no video")
    return hashlib.sha256(json.dumps([_source_key(media_path), video.stream_index, IMAGE_SPEC, GENERATOR_VERSION], sort_keys=True).encode()).hexdigest()


def sample_key(media_path: Path | str, requested_ms: int, stream_index: int | None = None, *, ffmpeg_path=None) -> str:
    video = _info(media_path, ffmpeg_path=ffmpeg_path)
    _validate_targets([requested_ms], video, stream_index)
    return f"{identity_key(media_path, video)}:{requested_ms}"


def _validate_targets(values, video, stream_index=None):
    if video is None:
        return
    if stream_index is not None and stream_index != video.stream_index:
        raise ValueError("stream_index does not name the source video")
    if any(not isinstance(t, int) or isinstance(t, bool) or not 0 <= t < video.duration_ms for t in values):
        raise ValueError("thumbnail requests must lie in [0, duration_ms)")


def _connect() -> sqlite3.Connection:
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / "frames.sqlite3", timeout=5)
    try:
        db.execute("PRAGMA busy_timeout=5000")
        # New databases reclaim deleted pages. Existing v1 databases keep their
        # layout but share this hard physical page bound and reuse free pages.
        db.execute("PRAGMA auto_vacuum=INCREMENTAL")
        page_size = db.execute("PRAGMA page_size").fetchone()[0]
        db.execute(f"PRAGMA max_page_count={(GLOBAL_QUOTA_BYTES + MAX_INDEX_BYTES) // page_size}")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS assets(media TEXT, asset TEXT, jpeg BLOB NOT NULL, size INTEGER NOT NULL, used REAL NOT NULL, PRIMARY KEY(media,asset));
            CREATE TABLE IF NOT EXISTS samples(media TEXT, requested INTEGER, actual INTEGER, status TEXT NOT NULL, asset TEXT, PRIMARY KEY(media,requested));
            CREATE TABLE IF NOT EXISTS keyframes(media TEXT, pts INTEGER NOT NULL, PRIMARY KEY(media,pts));
            CREATE TABLE IF NOT EXISTS pins_leases(media TEXT, asset TEXT, owner TEXT, expires REAL NOT NULL, PRIMARY KEY(media,asset,owner));
            CREATE TABLE IF NOT EXISTS bases(path TEXT PRIMARY KEY,media TEXT,size INTEGER NOT NULL,used REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS base_reservations(owner TEXT PRIMARY KEY,media TEXT,size INTEGER NOT NULL,expires REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS asset_lru ON assets(used);
        """)
        return db
    except BaseException:
        db.close()
        raise


def _asset_id(jpeg: bytes) -> str:
    return "frame-" + hashlib.sha256(jpeg).hexdigest()[:32]


def _jpeg_dimensions(blob: bytes) -> tuple[int, int] | None:
    """Read a JPEG SOF header without an imaging dependency."""
    if not blob.startswith(b"\xff\xd8"):
        return None
    index = 2
    while index + 4 <= len(blob):
        if blob[index] != 255:
            return None
        while index < len(blob) and blob[index] == 255:
            index += 1
        if index >= len(blob):
            return None
        marker = blob[index]
        index += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if index + 2 > len(blob):
            return None
        length = int.from_bytes(blob[index:index+2], "big")
        if length < 2 or index + length > len(blob):
            return None
        if marker in (0xC0, 0xC1, 0xC2):
            if length < 7:
                return None
            return int.from_bytes(blob[index+5:index+7], "big"), int.from_bytes(blob[index+3:index+5], "big")
        if marker == 0xDA:
            return None
        index += length
    return None


def _warning(key: str) -> None:
    with _lock:
        if key in _write_disabled:
            return
        _write_disabled.add(key)
    print("[thumbnails] image cache could not be persisted; using session cache")


def _remember(key: str, frame: FrameResult) -> None:
    with _lock:
        now = time.time()
        for pin, expires in list(_session_pins.items()):
            if expires <= now:
                del _session_pins[pin]
        if frame.jpeg:
            asset_key = (key, _asset_id(frame.jpeg))
            # Canonical bytes ensure held low-fps frames are measured once even
            # when separate batches returned equal but distinct byte objects.
            canonical = _session_assets.setdefault(asset_key, frame.jpeg)
            frame = replace(frame, jpeg=canonical)
        _session[(key, frame.requested_ms)] = frame
        _session.move_to_end((key, frame.requested_ms))
        total = sum(len(value) for value in _session_assets.values())
        protected = {(media, asset) for media, asset, _owner in _session_pins}
        for asset_key in list(_session_assets):
            if total <= SESSION_QUOTA_BYTES:
                break
            if asset_key in protected:
                continue
            total -= len(_session_assets.pop(asset_key))
            for sample in list(_session):
                result = _session[sample]
                if sample[0] == asset_key[0] and result.jpeg and _asset_id(result.jpeg) == asset_key[1]:
                    del _session[sample]
        while len(_session) > 8192:
            _session.popitem(last=False)


def protect_assets(media_path: Path | str, asset_ids: Sequence[str], *, lease_seconds: float = 30, owner: str = "default") -> None:
    key = identity_key(media_path)
    expires = time.time() + min(120, max(1, lease_seconds))
    with _lock:
        for asset in asset_ids:
            _session_pins[(key, asset, owner)] = expires
    try:
        with contextlib.closing(_connect()) as db, db:
            db.executemany("INSERT OR REPLACE INTO pins_leases VALUES(?,?,?,?)", [(key, asset, owner, expires) for asset in asset_ids])
    except (OSError, sqlite3.Error):
        _warning(key)


def release_assets(media_path: Path | str, asset_ids: Sequence[str], *, owner: str = "default") -> None:
    key = identity_key(media_path)
    with _lock:
        for asset in asset_ids:
            _session_pins.pop((key, asset, owner), None)
    try:
        with contextlib.closing(_connect()) as db, db:
            db.executemany("DELETE FROM pins_leases WHERE media=? AND asset=? AND owner=?", [(key, asset, owner) for asset in asset_ids])
    except (OSError, sqlite3.Error):
        pass


def release_owner(owner: str) -> None:
    """Release a view's pins even after its former source was replaced."""
    with _lock:
        for pin in list(_session_pins):
            if pin[2] == owner:
                del _session_pins[pin]
    try:
        with contextlib.closing(_connect()) as db, db:
            db.execute("DELETE FROM pins_leases WHERE owner=?", (owner,))
    except (OSError, sqlite3.Error):
        pass


def _recycle_registered_file(path: Path) -> None:
    """Recycle a single validated cache file, never delete a directory tree."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class FileOperation(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND), ("function", wintypes.UINT),
                        ("source", wintypes.LPCWSTR), ("destination", wintypes.LPCWSTR),
                        ("flags", wintypes.WORD), ("aborted", wintypes.BOOL),
                        ("mapping", ctypes.c_void_p), ("title", wintypes.LPCWSTR)]

        operation = FileOperation()
        operation.function = 3  # FO_DELETE with FOF_ALLOWUNDO moves to Recycle Bin.
        operation.source = str(path) + "\0\0"
        operation.flags = 0x0040 | 0x0010 | 0x0004 | 0x0400
        shell = ctypes.WinDLL("shell32")
        shell.SHFileOperationW.argtypes = [ctypes.POINTER(FileOperation)]
        result = shell.SHFileOperationW(ctypes.byref(operation))
        if result or operation.aborted or path.exists():
            raise OSError("registered thumbnail cache could not be recycled")
    else:
        import shutil
        import sys
        from urllib.parse import quote
        if sys.platform == "darwin":
            trash = Path.home() / ".Trash"
            trash.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(trash / (uuid.uuid4().hex + "-" + path.name)))
        else:
            trash = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "Trash"
            files, info = trash / "files", trash / "info"
            files.mkdir(parents=True, exist_ok=True)
            info.mkdir(parents=True, exist_ok=True)
            name = uuid.uuid4().hex + "-" + path.name
            metadata = info / (name + ".trashinfo")
            metadata.write_text("[Trash Info]\nPath=" + quote(str(path), safe="/") + "\nDeletionDate=" + time.strftime("%Y-%m-%dT%H:%M:%S") + "\n", encoding="utf-8", newline="\n")
            shutil.move(str(path), str(files / name))


def cleanup_registered(*, inactive_before: float, limit: int = 8, exclude_paths: Sequence[Path | str] = ()) -> dict:
    """Recycle only old registered base files without active pins/reservations.

    No source directory is scanned. Exclusions automatically include the
    corresponding partial file, so the caller can protect every current-source
    base_candidates entry before cache lookup or generation.
    """
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 32:
        raise ValueError("cleanup limit must be between1 and32")
    excluded = set()
    for path in exclude_paths:
        name = os.path.normcase(str(Path(path).resolve()))
        excluded.update((name, name + ".partial"))
    result = {"removed_count": 0, "missing_count": 0, "released_bytes": 0, "skipped_active": 0, "skipped_excluded": 0, "errors": []}
    try:
        with contextlib.closing(_connect()) as db, db:
            db.execute("DELETE FROM pins_leases WHERE expires<=?", (time.time(),))
            db.execute("DELETE FROM base_reservations WHERE expires<=?", (time.time(),))
            rows = db.execute("SELECT path,media FROM bases WHERE used<=? ORDER BY used LIMIT ?", (inactive_before, limit*4)).fetchall()
        for name, media in rows:
            if result["removed_count"] + result["missing_count"] >= limit:
                break
            if name in excluded:
                result["skipped_excluded"] += 1
                continue
            path = Path(name)
            if not (path.name.endswith(".mothumbs") or path.name.endswith(".mothumbs.partial")) or path.is_symlink():
                result["errors"].append({"name": path.name, "reason": "not a registered regular sidecar"})
                continue
            try:
                with _write_lock(path.with_name(path.name + ".lock"), timeout_s=.2), contextlib.closing(_connect()) as db, db:
                    db.execute("BEGIN IMMEDIATE")
                    row = db.execute("SELECT size,used FROM bases WHERE path=? AND media=?", (name, media)).fetchone()
                    active = db.execute("SELECT 1 FROM pins_leases WHERE media=? AND expires>? UNION ALL SELECT 1 FROM base_reservations WHERE media=? AND expires>?", (media, time.time(), media, time.time())).fetchone()
                    if not row or row[1] > inactive_before or active:
                        result["skipped_active"] += 1
                        continue
                    if not path.exists():
                        result["missing_count"] += 1
                    else:
                        stat = path.stat()
                        if not path.is_file() or stat.st_mtime > inactive_before or stat.st_size != row[0]:
                            result["skipped_active"] += 1
                            continue
                        # A registered path that was replaced by a user's
                        # unrelated file must not be removed using stale data.
                        with zipfile.ZipFile(path) as archive:
                            entry = archive.getinfo("manifest.json")
                            if entry.file_size > MAX_MANIFEST_BYTES:
                                raise ValueError("manifest budget exceeded")
                            manifest = json.loads(archive.read(entry))
                            if manifest.get("schema") != SCHEMA or not isinstance(manifest.get("cache_revision"), str):
                                raise ValueError("registered sidecar was replaced")
                        _recycle_registered_file(path)
                        result["removed_count"] += 1
                    db.execute("DELETE FROM bases WHERE path=?", (name,))
                    result["released_bytes"] += row[0]
                    with _lock:
                        for memo in list(_base_memo):
                            if os.path.normcase(memo[0]) == name:
                                del _base_memo[memo]
            except (OSError, ThumbnailError, ValueError, KeyError, zipfile.BadZipFile, sqlite3.Error) as error:
                result["errors"].append({"name": path.name, "reason": str(error)[:160]})
    except (OSError, sqlite3.Error) as error:
        result["errors"].append({"name": "registry", "reason": str(error)[:160]})
    return result


def _sizes(db, media):
    media_size, global_size = db.execute("SELECT COALESCE(SUM(CASE WHEN media=? THEN size ELSE 0 END),0),COALESCE(SUM(size),0) FROM assets", (media,)).fetchone()
    for table in ("bases", "base_reservations"):
        where = " WHERE expires>" + str(time.time()) if table == "base_reservations" else ""
        own, total = db.execute(f"SELECT COALESCE(SUM(CASE WHEN media=? THEN size ELSE 0 END),0),COALESCE(SUM(size),0) FROM {table}{where}", (media,)).fetchone()
        media_size += own
        global_size += total
    return media_size, global_size


def _evict(db, media: str, incoming: int, protected: set[str]) -> bool:
    db.execute("DELETE FROM pins_leases WHERE expires<=?", (time.time(),))
    db.execute("DELETE FROM base_reservations WHERE expires<=?", (time.time(),))
    media_size, global_size = _sizes(db, media)
    rows = db.execute("SELECT a.media,a.asset,a.size FROM assets a WHERE NOT EXISTS(SELECT 1 FROM pins_leases p WHERE p.media=a.media AND p.asset=a.asset) ORDER BY a.used").fetchall()
    for source, asset, size in rows:
        if media_size + incoming <= MEDIA_QUOTA_BYTES and global_size + incoming <= GLOBAL_QUOTA_BYTES:
            return True
        if source == media and asset in protected:
            continue
        if media_size + incoming > MEDIA_QUOTA_BYTES and source != media:
            continue
        db.execute("DELETE FROM samples WHERE media=? AND asset=?", (source, asset))
        db.execute("DELETE FROM assets WHERE media=? AND asset=?", (source, asset))
        global_size -= size
        if source == media:
            media_size -= size
    db.execute("PRAGMA incremental_vacuum(64)")
    return media_size + incoming <= MEDIA_QUOTA_BYTES and global_size + incoming <= GLOBAL_QUOTA_BYTES


def cache_pressure(media_path: Path | str) -> dict:
    key = identity_key(media_path)
    with _lock:
        session_size = sum(len(value) for value in _session_assets.values())
        disabled = key in _write_disabled
    try:
        with contextlib.closing(_connect()) as db:
            own, total = _sizes(db, key)
    except (OSError, sqlite3.Error):
        own, total, disabled = MEDIA_QUOTA_BYTES, GLOBAL_QUOTA_BYTES, True
    return {"media_available_bytes": max(0, MEDIA_QUOTA_BYTES-own),
            "global_available_bytes": max(0, GLOBAL_QUOTA_BYTES-total),
            "session_available_bytes": max(0, SESSION_QUOTA_BYTES-session_size),
            "write_disabled": disabled}


def can_prefetch(media_path: Path | str) -> bool:
    pressure = cache_pressure(media_path)
    return not pressure["write_disabled"] and min(pressure["media_available_bytes"], pressure["global_available_bytes"], pressure["session_available_bytes"]) >= 64 * 1024


def register_frames(media_path: Path | str, frames: Sequence[FrameResult], *, info: VideoInfo | None = None, ffmpeg_path=None, expected_source: dict | None = None) -> list[dict]:
    signature = source_signature(media_path)
    if expected_source is not None and signature != expected_source:
        raise ThumbnailError("source changed before thumbnail registration")
    video = info or _info(media_path, ffmpeg_path=ffmpeg_path)
    _validate_targets([f.requested_ms for f in frames], video)
    if video is None:
        return []
    if source_signature(media_path) != signature:
        raise ThumbnailError("source changed during thumbnail registration")
    # Derive the destination from the captured identity. Even if replacement
    # happens after this check, old frames can only enter their old namespace.
    key = hashlib.sha256(json.dumps([_source_key(media_path, signature), video.stream_index, IMAGE_SPEC, GENERATOR_VERSION], sort_keys=True).encode()).hexdigest()
    for frame in frames:
        if frame.status == "target" and (frame.actual_pts_ms is None or not 0 <= frame.actual_pts_ms < video.duration_ms or not frame.jpeg or _jpeg_dimensions(frame.jpeg) != (160, 90)):
            raise ThumbnailError("invalid sampled frame")
        _remember(key, frame)
    if key not in _write_disabled:
        try:
            with contextlib.closing(_connect()) as db, db:
                protected = {_asset_id(f.jpeg) for f in frames if f.jpeg}
                for frame in frames:
                    asset = _asset_id(frame.jpeg) if frame.jpeg else None
                    if asset:
                        existing = db.execute("SELECT 1 FROM assets WHERE media=? AND asset=?", (key, asset)).fetchone()
                        if not existing and not _evict(db, key, len(frame.jpeg), protected):
                            _warning(key)
                            continue
                        db.execute("INSERT OR REPLACE INTO assets VALUES(?,?,?,?,?)", (key, asset, frame.jpeg, len(frame.jpeg), time.time()))
                    if db.execute("SELECT COUNT(*) FROM samples").fetchone()[0] >= MAX_SAMPLES:
                        db.execute("DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples WHERE status='unavailable' LIMIT 256)")
                    if db.execute("SELECT COUNT(*) FROM samples").fetchone()[0] >= MAX_SAMPLES and not db.execute("SELECT 1 FROM samples WHERE media=? AND requested=?", (key, frame.requested_ms)).fetchone():
                        _warning(key)
                        continue
                    db.execute("INSERT OR REPLACE INTO samples VALUES(?,?,?,?,?)", (key, frame.requested_ms, frame.actual_pts_ms, frame.status, asset))
        except (OSError, sqlite3.Error):
            _warning(key)
    return [_sample(frame, _asset_id(frame.jpeg) if frame.jpeg else None) for frame in frames]


def _sample(frame: FrameResult, asset: str | None, crop=None) -> dict:
    return {"requested_ms": frame.requested_ms, "actual_pts_ms": frame.actual_pts_ms, "status": frame.status, "asset": asset, "crop_rect": crop or [0, 0, 160, 90]}


def _persistent_frames(key: str, values: Sequence[int]) -> dict[int, FrameResult]:
    found = {}
    try:
        with contextlib.closing(_connect()) as db:
            for batch in (values[i:i+500] for i in range(0, len(values), 500)):
                if not batch:
                    continue
                placeholders = ",".join("?" for _ in batch)
                rows = db.execute(f"SELECT s.requested,s.actual,s.status,a.jpeg FROM samples s LEFT JOIN assets a ON s.media=a.media AND s.asset=a.asset WHERE s.media=? AND s.requested IN ({placeholders})", [key, *batch]).fetchall()
                for requested, actual, status, jpeg in rows:
                    if status == "unavailable":
                        found[requested] = FrameResult(requested, None, status, None)
                    elif jpeg and _jpeg_dimensions(jpeg) == (160, 90):
                        found[requested] = FrameResult(requested, actual, status, jpeg)
    except (OSError, sqlite3.Error):
        pass
    return found


def _persistent_markers(key: str, low_ms: int, high_ms: int) -> list[dict]:
    """Landmark markers inside one time window; content is best-available.

    Positions live in the dedicated keyframes table and survive exact
    refinement; each position serves its preview row when present, else the
    refined row that replaced it.
    """
    try:
        with contextlib.closing(_connect()) as db:
            positions = [row[0] for row in db.execute("SELECT pts FROM keyframes WHERE media=? AND pts>=? AND pts<=? ORDER BY pts", [key, low_ms, high_ms]).fetchall()]
            if not positions:
                return []
            placeholders = ",".join("?" for _ in positions)
            rows = db.execute(f"SELECT s.requested,s.actual,s.status,a.asset FROM samples s LEFT JOIN assets a ON s.media=a.media AND s.asset=a.asset WHERE s.media=? AND s.requested IN ({placeholders})", [key, *positions]).fetchall()
    except (OSError, sqlite3.Error):
        return []
    markers = []
    for requested, actual, status, asset in rows:
        if not asset:
            continue
        markers.append({"requested_ms": requested, "actual_pts_ms": actual, "status": status or "preview", "asset": asset, "crop_rect": [0, 0, 160, 90]})
    return sorted(markers, key=lambda marker: marker["requested_ms"])


def register_keyframe_marks(media_path: Path | str, stamps_ms: Sequence[int], *, info: VideoInfo | None = None) -> None:
    """Persist landmark positions once; exact refinement never removes them."""
    video = info or _info(media_path)
    if video is None or not stamps_ms:
        return
    key = identity_key(media_path, video)
    try:
        with contextlib.closing(_connect()) as db, db:
            db.executemany("INSERT OR REPLACE INTO keyframes VALUES(?,?)", [(key, int(stamp)) for stamp in stamps_ms])
    except (OSError, sqlite3.Error):
        pass


def lookup_frames(media_path: Path | str, requested_ms: Sequence[int], *, stream_index: int | None = None, ffmpeg_path=None) -> list[FrameResult | None]:
    """Metadata-only cache query: sprite hits never launch FFmpeg."""
    video = _info(media_path, ffmpeg_path=ffmpeg_path)
    _validate_targets(requested_ms, video, stream_index)
    if video is None:
        return [FrameResult(t, None, "unavailable", None) for t in requested_ms]
    key = identity_key(media_path, video)
    with _lock:
        found = {t: _session[(key, t)] for t in requested_ms if (key, t) in _session}
    found.update((t, FrameResult(t, None, "unavailable", None)) for t in requested_ms if t < video.video_start_ms)
    found.update(_persistent_frames(key, [t for t in set(requested_ms) if t not in found]))
    base = load_base(media_path)
    if base:
        for sample in base["samples"]:
            target = sample["requested_ms"]
            if target in requested_ms and target not in found:
                found[target] = FrameResult(target, sample["actual_pts_ms"], sample["status"], None)
    return [found.get(t) for t in requested_ms]


def _crop_sprite(jpeg: bytes, samples: Sequence[dict], *, cancel=None, ffmpeg_path=None) -> dict[int, FrameResult]:
    """Unpack all requested crops in one image-only FFmpeg task."""
    from maw.ffmpeg import resolve_ffmpeg_tool
    from maw.thumbnails import _run
    tool = resolve_ffmpeg_tool("ffmpeg", ffmpeg_path)
    if tool is None or not samples:
        return {}
    with tempfile.TemporaryDirectory(prefix="maw-crop-") as temp:
        root = Path(temp)
        (root / "in.jpg").write_bytes(jpeg)
        n = len(samples)
        filters = [f"[0:v]split={n}" + "".join(f"[s{i}]" for i in range(n))] if n > 1 else []
        for i, sample in enumerate(samples):
            x, y, w, h = sample["crop_rect"]
            filters.append(f"[{'s'+str(i) if n > 1 else '0:v'}]crop={w}:{h}:{x}:{y}[o{i}]")
        command = [str(tool), "-v", "error", "-nostdin", "-threads", "2", "-filter_complex_threads", "1", "-i", str(root / "in.jpg"), "-filter_complex", ";".join(filters)]
        for i in range(n):
            command += ["-map", f"[o{i}]", "-frames:v", "1", "-q:v", "5", "-pix_fmt", "yuvj420p", "-threads", "1", "-y", str(root / f"{i}.jpg")]
        result = _run(command, timeout_s=20, cancel=cancel)
        if result.returncode:
            raise ThumbnailError("could not unpack cached sprite")
        return {sample["requested_ms"]: FrameResult(sample["requested_ms"], sample["actual_pts_ms"], "target", (root / f"{i}.jpg").read_bytes()) for i, sample in enumerate(samples)}


def _with_jpegs(media_path, frames, *, cancel=None, ffmpeg_path=None):
    missing = {frame.requested_ms for frame in frames if frame is not None and frame.status == "target" and frame.jpeg is None}
    if not missing:
        return frames
    groups = {}
    base = load_base(media_path)
    if base:
        for sample in base["samples"]:
            if sample["requested_ms"] in missing:
                groups.setdefault(sample["asset"], []).append(sample)
    found = {}
    for asset, samples in groups.items():
        jpeg = read_asset(media_path, asset, cache_revision=base["cache_revision"])
        if jpeg:
            found.update(_crop_sprite(jpeg, samples, cancel=cancel, ffmpeg_path=ffmpeg_path))
    return [found.get(frame.requested_ms, frame) if frame else None for frame in frames]


def get_or_extract_frames(media_path: Path | str, requested_ms: Sequence[int], *, stream_index: int | None = None, cancel=None, extractor=None, ffmpeg_path=None) -> list[FrameResult]:
    cached = _with_jpegs(media_path, lookup_frames(media_path, requested_ms, stream_index=stream_index, ffmpeg_path=ffmpeg_path), cancel=cancel, ffmpeg_path=ffmpeg_path)
    missing = sorted({t for t, value in zip(requested_ms, cached) if value is None or value.status == "preview" or (value.status == "target" and value.jpeg is None)})
    if missing:
        video = _info(media_path, cancel=cancel, ffmpeg_path=ffmpeg_path)
        expected = source_signature(media_path)
        generated = extractor(media_path, missing, stream_index=video.stream_index, cancel=cancel) if extractor else extract_frames(media_path, missing, stream_index=video.stream_index, cancel=cancel, ffmpeg_path=ffmpeg_path)
        if source_signature(media_path) != expected:
            raise ThumbnailError("source changed during thumbnail extraction")
        register_frames(media_path, generated, info=video, ffmpeg_path=ffmpeg_path, expected_source=expected)
        by_target = {frame.requested_ms: frame for frame in generated}
        return [by_target.get(t, value) for t, value in zip(requested_ms, cached)]
    return cached


def get_or_extract_frame(media_path: Path | str, requested_ms: int, *, stream_index: int | None = None, cancel=None, ffmpeg_path=None) -> FrameResult:
    return get_or_extract_frames(media_path, [requested_ms], stream_index=stream_index, cancel=cancel, ffmpeg_path=ffmpeg_path)[0]


def _manifest(video: VideoInfo, signature: dict, *, interval: int, samples=None, assets=None, complete=False, revision=None) -> dict:
    samples = samples or []
    return {"schema": SCHEMA, "generator_version": GENERATOR_VERSION, "cache_revision": revision or uuid.uuid4().hex, "source_signature": signature, "video_stream_index": video.stream_index, "duration_ms": video.duration_ms, "source_start_ms": video.start_ms, "time_origin": "source-format-start-ms", "video_start_ms": video.video_start_ms, "image_spec": dict(IMAGE_SPEC), "sampling_interval": interval, "target_interval": interval, "base_complete": complete, "valid_count": sum(s["status"] == "target" for s in samples), "coverage": [[video.video_start_ms, video.duration_ms]] if complete else [[s["requested_ms"], min(video.duration_ms, s["requested_ms"] + interval)] for s in samples if s["status"] == "target"], "samples": samples, "assets": assets or [], "state": "ready" if complete else "partial", "persisted": True}


def _valid_manifest(value, signature, entries) -> bool:
    if not isinstance(value, dict) or value.get("schema") != SCHEMA or value.get("generator_version") != GENERATOR_VERSION or value.get("source_signature") != signature or value.get("image_spec") != IMAGE_SPEC:
        return False
    duration, interval = value.get("duration_ms"), value.get("target_interval")
    samples, assets = value.get("samples"), value.get("assets")
    if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0 or interval not in (250, 500, 1000, 2000, 5000, 10000) or not isinstance(samples, list) or len(samples) > MAX_SAMPLES or not isinstance(assets, list):
        return False
    if not isinstance(value.get("video_stream_index"), int) or value["video_stream_index"] < 0 or not isinstance(value.get("source_start_ms"), int) or not isinstance(value.get("cache_revision"), str) or len(value["cache_revision"]) != 32:
        return False
    video_start = value.get("video_start_ms")
    if value.get("time_origin") != "source-format-start-ms" or not isinstance(video_start, int) or isinstance(video_start, bool) or not 0 <= video_start < duration:
        return False
    if value.get("sampling_interval") not in (250, 500, 1000, 2000, 5000, 10000):
        return False
    asset_map = {}
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get("id"), str) or not asset["id"].startswith("sprite-") or asset["id"] in asset_map:
            return False
        entry = entries.get("assets/" + asset["id"] + ".jpg")
        count = asset.get("valid_count")
        if entry is None or not isinstance(count, int) or not 1 <= count <= 64 or asset.get("width") != 1280 or asset.get("height") != math.ceil(count / 8) * 90:
            return False
        asset_map[asset["id"]] = asset
    seen = set()
    counts = dict.fromkeys(asset_map, 0)
    for sample in samples:
        if not isinstance(sample, dict):
            return False
        target, actual, asset, crop = (sample.get(field) for field in ("requested_ms", "actual_pts_ms", "asset", "crop_rect"))
        if not isinstance(target, int) or isinstance(target, bool) or not 0 <= target < duration or target in seen:
            return False
        if sample.get("status") == "unavailable":
            if target >= video_start or actual is not None or asset is not None:
                return False
            seen.add(target)
            continue
        if sample.get("status") != "target" or not isinstance(actual, int) or not video_start <= actual < duration or not isinstance(asset, str) or asset not in asset_map:
            return False
        if not isinstance(crop, list) or len(crop) != 4 or any(not isinstance(x, int) or isinstance(x, bool) for x in crop) or crop[2:] != [160, 90] or crop[0] < 0 or crop[1] < 0 or crop[0] + 160 > 1280 or crop[1] + 90 > asset_map[asset]["height"]:
            return False
        seen.add(target)
        counts[asset] += 1
    if sum(counts.values()) != value.get("valid_count") or any(counts[asset] != row["valid_count"] for asset, row in asset_map.items()):
        return False
    complete = all(t in seen for t in range(0, duration, interval)) and value["sampling_interval"] <= interval
    return value.get("base_complete") is complete


def _load_candidate(path: Path, signature: dict) -> dict | None:
    try:
        stat = path.stat()
        if stat.st_size > MAX_SIDECAR_BYTES:
            return None
        memo_key = (str(path), stat.st_mtime_ns, stat.st_size, json.dumps(signature, sort_keys=True))
        with _lock:
            if memo_key in _base_memo:
                return _base_memo[memo_key]
        with zipfile.ZipFile(path) as archive:
            entries = {info.filename: info for info in archive.infolist()}
            manifest_entry = entries.get("manifest.json")
            if len(entries) != len(archive.infolist()) or len(entries) > 16384 or manifest_entry is None or manifest_entry.file_size > MAX_MANIFEST_BYTES:
                return None
            if any(info.compress_type != zipfile.ZIP_STORED or info.file_size > (MAX_MANIFEST_BYTES if name == "manifest.json" else MAX_ASSET_BYTES) for name, info in entries.items()):
                return None
            value = json.loads(archive.read("manifest.json"))
            if not _valid_manifest(value, signature, entries):
                return None
            for asset in value["assets"]:
                jpeg = archive.read("assets/" + asset["id"] + ".jpg")
                if _jpeg_dimensions(jpeg) != (asset["width"], asset["height"]):
                    return None
        with _lock:
            _base_memo[memo_key] = value
            while len(_base_memo) > 16 or sum(len(json.dumps(v)) for v in _base_memo.values()) > MAX_MANIFEST_BYTES:
                _base_memo.popitem(last=False)
        return value
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, RuntimeError):
        return None


def _touch_base(path: Path) -> None:
    canonical = os.path.normcase(str(path.resolve()))
    now = time.time()
    with _lock:
        if now - _base_touch.get(canonical, 0) < 60:
            return
        _base_touch[canonical] = now
        if len(_base_touch) > 128:
            _base_touch.pop(next(iter(_base_touch)))
    try:
        with contextlib.closing(_connect()) as db, db:
            db.execute("UPDATE bases SET used=? WHERE path=?", (now, canonical))
    except (OSError, sqlite3.Error):
        pass


def _all_base_hits(media_path: Path | str) -> list[tuple[Path | None, dict]]:
    try:
        signature, key = source_signature(Path(media_path)), _source_key(media_path)
    except OSError:
        return []
    hits = []
    for path in base_candidates(media_path):
        for candidate in (path, path.with_name(path.name + ".partial")):
            value = _load_candidate(candidate, signature)
            if value:
                _touch_base(candidate)
                hits.append((candidate, value))
    with _lock:
        if key in _session_bases:
            hits.append((None, _session_bases[key]))
    return hits


def _compatible_base_hits(media_path: Path | str) -> list[tuple[Path | None, dict]]:
    hits = _all_base_hits(media_path)
    if not hits:
        return []
    def rank(value):
        return (value["base_complete"], -value["target_interval"], value["valid_count"], value["cache_revision"])
    hits.sort(key=lambda hit: rank(hit[1]), reverse=True)
    best = hits[0][1]
    return [(path, value) for path, value in hits if all(value[field] == best[field] for field in BASE_IDENTITY_FIELDS)]


def _base_revision(hits) -> str:
    revisions = sorted({value["cache_revision"] for _, value in hits})
    return revisions[0] if len(revisions) == 1 else hashlib.sha256(json.dumps(revisions).encode()).hexdigest()[:32]


def load_base(media_path: Path | str) -> dict | None:
    """Merge compatible samples without promoting partial coverage to completion.

    The best persisted manifest still owns the full-grid completion metadata.
    Other candidates only contribute reusable samples and their original crops.
    This query view is never serialized back to a sidecar.
    """
    hits = _compatible_base_hits(media_path)
    if not hits:
        return None
    if len(hits) == 1:
        return hits[0][1]
    result = dict(hits[0][1])
    samples, assets = {}, {}
    for _, value in hits:
        for sample in value["samples"]:
            samples.setdefault(sample["requested_ms"], sample)
        for asset in value["assets"]:
            assets.setdefault(asset["id"], asset)
    result["samples"] = sorted(samples.values(), key=lambda sample: sample["requested_ms"])
    used = {sample["asset"] for sample in result["samples"] if sample["asset"]}
    result["assets"] = [assets[asset] for asset in sorted(used)]
    result["valid_count"] = sum(sample["status"] == "target" for sample in result["samples"])
    result["cache_revision"] = _base_revision(hits)
    if not result["base_complete"]:
        result["coverage"] = [[sample["requested_ms"], min(result["duration_ms"], sample["requested_ms"] + result["sampling_interval"])] for sample in result["samples"] if sample["status"] == "target"]
    return result


def has_cached_frames(media_path: Path | str, *, ffmpeg_path=None) -> bool:
    """True when any persisted picture exists: a base manifest or SQLite cells."""
    if load_base(media_path) is not None:
        return True
    try:
        video = _info(media_path, ffmpeg_path=ffmpeg_path)
    except (OSError, ValueError, ThumbnailError):
        # Unreadable media has no usable cache either; never fail a binding
        # payload just because the source cannot be probed.
        return False
    if video is None:
        return False
    key = identity_key(media_path, video)
    try:
        with contextlib.closing(_connect()) as db:
            return db.execute("SELECT 1 FROM samples WHERE media=? LIMIT 1", (key,)).fetchone() is not None
    except (OSError, sqlite3.Error):
        return False


def read_asset(media_path: Path | str, asset_id: str, *, cache_revision: str | None = None) -> bytes | None:
    if not isinstance(asset_id, str) or len(asset_id) > 100:
        return None
    try:
        key = identity_key(media_path)
    except (OSError, ThumbnailError):
        return None
    if asset_id.startswith("sprite-"):
        hits = _compatible_base_hits(media_path)
        combined = _base_revision(hits) if hits else ""
        if cache_revision and cache_revision != combined and not any(value["cache_revision"] == cache_revision for _, value in hits):
            return None
        for path, value in hits:
            if cache_revision and cache_revision != combined and value["cache_revision"] != cache_revision:
                continue
            if not any(asset["id"] == asset_id for asset in value["assets"]):
                continue
            with _lock:
                jpeg = _session_assets.get((key, asset_id))
            if jpeg:
                return jpeg
            if path:
                try:
                    with zipfile.ZipFile(path) as archive:
                        return archive.read("assets/" + asset_id + ".jpg")
                except (OSError, KeyError, zipfile.BadZipFile, RuntimeError):
                    return None
        return None
    with _lock:
        jpeg = _session_assets.get((key, asset_id))
    if jpeg:
        return jpeg
    try:
        with contextlib.closing(_connect()) as db, db:
            row = db.execute("SELECT jpeg FROM assets WHERE media=? AND asset=?", (key, asset_id)).fetchone()
            if row:
                db.execute("UPDATE assets SET used=? WHERE media=? AND asset=?", (time.time(), key, asset_id))
                return row[0] if _jpeg_dimensions(row[0]) == (160, 90) else None
    except (OSError, sqlite3.Error):
        pass
    return None


def sample_manifest(media_path: Path | str, requested_ms: Sequence[int], *, stream_index: int | None = None, nearby_ms: int = 10000) -> dict:
    video = _info(media_path)
    if video is None:
        return {"schema": SCHEMA, "samples": [], "assets": [], "state": "unavailable"}
    _validate_targets(requested_ms, video, stream_index)
    key, base = identity_key(media_path, video), load_base(media_path)
    result = _manifest(video, source_signature(Path(media_path)), interval=base_interval_ms(video.duration_ms), revision=key[:32])
    result.update(base or {})
    result["samples"], result["assets"] = [], []
    base_map = {s["requested_ms"]: s for s in base["samples"]} if base else {}
    persistent = _persistent_frames(key, list(requested_ms))
    with _lock:
        local = {target: frame for (owner, target), frame in _session.items() if owner == key}
    local.update(persistent)
    assets = {a["id"]: a for a in base["assets"]} if base else {}
    # Keyframe-tier landmarks live at their own keyframe PTS. Grid requests
    # hold the nearest preceding landmark (even far back in long-GOP films or
    # after decimation); marks-mode clients draw the in-span markers directly.
    if requested_ms:
        span_low, span_high = min(requested_ms), max(requested_ms)
        in_span = _persistent_markers(key, span_low, span_high)
        before = _persistent_markers(key, 0, span_low - 1) if span_low > 0 else []
        nearest_before = before[-1] if before else None
        previews = ([nearest_before] if nearest_before else []) + in_span
        markers = in_span
    else:
        previews, markers = [], []
    for target in requested_ms:
        if target < video.video_start_ms:
            result["samples"].append(_sample(FrameResult(target, None, "unavailable", None), None))
            continue
        if target in base_map:
            sample = dict(base_map[target])
        elif target in local:
            frame = local[target]
            sample = _sample(frame, _asset_id(frame.jpeg) if frame.jpeg else None)
        else:
            covering = next((dict(row) for row in reversed(previews) if row["requested_ms"] <= target + 0.001), None)
            if covering is not None:
                sample = dict(covering)
                sample["requested_ms"] = target
            else:
                limit = min(max(0, nearby_ms), max(10000, 2 * result["sampling_interval"]))
                nearby = [s for s in base_map.values() if abs(s["requested_ms"] - target) <= limit]
                nearby += [_sample(f, _asset_id(f.jpeg)) for f in local.values() if f.jpeg and f.status == "target" and abs(f.requested_ms - target) <= limit]
                if not nearby:
                    continue
                sample = dict(min(nearby, key=lambda s: abs(s["requested_ms"] - target)))
                sample["requested_ms"], sample["status"] = target, "preview"
        result["samples"].append(sample)
        if sample["asset"] and sample["asset"] not in assets:
            assets[sample["asset"]] = {"id": sample["asset"], "width": 160, "height": 90, "valid_count": 1}
    used = {s["asset"] for s in result["samples"] if s["asset"]}
    if markers:
        result["keyframes"] = list(markers)
        used |= {row["asset"] for row in markers}
        for row in markers:
            if row["asset"] not in assets:
                assets[row["asset"]] = {"id": row["asset"], "width": 160, "height": 90, "valid_count": 1}
    result["assets"] = [asset for ident, asset in assets.items() if ident in used]
    result["persisted"] = key not in _write_disabled
    return result


@contextlib.contextmanager
def _write_lock(path: Path, *, cancel=None, timeout_s=20):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        deadline = time.monotonic() + timeout_s
        while True:
            if cancel is not None and cancel.is_set():
                raise ThumbnailCancelled("thumbnail write cancelled")
            try:
                if os.name == "nt":
                    import msvcrt
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise ThumbnailError("thumbnail write lock timed out")
                time.sleep(0.05)
        try:
            yield
        finally:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def _base_budget(path, media_path, manifest, size):
    key = identity_key(media_path, VideoInfo(manifest["video_stream_index"], manifest["duration_ms"], manifest["source_start_ms"]))
    owner = uuid.uuid4().hex
    canonical = os.path.normcase(str(path.resolve()))
    try:
        with contextlib.closing(_connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            # Missing registered caches no longer occupy their old allocation.
            for registered, in db.execute("SELECT path FROM bases").fetchall():
                if not Path(registered).is_file():
                    db.execute("DELETE FROM bases WHERE path=?", (registered,))
            previous = db.execute("SELECT size FROM bases WHERE path=? AND media=?", (canonical, key)).fetchone()
            # The same-path write lock keeps this old allocation exclusive to
            # its replacement. Reserve only growth, while retaining the old
            # registry entry until publication succeeds. Other paths cannot
            # spend that credit; staging keeps its existing separate bounds.
            incoming = max(0, size - previous[0]) if previous else size
            if not _evict(db, key, incoming, set()):
                raise OSError("thumbnail cache disk budget exhausted")
            db.execute("INSERT INTO base_reservations VALUES(?,?,?,?)", (owner, key, incoming, time.time()+60))
        yield
        with contextlib.closing(_connect()) as db, db:
            db.execute("INSERT OR REPLACE INTO bases VALUES(?,?,?,?)", (canonical, key, path.stat().st_size, time.time()))
            db.execute("DELETE FROM base_reservations WHERE owner=?", (owner,))
    finally:
        with contextlib.closing(_connect()) as db, db:
            db.execute("DELETE FROM base_reservations WHERE owner=?", (owner,))


def _atomic_save(path: Path, manifest: dict, blobs: dict, media_path: Path | str, *, cancel=None) -> bool:
    size = len(json.dumps(manifest, separators=(",", ":")).encode()) + sum(value.stat().st_size if isinstance(value, Path) else len(value) for value in blobs.values()) + (len(blobs)+1)*200
    if size > MAX_SIDECAR_BYTES:
        raise ThumbnailError("base sidecar exceeds size budget")
    with _write_lock(path.with_name(path.name + ".lock"), cancel=cancel):
        if source_signature(media_path) != manifest["source_signature"]:
            raise ThumbnailError("source changed before thumbnail publication")
        if path.name.endswith(".partial"):
            previous = _load_candidate(path, manifest["source_signature"])
            if previous and all(previous[field] == manifest[field] for field in BASE_IDENTITY_FIELDS):
                old_targets = {sample["requested_ms"] for sample in previous["samples"]}
                new_targets = {sample["requested_ms"] for sample in manifest["samples"]}
                if not old_targets.issubset(new_targets):
                    # An early cancellation or another grid must not discard
                    # sealed coverage. Fresh individual frames remain reusable.
                    return False
        with _base_budget(path, media_path, manifest, size):
            _publish_base(path, manifest, blobs, media_path, cancel=cancel)
        return True


def _publish_base(path, manifest, blobs, media_path, *, cancel=None):
    """Called only while the same-path write lock and quota reservation are held."""
    fd, name = tempfile.mkstemp(prefix=".mothumbs-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output, zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
            for asset, jpeg in blobs.items():
                if cancel is not None and cancel.is_set():
                    raise ThumbnailCancelled("thumbnail publication cancelled")
                archive.writestr("assets/" + asset + ".jpg", jpeg.read_bytes() if isinstance(jpeg, Path) else jpeg)
        if source_signature(Path(media_path)) != manifest["source_signature"]:
            raise ThumbnailError("source changed during thumbnail generation")
        for attempt in range(5):
            try:
                os.replace(name, path)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                if cancel is not None and cancel.is_set():
                    raise ThumbnailCancelled("thumbnail publication cancelled")
                time.sleep(0.05 * (attempt + 1))
    finally:
        Path(name).unlink(missing_ok=True)


def load_or_build_base(media_path: Path | str, *, cancel=None, progress=None, batch_extract=None, before_batch=None, batch_pack=None, target_interval: int | None = None, ffmpeg_path: str | None = None, timeout_s: float = 1200, keyframes: bool = True, exact: bool = True, decode_threads: int = 2, keyframe_extract=None) -> dict:
    """Launcher grid generation with bounded staging and cancellable packing.

    The keyframe stage decodes only keyframes in one fast full-file pass and
    registers the whole grid as preview cells; the exact stage then upgrades
    them batch by batch. At most 64 source JPEGs are retained by the packer.
    Completed sprites are staged on disk, then streamed into an atomic ZIP.
    Every short source batch independently persists first, so cancellation can
    resume without tiling unsealed frames after the cancellation signal.
    """
    video = _info(media_path, cancel=cancel, ffmpeg_path=ffmpeg_path)
    if video is None:
        return {"schema": SCHEMA, "state": "unavailable", "samples": [], "assets": [], "base_complete": False}
    signature, key = source_signature(media_path), identity_key(media_path, video)
    interval = target_interval or base_interval_ms(video.duration_ms)
    if interval not in (250, 500, 1000, 2000, 5000, 10000):
        raise ValueError("invalid base interval")
    count = (video.duration_ms + interval - 1) // interval
    if count > MAX_SAMPLES:
        raise ThumbnailError("base thumbnail grid exceeds manifest budget")
    targets = list(range(0, video.duration_ms, interval))
    existing = load_base(media_path)
    if existing and existing["base_complete"] and existing["target_interval"] <= interval:
        existing_targets = {s["requested_ms"] for s in existing["samples"]}
        if all(target in existing_targets for target in targets):
            return dict(existing, cache_hit=True)
    keyframe_count = 0
    if keyframes:
        if progress:
            progress("[thumbnails] 正在生成关键帧底图……")
        try:
            frames = (keyframe_extract() if keyframe_extract is not None else
                extract_keyframes(media_path, stream_index=video.stream_index, cancel=cancel,
                    ffmpeg_path=ffmpeg_path, info=video, threads=decode_threads,
                    timeout_s=min(600, max(30, timeout_s))))
            if frames:
                # Keyframes are stored at their own PTS: the marker tier keeps
                # true keyframe density, and grid requests hold the nearest
                # preceding one. Identical JPEG bytes dedupe by content hash.
                register_frames(media_path, frames, info=video, ffmpeg_path=ffmpeg_path, expected_source=signature)
                register_keyframe_marks(media_path, [frame.requested_ms for frame in frames], info=video)
                keyframe_count = len(frames)
            if progress:
                progress(f"[thumbnails] 关键帧底图完成：{keyframe_count} 格")
        except (ThumbnailError, OSError) as exc:
            if progress:
                progress(f"[thumbnails] 警告: {exc}；已跳过关键帧底图")
    if not exact:
        return {"schema": SCHEMA, "state": "ready", "tier": "keyframes", "keyframe_count": keyframe_count,
            "samples": [], "assets": [], "base_complete": False, "cache_hit": False, "persisted": True}
    completed, samples, assets, pending = set(), [], [], []
    empty_samples = {}
    failure = None
    deadline = time.monotonic() + timeout_s
    with tempfile.TemporaryDirectory(prefix="maw-base-") as staging:
        blobs = {}
        staged_bytes = 0

        def check():
            if cancel is not None and cancel.is_set():
                raise ThumbnailCancelled("base thumbnail generation cancelled")
            if time.monotonic() >= deadline:
                raise ThumbnailError("base thumbnail generation timed out")
            if source_signature(media_path) != signature:
                raise ThumbnailError("source changed during thumbnail generation")

        def flush():
            nonlocal staged_bytes
            if not pending:
                return
            check()
            if before_batch:
                before_batch([frame.requested_ms for frame in pending])
            check()
            packing = {"cancel": cancel, "timeout_s": min(20, max(.01, deadline-time.monotonic()))}
            images = [frame.jpeg for frame in pending]
            jpeg = batch_pack(images, **packing) if batch_pack else make_sprite(images, ffmpeg_path=ffmpeg_path, **packing)
            check()
            if staged_bytes + len(jpeg) > BASE_GENERATION_BYTES:
                raise ThumbnailError("base thumbnail staging budget exhausted")
            asset = "sprite-" + hashlib.sha256(jpeg).hexdigest()[:24] + "-" + str(len(assets))
            file = Path(staging) / (asset + ".jpg")
            file.write_bytes(jpeg)
            blobs[asset] = file
            staged_bytes += len(jpeg)
            assets.append({"id": asset, "width": 1280, "height": math.ceil(len(pending)/8)*90, "valid_count": len(pending)})
            samples.extend(_sample(frame, asset, [(index % 8)*160, (index//8)*90, 160, 90]) for index, frame in enumerate(pending))
            pending.clear()

        try:
            for batch in batches(targets):
                check()
                if before_batch:
                    before_batch(batch)
                check()
                cached = _with_jpegs(media_path, lookup_frames(media_path, batch, ffmpeg_path=ffmpeg_path), cancel=cancel, ffmpeg_path=ffmpeg_path)
                found = {frame.requested_ms: frame for frame in cached if frame is not None and frame.status == "target" and frame.jpeg}
                empty_samples.update((frame.requested_ms, _sample(frame, None)) for frame in cached if frame is not None and frame.status == "unavailable" and frame.requested_ms < video.video_start_ms)
                missing = [t for t, frame in zip(batch, cached) if frame is None or frame.status == "preview"]
                if missing:
                    if batch_extract:
                        generated = batch_extract(media_path, missing, stream_index=video.stream_index, cancel=cancel)
                    else:
                        generated = extract_frames(media_path, missing, stream_index=video.stream_index, cancel=cancel, ffmpeg_path=ffmpeg_path, info=video, timeout_s=min(45, max(.01, deadline-time.monotonic())))
                    check_source = source_signature(media_path)
                    if check_source != signature:
                        raise ThumbnailError("source changed during thumbnail generation")
                    register_frames(media_path, generated, info=video, ffmpeg_path=ffmpeg_path, expected_source=signature)
                    found.update((frame.requested_ms, frame) for frame in generated if frame.status == "target" and frame.jpeg)
                    empty_samples.update((frame.requested_ms, _sample(frame, None)) for frame in generated if frame.status == "unavailable" and frame.requested_ms < video.video_start_ms)
                for target in batch:
                    if target in empty_samples:
                        completed.add(target)
                    if target in found and target not in completed:
                        pending.append(found[target])
                        completed.add(target)
                        if len(pending) == MAX_SPRITE_FRAMES:
                            flush()
                if progress:
                    progress(f"[thumbnails] {len(completed)}/{len(targets)}")
            flush()
        except (ThumbnailError, OSError) as exc:
            failure = exc
        samples = sorted([*samples, *empty_samples.values()], key=lambda sample: sample["requested_ms"])
        complete = len(samples) == len(targets)
        manifest = _manifest(video, signature, interval=interval, samples=samples, assets=assets, complete=complete)
        manifest["cache_hit"] = False
        manifest["state"] = "cancelled" if isinstance(failure, ThumbnailCancelled) else "error" if failure else "ready" if complete else "partial"
        persisted = False
        paths = [base_path(media_path), cache_root() / "bases" / (_source_key(media_path) + ".mothumbs")]
        # Publication of already sealed blocks performs bounded disk IO only;
        # cancellation never starts another image decoder/tiler here.
        for target in paths:
            path = target if complete else target.with_name(target.name + ".partial")
            try:
                published = _atomic_save(path, manifest, blobs, media_path)
                if published is False:
                    retained = _load_candidate(path, signature)
                    if retained is None:
                        raise OSError("retained thumbnail cache is unavailable")
                    # Return the layout actually on disk. Fresh unsealed sprite
                    # bytes disappear with staging; independent frames remain cached.
                    manifest = dict(retained, cache_hit=False, state=manifest["state"])
                persisted = True
                break
            except (OSError, sqlite3.Error):
                continue
        manifest["persisted"] = persisted
        if not persisted:
            _warning(key)
            with _lock:
                if staged_bytes <= SESSION_QUOTA_BYTES - sum(len(value) for value in _session_assets.values()):
                    _session_bases[_source_key(media_path, signature)] = manifest
                    for asset, file in blobs.items():
                        _session_assets[(key, asset)] = file.read_bytes()
        if failure:
            raise failure
        return manifest
