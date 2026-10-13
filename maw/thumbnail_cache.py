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
from pathlib import Path
from typing import Sequence

from maw.app_paths import default_app_data_root
from maw.output_naming import waveform_dirs
from maw.thumbnails import IMAGE_SPEC, FrameResult, ThumbnailCancelled, ThumbnailError, VideoInfo, base_interval_ms, batches, extract_frames, make_sprite, probe_video
from maw.waveform import media_signature

SCHEMA = "moy.asr.thumbnails.v1"
GENERATOR_VERSION = 1
MAX_SPRITE_FRAMES = 64
MEDIA_QUOTA_BYTES = 64 * 1024 * 1024
GLOBAL_QUOTA_BYTES = 512 * 1024 * 1024
SESSION_QUOTA_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_ASSET_BYTES = 2 * 1024 * 1024
MAX_SIDECAR_BYTES = 512 * 1024 * 1024
MAX_SAMPLES = 250_000
_lock = threading.RLock()
_video_memo: dict[str, VideoInfo | None] = {}
_base_memo: OrderedDict[tuple, dict] = OrderedDict()
_session: OrderedDict[tuple[str, int], FrameResult] = OrderedDict()
_session_assets: dict[tuple[str, str], bytes] = {}
_write_disabled: set[str] = set()
_session_bases: dict[str, dict] = {}
_session_pins: dict[tuple[str, str], float] = {}


def cache_root() -> Path:
    return default_app_data_root() / "thumbnail-cache"


def base_path(media_path: Path | str) -> Path:
    media = Path(media_path)
    return waveform_dirs(media)[0] / (media.name + ".mothumbs")


def base_candidates(media_path: Path | str) -> list[Path]:
    media = Path(media_path)
    return [directory / (media.name + ".mothumbs") for directory in waveform_dirs(media)]


def _source_key(media_path: Path | str) -> str:
    media = Path(media_path).resolve()
    return hashlib.sha256(json.dumps([os.path.normcase(str(media)), media_signature(media)], sort_keys=True).encode()).hexdigest()


def _info(media_path: Path | str, *, cancel=None) -> VideoInfo | None:
    key = _source_key(media_path)
    with _lock:
        if key in _video_memo:
            return _video_memo[key]
    cached = load_base(media_path)
    video = VideoInfo(cached["video_stream_index"], cached["duration_ms"], cached["source_start_ms"]) if cached else probe_video(media_path, cancel=cancel)
    with _lock:
        if len(_video_memo) > 128:
            _video_memo.clear()
        _video_memo[key] = video
    return video


def identity_key(media_path: Path | str, info: VideoInfo | None = None) -> str:
    video = info or _info(media_path)
    if video is None:
        raise ThumbnailError("media contains no video")
    return hashlib.sha256(json.dumps([_source_key(media_path), video.stream_index, IMAGE_SPEC, GENERATOR_VERSION], sort_keys=True).encode()).hexdigest()


