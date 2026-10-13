"""Bounded thumbnail work and cross-process playback leases.

Only thumbnail decoding is coordinated; ASR and waveform jobs are independent.
The database contains hashed identities and ephemeral control state, never paths.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import secrets
import sqlite3
import tempfile
import threading
import time
from pathlib import Path

from maw.app_paths import default_app_data_root

LEASE_SECONDS = 8.0
FLIGHT_SECONDS = 30.0
INTERVALS = (250, 500, 1000, 2000, 5000, 10000)
MAX_TARGETS = 512


def source_key(path: Path) -> str:
    stat = path.stat()
    return hashlib.sha256(f"{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()


class ThumbnailCoordinator:
    """SQLite transactions arbitrate short batches across Launcher/Server processes."""

    def __init__(self, path: Path | None = None):
        if path is None:
            root = default_app_data_root() / "thumbnail-cache"
            try:
                root.mkdir(parents=True, exist_ok=True)
                path = root / "jobs.sqlite3"
                db = sqlite3.connect(path, timeout=2)
                try:
                    db.execute("PRAGMA user_version=1")
                finally:
                    db.close()
            except (OSError, sqlite3.Error):
                # Stable per-user fallback keeps arbitration shared even on read-only app data.
                user = hashlib.sha256(str(Path.home()).encode()).hexdigest()[:16]
                path = Path(tempfile.gettempdir()) / f"maw-thumbnail-jobs-{user}.sqlite3"
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, source TEXT, playing INTEGER, visible INTEGER, expires REAL)")
            db.execute("CREATE TABLE IF NOT EXISTS flights (id TEXT PRIMARY KEY, source TEXT, owner TEXT, expires REAL)")

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=2)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _expire(db, now):
        db.execute("DELETE FROM leases WHERE expires < ?", (now,))
        db.execute("DELETE FROM flights WHERE expires < ?", (now,))

    def lease(self, lease: str, source: str, *, playing=False, visible=False):
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire(db, time.time())
            if db.execute("SELECT count(*) FROM leases").fetchone()[0] >= 64:
                if not db.execute("SELECT 1 FROM leases WHERE id=?", (lease,)).fetchone():
                    raise RuntimeError("thumbnail lease limit reached")
            db.execute("INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?)", (lease, source, int(playing), int(visible), time.time() + LEASE_SECONDS))

    def release(self, lease):
        with self._db() as db:
            db.execute("DELETE FROM leases WHERE id=?", (lease,))

    def paused(self, source, *, background=False):
        with self._db() as db:
            self._expire(db, time.time())
            condition = "(playing=1 OR visible=1)" if background else "playing=1"
            return bool(db.execute(f"SELECT 1 FROM leases WHERE source=? AND {condition} LIMIT 1", (source,)).fetchone())

    def claim(self, source, keys, owner):
        claimed = []
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire(db, time.time())
            for key in keys[:16]:
                cursor = db.execute("INSERT OR IGNORE INTO flights VALUES(?,?,?,?)", (key, source, owner, time.time() + FLIGHT_SECONDS))
                if cursor.rowcount:
                    claimed.append(key)
        return claimed

    def busy(self, key):
        with self._db() as db:
            self._expire(db, time.time())
            return bool(db.execute("SELECT 1 FROM flights WHERE id=?", (key,)).fetchone())

    def finish(self, owner):
        with self._db() as db:
            db.execute("DELETE FROM flights WHERE owner=?", (owner,))


def coordinated_extract(path, targets, *, stream_index=None, cancel=None, coordinator=None, background=False, ffmpeg_path=None):
    """Publish frames before relinquishing claims; playback stops active FFmpeg too."""
    from maw import thumbnail_cache as cache, thumbnails
    coordinator = coordinator or ThumbnailCoordinator()
    path = Path(path)
    identity = source_key(path)
    owner = secrets.token_hex(16)
    keys = [cache.sample_key(path, value, stream_index=stream_index) for value in targets]
    claimed = coordinator.claim(identity, keys, owner)
    selected = [value for value, key in zip(targets, keys) if key in claimed]
    stop = threading.Event()
    done = threading.Event()

    def watch():
        while not done.wait(.05):
            try:
                obsolete = source_key(path) != identity
                paused = coordinator.paused(identity, background=background)
            except (OSError, sqlite3.Error):
                obsolete, paused = True, False
            if obsolete or paused or (cancel is not None and cancel.is_set()):
                stop.set()
                return

    watcher = threading.Thread(target=watch, name="thumbnail-cancel", daemon=True)
    watcher.start()
    try:
        if selected and not coordinator.paused(identity, background=background):
            try:
                frames = thumbnails.extract_frames(path, selected, stream_index=stream_index, cancel=stop, ffmpeg_path=ffmpeg_path)
            except thumbnails.ThumbnailCancelled:
                if cancel is not None and cancel.is_set():
                    raise
                frames = []
            if source_key(path) != identity:
                return []
            if not stop.is_set():
                cache.register_frames(path, frames)
        # Materialize cached bytes for the base packer, including another process's results.
        if stop.is_set():
            return []
        return [frame for frame in cache.get_or_extract_frames(path, targets, stream_index=stream_index, cancel=stop,
                                           extractor=lambda *_args, **_kwargs: []) if frame is not None]
    finally:
        done.set()
        watcher.join(.2)
        coordinator.finish(owner)


def build_base(path, *, cancel=None, progress=None, ffmpeg_path=None, coordinator=None):
    """Launcher-only full grid, with visible demand ahead of background batches."""
    from maw import thumbnail_cache
    path = Path(path)
    coordinator = coordinator or ThumbnailCoordinator()
    identity = source_key(path)
    deadline = time.monotonic() + 1200

    def before_batch(_targets):
        while coordinator.paused(identity, background=True):
            if time.monotonic() > deadline or (cancel is not None and cancel.is_set()):
                raise TimeoutError("thumbnail base generation interrupted")
            if source_key(path) != identity:
                raise OSError("thumbnail source changed")
            time.sleep(.05)

    def extract(media, targets, **kwargs):
        while True:
            before_batch(targets)
            result = coordinated_extract(media, targets, coordinator=coordinator, background=True,
                                         ffmpeg_path=ffmpeg_path, **kwargs)
            if len(result) == len(targets):
                return result
            if cancel is not None and cancel.is_set():
                raise thumbnail_cache.ThumbnailCancelled("base thumbnail generation cancelled")
            if time.monotonic() > deadline:
                raise TimeoutError("thumbnail base generation timed out")
            # Playback and foreign in-flight work yield, then resume this Launcher task.
            time.sleep(.05)

    return thumbnail_cache.load_or_build_base(path, cancel=cancel, progress=progress,
        before_batch=before_batch, batch_extract=extract, ffmpeg_path=ffmpeg_path)


def plan_targets(ranges, interval, duration, representatives=(), playhead=None):
    """Fixed source-zero grid; bounded union and 15% edge prefetch."""
    if interval not in INTERVALS:
        raise ValueError("invalid thumbnail interval")
    if not isinstance(ranges, list) or len(ranges) > 32:
        raise ValueError("invalid thumbnail ranges")
    priorities = {}
    for value in representatives[:32]:
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < duration:
            priorities[value] = 0
    for item in ranges:
        if not isinstance(item, dict):
            raise ValueError("invalid thumbnail range")
        start, end = item.get("start_ms"), item.get("end_ms")
        if any(not isinstance(v, int) or isinstance(v, bool) for v in (start, end)):
            raise ValueError("thumbnail times must be integer milliseconds")
        start, end = max(0, start), min(duration, end)
        if end <= start:
            continue
        if (end - start) / interval > MAX_TARGETS:
            raise ValueError("thumbnail range too dense")
        low = (start // interval) * interval
        for value in range(low, end, interval):
            priorities[value] = min(priorities.get(value, 1), 1)
        edge = round((end - start) * .15)
        for value in range(max(0, ((start-edge)//interval)*interval), min(duration, end+edge), interval):
            priorities.setdefault(value, 2)
    if len(priorities) > MAX_TARGETS:
        raise ValueError("too many thumbnail targets")
    center = playhead if isinstance(playhead, int) else 0
    return sorted(priorities, key=lambda point: (priorities[point], abs(point-center), point))

class ThumbnailJobManager:
    """One decode worker per editor; leases describe only its current visible demand."""

    def __init__(self, *, coordinator=None):
        self.coordinator = coordinator
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.closed = threading.Event()
        self.active_cancel = threading.Event()
        self.path = None
        self.binding = ""
        self.identity = ""
        self.info = None
        self.state = "idle"
        self.leases = {}
        self.failures = {}
        self.worker = None
        self.active_targets = set()

    def bind(self, path, binding):
        with self.lock:
            self.active_cancel.set()
            if self.coordinator:
                for lease in self.leases:
                    self.coordinator.release(lease)
            self.leases.clear()
            self.failures.clear()
            self.path = Path(path) if path else None
            self.binding = binding
            self.info = None
            self.identity = ""
            self.state = "idle" if path else "unavailable"
            self.wake.set()

    def _start(self):
        if self.worker is None:
            self.worker = threading.Thread(target=self._run, name="thumbnail-visible", daemon=True)
            self.worker.start()

    def _lease(self, lease, client):
        now = time.monotonic()
        for key, item in list(self.leases.items()):
            if item["expires"] < now:
                self._release(key)
        if lease in self.leases:
            return lease
        for key, item in self.leases.items():
            if client and item["client"] == client:
                return key
        if len(self.leases) >= 8:
            raise ValueError("too many thumbnail clients")
        key = secrets.token_hex(16)
        self.leases[key] = {"client": client, "expires": now+LEASE_SECONDS, "view": -1,
            "playing": False, "visible": False, "ranges": [], "representatives": [],
            "interval": 2000, "targets": [], "playhead": 0}
        return key

    def _release(self, lease):
        self.leases.pop(lease, None)
        if self.coordinator:
            self.coordinator.release(lease)

    def release(self, binding, lease):
        with self.lock:
            self._check(binding)
            self._release(lease)
            self.wake.set()

    def _check(self, binding):
        if binding != self.binding:
            raise ValueError("stale thumbnail binding")

    def demand(self, body):
        with self.lock:
            self._check(body.get("binding"))
            view = body.get("view", 0)
            if not isinstance(view, int) or isinstance(view, bool) or not 0 <= view <= 2**53-1:
                raise ValueError("invalid thumbnail view")
            client = body.get("client_id", "")
            if not isinstance(client, str) or len(client) > 128:
                raise ValueError("invalid thumbnail client")
            lease = self._lease(body.get("lease"), client)
            item = self.leases[lease]
            if view >= item["view"]:
                ranges = body.get("ranges", [])
                representatives = body.get("representative_ms", [])
                if not isinstance(representatives, list) or len(representatives) > 32:
                    raise ValueError("invalid representative times")
                interval = body.get("interval_ms", 2000)
                # Validate even while metadata is loading; duration is validated again after probe.
                plan_targets(ranges, interval, self.info.duration_ms if self.info else 2**53-1, representatives)
                item.update(view=view, playing=bool(body.get("playing")), visible=bool(body.get("visible", True)),
                    ranges=ranges, representatives=representatives, interval=interval,
                    playhead=body.get("playhead_ms", 0))
                item["targets"] = self._targets(item)
                wanted = {point for current in self.leases.values() for point in current["targets"]}
                if item["playing"] or (self.active_targets and not self.active_targets.intersection(wanted)):
                    self.active_cancel.set()
            item["expires"] = time.monotonic()+LEASE_SECONDS
            self._publish_lease(lease, item)
            self._start()
            self.wake.set()
            return self._snapshot(lease)

    def status(self, binding, *, lease=None, client="", view=0):
        with self.lock:
            self._check(binding)
            if not isinstance(client, str) or len(client) > 128:
                raise ValueError("invalid thumbnail client")
            lease = self._lease(lease, client)
            item = self.leases[lease]
            item["expires"] = time.monotonic()+LEASE_SECONDS
            self._publish_lease(lease, item)
            self._start()
            return self._snapshot(lease)

    def _targets(self, item):
        if not self.info or not item["visible"]:
            return []
        return plan_targets(item["ranges"], item["interval"], self.info.duration_ms,
                            item["representatives"], item["playhead"])

    def _publish_lease(self, lease, item, *, missing=None):
        if self.coordinator and self.identity:
            self.coordinator.lease(lease, self.identity, playing=item["playing"],
                visible=bool(item["visible"] and (missing if missing is not None else item["targets"])))

    def _snapshot(self, lease):
        from maw import thumbnail_cache
        item = self.leases[lease]
        result = {"binding": self.binding, "lease": lease, "view": item["view"], "state": self.state,
                  "source_identity": self.identity, "duration_ms": self.info.duration_ms if self.info else 0,
                  "samples": [], "assets": [], "cache_revision": "", "image_spec": {"width": 160,"height": 90}}
        if self.path and self.info:
            result.update(thumbnail_cache.sample_manifest(self.path, item["targets"], stream_index=self.info.stream_index))
        result.update(binding=self.binding, lease=lease, view=item["view"], state="paused" if item["playing"] else self.state)
        result["asset_url_template"] = "/api/thumbnails/asset/{asset}?binding={binding}&revision={cache_revision}"
        return result

    def read_asset(self, binding, asset, revision):
        from maw import thumbnail_cache
        with self.lock:
            self._check(binding)
            if not self.path or not self.info:
                return None
            if source_key(self.path) != self.identity:
                raise ValueError("thumbnail source changed")
            current = thumbnail_cache.sample_manifest(self.path, [], stream_index=self.info.stream_index)
            if revision != current.get("cache_revision"):
                raise ValueError("stale thumbnail revision")
            return thumbnail_cache.read_asset(self.path, asset, cache_revision=revision)

    def _run(self):
        from maw import thumbnails, thumbnail_cache
        while not self.closed.is_set():
            self.wake.wait(.2)
            self.wake.clear()
            try:
                self._step(thumbnails, thumbnail_cache)
            except Exception:
                with self.lock:
                    # Failure affects only this optional visual cache.
                    self.state = "error"
                self.closed.wait(.2)

    def _step(self, thumbnails, cache):
        with self.lock:
            path, binding = self.path, self.binding
            if not path or self.state in ("unavailable", "error"):
                return
            identity = source_key(path)
            if self.identity and identity != self.identity:
                self.active_cancel.set()
                self.info = None
                self.failures.clear()
            self.identity = identity
            if self.coordinator is None:
                self.coordinator = ThumbnailCoordinator()
            self.active_cancel = threading.Event()
            cancel = self.active_cancel
            needs_probe = self.info is None
        if needs_probe:
            info = thumbnails.probe_video(path, cancel=cancel)
            with self.lock:
                if self.binding != binding or source_key(path) != identity:
                    return
                self.info = info
                self.state = "queued" if info else "unavailable"
                if not info:
                    return
                for item in self.leases.values():
                    item["targets"] = self._targets(item)
        with self.lock:
            if binding != self.binding:
                return
            now = time.monotonic()
            for lease, item in list(self.leases.items()):
                if item["expires"] < now:
                    self._release(lease)
            targets = list(dict.fromkeys(point for item in self.leases.values() for point in item["targets"]))
            hits = cache.lookup_frames(path, targets, stream_index=self.info.stream_index)
            missing = [point for point, hit in zip(targets, hits) if hit is None and self.failures.get(point, 0) < 2]
            for lease, item in self.leases.items():
                self._publish_lease(lease, item, missing=any(point in missing for point in item["targets"]))
            if self.coordinator.paused(identity):
                self.state = "paused"
                return
            if not missing:
                self.state = "ready" if targets else "idle"
                return
            first = missing[0]
            batch = [point for point in missing if abs(point-first) <= 8000][:16]
            stream_index = self.info.stream_index
            self.active_targets = set(batch)
            self.state = "generating"
        # A view update preserves useful work; playback/binding changes actively set this event.
        frames = coordinated_extract(path, batch, stream_index=stream_index,
            cancel=cancel, coordinator=self.coordinator)
        with self.lock:
            if binding != self.binding or source_key(path) != identity:
                return
            if not cancel.is_set():
                ready = {frame.requested_ms for frame in frames if frame.status == "target"}
                for point in batch:
                    if point not in ready and not self.coordinator.busy(cache.sample_key(path, point, stream_index=stream_index)):
                        self.failures[point] = self.failures.get(point, 0)+1
            self.active_targets.clear()
            self.wake.set()

    def close(self):
        self.closed.set()
        self.active_cancel.set()
        self.wake.set()
        with self.lock:
            for lease in list(self.leases):
                self._release(lease)
        if self.worker and self.worker is not threading.current_thread():
            self.worker.join(6)