def sample_key(media_path: Path | str, requested_ms: int, stream_index: int | None = None) -> str:
    video = _info(media_path)
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
    db.execute("PRAGMA busy_timeout=5000")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS assets(media TEXT, asset TEXT, jpeg BLOB NOT NULL, size INTEGER NOT NULL, used REAL NOT NULL, PRIMARY KEY(media,asset));
        CREATE TABLE IF NOT EXISTS samples(media TEXT, requested INTEGER, actual INTEGER, status TEXT NOT NULL, asset TEXT, PRIMARY KEY(media,requested));
        CREATE TABLE IF NOT EXISTS pins(media TEXT, asset TEXT, expires REAL NOT NULL, PRIMARY KEY(media,asset));
        CREATE INDEX IF NOT EXISTS asset_lru ON assets(used);
    """)
    return db


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
        _session[(key, frame.requested_ms)] = frame
        _session.move_to_end((key, frame.requested_ms))
        if frame.jpeg:
            _session_assets[(key, _asset_id(frame.jpeg))] = frame.jpeg
        total = sum(len(value) for value in _session_assets.values())
        now = time.time()
        for asset_key in list(_session_assets):
            if total <= SESSION_QUOTA_BYTES:
                break
            if _session_pins.get(asset_key, 0) > now:
                continue
            total -= len(_session_assets.pop(asset_key))
            for sample in list(_session):
                result = _session[sample]
                if sample[0] == asset_key[0] and result.jpeg and _asset_id(result.jpeg) == asset_key[1]:
                    del _session[sample]
        while len(_session) > 8192:
            _session.popitem(last=False)


def protect_assets(media_path: Path | str, asset_ids: Sequence[str], *, lease_seconds: float = 30) -> None:
    key = identity_key(media_path)
    expires = time.time() + min(120, max(1, lease_seconds))
    with _lock:
        for asset in asset_ids:
            _session_pins[(key, asset)] = expires
    try:
        with contextlib.closing(_connect()) as db, db:
            db.executemany("INSERT OR REPLACE INTO pins VALUES(?,?,?)", [(key, asset, expires) for asset in asset_ids])
    except (OSError, sqlite3.Error):
        _warning(key)


def release_assets(media_path: Path | str, asset_ids: Sequence[str]) -> None:
    key = identity_key(media_path)
    with _lock:
        for asset in asset_ids:
            _session_pins.pop((key, asset), None)
    try:
        with contextlib.closing(_connect()) as db, db:
            db.executemany("DELETE FROM pins WHERE media=? AND asset=?", [(key, asset) for asset in asset_ids])
    except (OSError, sqlite3.Error):
        pass


def _evict(db, media: str, incoming: int, protected: set[str]) -> bool:
    db.execute("DELETE FROM pins WHERE expires<=?", (time.time(),))
    media_size = db.execute("SELECT COALESCE(SUM(size),0) FROM assets WHERE media=?", (media,)).fetchone()[0]
    global_size = db.execute("SELECT COALESCE(SUM(size),0) FROM assets").fetchone()[0]
    rows = db.execute("SELECT a.media,a.asset,a.size FROM assets a LEFT JOIN pins p ON a.media=p.media AND a.asset=p.asset WHERE p.asset IS NULL ORDER BY a.used").fetchall()
    for owner, asset, size in rows:
        if media_size + incoming <= MEDIA_QUOTA_BYTES and global_size + incoming <= GLOBAL_QUOTA_BYTES:
            return True
        if owner == media and asset in protected:
            continue
        if media_size + incoming > MEDIA_QUOTA_BYTES and owner != media:
            continue
        db.execute("DELETE FROM samples WHERE media=? AND asset=?", (owner, asset))
        db.execute("DELETE FROM assets WHERE media=? AND asset=?", (owner, asset))
        global_size -= size
        if owner == media:
            media_size -= size
    return media_size + incoming <= MEDIA_QUOTA_BYTES and global_size + incoming <= GLOBAL_QUOTA_BYTES


def register_frames(media_path: Path | str, frames: Sequence[FrameResult], *, info: VideoInfo | None = None) -> list[dict]:
    video = info or _info(media_path)
    _validate_targets([f.requested_ms for f in frames], video)
    if video is None:
        return []
    key = identity_key(media_path, video)
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


def lookup_frames(media_path: Path | str, requested_ms: Sequence[int], *, stream_index: int | None = None) -> list[FrameResult | None]:
    """Metadata-only cache query: sprite hits never launch FFmpeg."""
    video = _info(media_path)
    _validate_targets(requested_ms, video, stream_index)
    if video is None:
        return [FrameResult(t, None, "unavailable", None) for t in requested_ms]
    key = identity_key(media_path, video)
    with _lock:
        found = {t: _session[(key, t)] for t in requested_ms if (key, t) in _session}
    found.update(_persistent_frames(key, [t for t in set(requested_ms) if t not in found]))
    base = load_base(media_path)
    if base:
        for sample in base["samples"]:
            target = sample["requested_ms"]
            if target in requested_ms and target not in found:
                found[target] = FrameResult(target, sample["actual_pts_ms"], "target", None)
    return [found.get(t) for t in requested_ms]


def _crop_sprite(jpeg: bytes, samples: Sequence[dict], *, cancel=None) -> dict[int, FrameResult]:
    """Unpack all requested crops in one image-only FFmpeg task."""
    from maw.ffmpeg import resolve_ffmpeg_tool
    from maw.thumbnails import _run
    tool = resolve_ffmpeg_tool("ffmpeg")
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


def _with_jpegs(media_path, frames, *, cancel=None):
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
            found.update(_crop_sprite(jpeg, samples, cancel=cancel))
    return [found.get(frame.requested_ms, frame) if frame else None for frame in frames]


def get_or_extract_frames(media_path: Path | str, requested_ms: Sequence[int], *, stream_index: int | None = None, cancel=None, extractor=None) -> list[FrameResult]:
    cached = _with_jpegs(media_path, lookup_frames(media_path, requested_ms, stream_index=stream_index), cancel=cancel)
    missing = sorted({t for t, value in zip(requested_ms, cached) if value is None or value.status == "preview"})
    if missing:
        video = _info(media_path, cancel=cancel)
        expected = _source_key(media_path)
        generated = (extractor or extract_frames)(media_path, missing, stream_index=video.stream_index, cancel=cancel)
        if _source_key(media_path) != expected:
            raise ThumbnailError("source changed during thumbnail extraction")
        register_frames(media_path, generated, info=video)
        by_target = {frame.requested_ms: frame for frame in generated}
        return [by_target.get(t, value) for t, value in zip(requested_ms, cached)]
    return cached


def get_or_extract_frame(media_path: Path | str, requested_ms: int, *, stream_index: int | None = None, cancel=None) -> FrameResult:
    return get_or_extract_frames(media_path, [requested_ms], stream_index=stream_index, cancel=cancel)[0]


def _manifest(video: VideoInfo, signature: dict, *, interval: int, samples=None, assets=None, complete=False, revision=None) -> dict:
    samples = samples or []
    return {"schema": SCHEMA, "generator_version": GENERATOR_VERSION, "cache_revision": revision or uuid.uuid4().hex, "source_signature": signature, "video_stream_index": video.stream_index, "duration_ms": video.duration_ms, "source_start_ms": video.start_ms, "time_origin": "source-start-ms", "image_spec": dict(IMAGE_SPEC), "sampling_interval": interval, "target_interval": interval, "base_complete": complete, "valid_count": sum(s["status"] == "target" for s in samples), "coverage": [[0, video.duration_ms]] if complete else [[s["requested_ms"], min(video.duration_ms, s["requested_ms"] + interval)] for s in samples if s["status"] == "target"], "samples": samples, "assets": assets or [], "state": "ready" if complete else "partial", "persisted": True}


def _valid_manifest(value, signature, entries) -> bool:
    if not isinstance(value, dict) or value.get("schema") != SCHEMA or value.get("generator_version") != GENERATOR_VERSION or value.get("source_signature") != signature or value.get("image_spec") != IMAGE_SPEC:
        return False
    duration, interval = value.get("duration_ms"), value.get("target_interval")
    samples, assets = value.get("samples"), value.get("assets")
    if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0 or interval not in (250, 500, 1000, 2000, 5000, 10000) or not isinstance(samples, list) or len(samples) > MAX_SAMPLES or not isinstance(assets, list):
        return False
    if not isinstance(value.get("video_stream_index"), int) or value["video_stream_index"] < 0 or not isinstance(value.get("source_start_ms"), int) or not isinstance(value.get("cache_revision"), str) or len(value["cache_revision"]) != 32:
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
        if not isinstance(target, int) or isinstance(target, bool) or not 0 <= target < duration or target in seen or sample.get("status") != "target" or not isinstance(actual, int) or not 0 <= actual < duration or not isinstance(asset, str) or asset not in asset_map:
            return False
        if not isinstance(crop, list) or len(crop) != 4 or any(not isinstance(x, int) or isinstance(x, bool) for x in crop) or crop[2:] != [160, 90] or crop[0] < 0 or crop[1] < 0 or crop[0] + 160 > 1280 or crop[1] + 90 > asset_map[asset]["height"]:
            return False
        seen.add(target)
        counts[asset] += 1
    if len(seen) != value.get("valid_count") or any(counts[asset] != row["valid_count"] for asset, row in asset_map.items()):
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
            while len(_base_memo) > 16:
                _base_memo.popitem(last=False)
        return value
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, RuntimeError):
        return None


def _all_base_hits(media_path: Path | str) -> list[tuple[Path | None, dict]]:
    try:
        signature, key = media_signature(Path(media_path)), _source_key(media_path)
    except OSError:
        return []
    hits = []
    for path in [*base_candidates(media_path), cache_root() / "bases" / (key + ".mothumbs")]:
        for candidate in (path, path.with_name(path.name + ".partial")):
            value = _load_candidate(candidate, signature)
            if value:
                hits.append((candidate, value))
    with _lock:
        if key in _session_bases:
            hits.append((None, _session_bases[key]))
    return hits


def load_base(media_path: Path | str) -> dict | None:
    hits = _all_base_hits(media_path)
    if not hits:
        return None
    return max((value for _, value in hits), key=lambda v: (v["base_complete"], -v["target_interval"], v["valid_count"]))


def read_asset(media_path: Path | str, asset_id: str, *, cache_revision: str | None = None) -> bytes | None:
    if not isinstance(asset_id, str) or len(asset_id) > 100:
        return None
    try:
        key = identity_key(media_path)
    except (OSError, ThumbnailError):
        return None
    if asset_id.startswith("sprite-"):
        for path, value in _all_base_hits(media_path):
            if cache_revision and value["cache_revision"] != cache_revision:
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
    result = _manifest(video, media_signature(Path(media_path)), interval=base_interval_ms(video.duration_ms), revision=key[:32])
    result.update(base or {})
    result["samples"], result["assets"] = [], []
    base_map = {s["requested_ms"]: s for s in base["samples"]} if base else {}
    persistent = _persistent_frames(key, list(requested_ms))
    with _lock:
        local = {target: frame for (owner, target), frame in _session.items() if owner == key}
    local.update(persistent)
    assets = {a["id"]: a for a in base["assets"]} if base else {}
    for target in requested_ms:
        if target in base_map:
            sample = dict(base_map[target])
        elif target in local:
            frame = local[target]
            sample = _sample(frame, _asset_id(frame.jpeg) if frame.jpeg else None)
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


def _atomic_save(path: Path, manifest: dict, blobs: dict[str, bytes], media_path: Path | str, *, cancel=None) -> None:
    with _write_lock(path.with_name(path.name + ".lock"), cancel=cancel):
        fd, name = tempfile.mkstemp(prefix=".mothumbs-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as output, zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
                for asset, jpeg in blobs.items():
                    archive.writestr("assets/" + asset + ".jpg", jpeg)
            if media_signature(Path(media_path)) != manifest["source_signature"]:
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


def _pack(media_path: Path | str, video: VideoInfo, signature: dict, frames: Sequence[FrameResult], interval: int, *, complete: bool, cancel=None) -> tuple[dict, dict[str, bytes]]:
    samples, assets, blobs = [], [], {}
    valid = sorted((frame for frame in frames if frame.status == "target" and frame.jpeg), key=lambda frame: frame.requested_ms)
    for start in range(0, len(valid), MAX_SPRITE_FRAMES):
        block = valid[start:start+MAX_SPRITE_FRAMES]
        jpeg = make_sprite([frame.jpeg for frame in block], cancel=cancel)
        asset = "sprite-" + hashlib.sha256(jpeg).hexdigest()[:24] + "-" + str(start // MAX_SPRITE_FRAMES)
        blobs[asset] = jpeg
        assets.append({"id": asset, "width": 1280, "height": math.ceil(len(block)/8)*90, "valid_count": len(block)})
        samples.extend(_sample(frame, asset, [(index % 8)*160, (index//8)*90, 160, 90]) for index, frame in enumerate(block))
    return _manifest(video, signature, interval=interval, samples=samples, assets=assets, complete=complete), blobs


def load_or_build_base(media_path: Path | str, *, cancel=None, progress=None, batch_extract=None, before_batch=None, target_interval: int | None = None, ffmpeg_path: str | None = None, timeout_s: float = 1200) -> dict:
    """Launcher-only full coverage with resumable independent batch storage.

    batch_extract is the shared flight coordinator callback. before_batch waits
    for playback/visible leases outside all cache write locks.
    """
    video = _info(media_path, cancel=cancel)
    if video is None:
        return {"schema": SCHEMA, "state": "unavailable", "samples": [], "assets": [], "base_complete": False}
    signature, key = media_signature(Path(media_path)), identity_key(media_path, video)
    interval = target_interval or base_interval_ms(video.duration_ms)
    if interval not in (250, 500, 1000, 2000, 5000, 10000):
        raise ValueError("invalid base interval")
    existing = load_base(media_path)
    targets = list(range(0, video.duration_ms, interval))
    if len(targets) > MAX_SAMPLES:
        raise ThumbnailError("base thumbnail grid exceeds manifest budget")
    if existing and existing["base_complete"] and existing["target_interval"] <= interval:
        existing_targets = {s["requested_ms"] for s in existing["samples"]}
        if all(target in existing_targets for target in targets):
            return existing
    completed: dict[int, FrameResult] = {}
    failure = None
    deadline = time.monotonic() + timeout_s
    try:
        for batch in batches(targets):
            if cancel is not None and cancel.is_set():
                raise ThumbnailCancelled("base thumbnail generation cancelled")
            if time.monotonic() >= deadline:
                raise ThumbnailError("base thumbnail generation timed out")
            if before_batch:
                before_batch(batch)
            cached = _with_jpegs(media_path, lookup_frames(media_path, batch), cancel=cancel)
            completed.update((frame.requested_ms, frame) for frame in cached if frame is not None and frame.status == "target" and frame.jpeg)
            missing = [t for t, frame in zip(batch, cached) if frame is None or frame.status == "preview"]
            if missing:
                if batch_extract:
                    generated = batch_extract(media_path, missing, stream_index=video.stream_index, cancel=cancel)
                else:
                    generated = extract_frames(media_path, missing, stream_index=video.stream_index, cancel=cancel, ffmpeg_path=ffmpeg_path, info=video, timeout_s=min(45, max(0.01, deadline-time.monotonic())))
                if media_signature(Path(media_path)) != signature:
                    raise ThumbnailError("source changed during thumbnail generation")
                register_frames(media_path, generated, info=video)
                completed.update((frame.requested_ms, frame) for frame in generated if frame.status == "target")
            if progress:
                progress(f"[thumbnails] {len(completed)}/{len(targets)}")
    except (ThumbnailError, OSError) as exc:
        failure = exc
    complete = len(completed) == len(targets)
    # Already completed frame records persist after every short batch. Packing
    # cancelled work is bounded separately and does not resume source decoding.
    manifest, blobs = _pack(media_path, video, signature, list(completed.values()), interval, complete=complete)
    manifest["state"] = "cancelled" if isinstance(failure, ThumbnailCancelled) else "error" if failure else "ready" if complete else "partial"
    persisted = False
    paths = [base_path(media_path), cache_root() / "bases" / (_source_key(media_path) + ".mothumbs")]
    for target in paths:
        path = target if complete else target.with_name(target.name + ".partial")
        try:
            _atomic_save(path, manifest, blobs, media_path)
            persisted = True
            break
        except OSError:
            continue
    manifest["persisted"] = persisted
    if not persisted:
        _warning(key)
        with _lock:
            _session_bases[_source_key(media_path)] = manifest
            for asset, jpeg in blobs.items():
                _session_assets[(key, asset)] = jpeg
    if failure:
        raise failure
    return manifest
