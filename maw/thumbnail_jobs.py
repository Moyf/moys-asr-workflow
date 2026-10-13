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
                if db.execute("SELECT count(*) FROM flights").fetchone()[0] >= 512:
                    break
                cursor = db.execute("INSERT OR IGNORE INTO flights VALUES(?,?,?,?)", (key, source, owner, time.time() + FLIGHT_SECONDS))
                if cursor.rowcount:
                    claimed.append(key)
        return claimed

    def renew(self, owner):
        with self._db() as db:
            db.execute("UPDATE flights SET expires=? WHERE owner=?", (time.time()+FLIGHT_SECONDS, owner))

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
    signature = cache.source_signature(path)
    owner = secrets.token_hex(16)
    targets = list(dict.fromkeys(targets))
    hits = cache.lookup_frames(path, targets, stream_index=stream_index, ffmpeg_path=ffmpeg_path)
    missing = [value for value, hit in zip(targets, hits) if hit is None or hit.status == "preview"]
    keys = [cache.sample_key(path, value, stream_index=stream_index, ffmpeg_path=ffmpeg_path) for value in missing]
    claimed = coordinator.claim(identity, keys, owner)
    selected = [value for value, key in zip(missing, keys) if key in claimed]
    fresh = {}
    stop = threading.Event()
    done = threading.Event()

    def watch():
        renewal = time.monotonic()+min(1, max(.05, FLIGHT_SECONDS/3))
        while not done.wait(.05):
            try:
                if time.monotonic() >= renewal:
                    coordinator.renew(owner)
                    renewal = time.monotonic()+min(1, max(.05, FLIGHT_SECONDS/3))
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
        if selected and not (cancel is not None and cancel.is_set()) and not coordinator.paused(identity, background=background):
            try:
                frames = thumbnails.extract_frames(path, selected, stream_index=stream_index, cancel=stop, ffmpeg_path=ffmpeg_path)
            except thumbnails.ThumbnailCancelled:
                if cancel is not None and cancel.is_set():
                    raise
                frames = []
            if source_key(path) != identity:
                return []
            if not stop.is_set():
                cache.register_frames(path, frames, ffmpeg_path=ffmpeg_path, expected_source=signature)
                fresh = {frame.requested_ms: frame for frame in frames}
        if not background:
            return [frame for frame in cache.lookup_frames(path, targets, stream_index=stream_index, ffmpeg_path=ffmpeg_path) if frame is not None]
        # Materialize cached bytes only for the Launcher base packer.
        if stop.is_set():
            return []
        cached_targets = [target for target in targets if target not in fresh]
        reused = cache.get_or_extract_frames(path, cached_targets, stream_index=stream_index, cancel=stop,
            extractor=lambda *_args, **_kwargs: [], ffmpeg_path=ffmpeg_path) if cached_targets else []
        found = {frame.requested_ms: frame for frame in reused if frame is not None}
        found.update(fresh)
        # A disk/session quota refusal cannot discard this batch's bytes and make
        # the Launcher decode them again while waiting for cache admission.
        return [found[target] for target in targets if target in found]
    finally:
        done.set()
        watcher.join(.2)
        coordinator.finish(owner)



def coordinated_pack(path, jpegs, *, coordinator, before_batch, cancel=None, timeout_s=20, ffmpeg_path=None):
    """Playback also suspends sprite image decoding, without ending the base task."""
    from maw import thumbnails
    identity = source_key(Path(path))
    while True:
        before_batch([])
        stop, done = threading.Event(), threading.Event()

        def watch():
            while not done.wait(.05):
                try:
                    changed = source_key(Path(path)) != identity
                    paused = coordinator.paused(identity, background=True)
                except (OSError, sqlite3.Error):
                    changed, paused = True, False
                if changed or paused or (cancel is not None and cancel.is_set()):
                    stop.set()
                    return

        watcher = threading.Thread(target=watch, name="thumbnail-pack-cancel", daemon=True)
        watcher.start()
        try:
            jpeg = thumbnails.make_sprite(jpegs, cancel=stop, timeout_s=timeout_s, ffmpeg_path=ffmpeg_path)
            if source_key(Path(path)) != identity:
                raise thumbnails.ThumbnailError("thumbnail source changed during packing")
            if cancel is not None and cancel.is_set():
                raise thumbnails.ThumbnailCancelled("base thumbnail generation cancelled")
            if not stop.is_set():
                return jpeg
        except thumbnails.ThumbnailCancelled:
            if cancel is not None and cancel.is_set():
                raise
            if source_key(Path(path)) != identity:
                raise thumbnails.ThumbnailError("thumbnail source changed during packing")
        finally:
            done.set()
            watcher.join(.2)
        # The next iteration waits for the lease, then retries this unsealed block.


def build_base(path, *, cancel=None, progress=None, ffmpeg_path=None, coordinator=None, timeout_s=1200):
    """Launcher-only full grid, with visible demand ahead of background batches."""
    from maw import thumbnail_cache
    path = Path(path)
    coordinator = coordinator or ThumbnailCoordinator()
    identity = source_key(path)
    deadline = time.monotonic() + timeout_s

    def before_batch(_targets):
        yielded = False
        while coordinator.paused(identity, background=True):
            if not yielded and progress is not None:
                progress("[thumbnails] 同源播放或可见画面需求优先，基础画面生成已暂停")
            yielded = True
            if time.monotonic() > deadline or (cancel is not None and cancel.is_set()):
                if cancel is not None and cancel.is_set():
                    raise thumbnail_cache.ThumbnailCancelled("base thumbnail generation cancelled")
                raise TimeoutError("thumbnail base generation timed out")
            if source_key(path) != identity:
                raise OSError("thumbnail source changed")
            time.sleep(.05)
        if yielded and progress is not None:
            progress("[thumbnails] 同源优先需求已释放，继续生成基础画面")

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

    def pack(jpegs, **kwargs):
        return coordinated_pack(path, jpegs, coordinator=coordinator, before_batch=before_batch,
                                ffmpeg_path=ffmpeg_path, **kwargs)

    return thumbnail_cache.load_or_build_base(path, cancel=cancel, progress=progress,
        before_batch=before_batch, batch_extract=extract, batch_pack=pack,
        ffmpeg_path=ffmpeg_path, timeout_s=timeout_s)


def plan_targets(ranges, interval, duration, representatives=(), playhead=None):
    """Fixed source-zero grid; bounded union and 15% edge prefetch."""
    if type(interval) is not int or interval not in INTERVALS:
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
    """One lazy worker per editor, with bounded and replaceable visible demand."""

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
        self.error = ""
        self.leases = {}
        self.released_clients = {}
        self.failures = {}
        self.worker = None
        self.active_targets = set()
        self.manager_id = secrets.token_hex(16)
        self.decode_active = False

    def bind(self, path, binding):
        with self.lock:
            self.active_cancel.set()
            for lease in list(self.leases):
                self._release(lease)
            self.failures.clear()
            self.released_clients.clear()
            self.path = Path(path) if path else None
            self.binding = binding
            self.info = None
            self.identity = ""
            self.error = ""
            self.active_targets.clear()
            self.state = "idle" if path else "unavailable"
            self.wake.set()

    def _start(self):
        if self.closed.is_set():
            raise ValueError("thumbnail manager closed")
        if self.worker is None:
            self.worker = threading.Thread(target=self._run, name="thumbnail-visible", daemon=True)
            self.worker.start()

    @staticmethod
    def _validate_client(lease, client):
        if lease is not None and (not isinstance(lease, str) or len(lease) > 128):
            raise ValueError("invalid thumbnail lease")
        if not isinstance(client, str) or len(client) > 128:
            raise ValueError("invalid thumbnail client")

    def _lease(self, lease, client, *, view=0):
        self._validate_client(lease, client)
        now = time.monotonic()
        self.released_clients = {key: item for key, item in self.released_clients.items() if item[1] > now}
        if client in self.released_clients and view <= self.released_clients[client][0]:
            raise ValueError("stale released thumbnail view")
        for key, item in list(self.leases.items()):
            if item["expires"] < now:
                self._release(key)
        if lease in self.leases:
            if client and self.leases[lease]["client"] != client:
                raise ValueError("thumbnail lease client mismatch")
            return lease
        for key, item in self.leases.items():
            if client and item["client"] == client:
                return key
        if len(self.leases) >= 8:
            raise ValueError("too many thumbnail clients")
        key = secrets.token_hex(16)
        self.leases[key] = {"client": client, "expires": now+LEASE_SECONDS, "view": -1,
            "playing": False, "visible": False, "ranges": [], "representatives": [],
            "interval": 2000, "targets": [], "playhead": 0, "assets": set(), "pending": False}
        return key

    def _pins(self, lease, assets):
        from maw import thumbnail_cache
        item = self.leases[lease]
        owner = f"{self.manager_id}:{lease}"
        if not assets:
            thumbnail_cache.release_owner(owner)
            item["assets"] = set()
            return
        if not self.path or not self.info:
            return
        try:
            unchanged = source_key(self.path) == self.identity
        except OSError:
            unchanged = False
        if not unchanged:
            # Old-identity protection expires in eight seconds; do not probe a replacement
            # while handling release or shutdown, especially a missing/corrupt new file.
            thumbnail_cache.release_owner(owner)
            item["assets"] = set()
            return
        removed = item["assets"]-assets
        if removed:
            thumbnail_cache.release_assets(self.path, list(removed), owner=owner)
        if assets:
            thumbnail_cache.protect_assets(self.path, list(assets), owner=owner, lease_seconds=LEASE_SECONDS)
        item["assets"] = assets

    def _release(self, lease):
        item = self.leases.get(lease)
        if item:
            self._pins(lease, set())
            self.leases.pop(lease, None)
        if self.coordinator:
            self.coordinator.release(lease)
        wanted = {point for current in self.leases.values() for point in current["targets"]}
        if self.active_targets and not self.active_targets.intersection(wanted):
            self.active_cancel.set()

    def release(self, binding, lease, *, client="", view=None):
        with self.lock:
            self._check(binding)
            self._validate_client(lease, client)
            if lease in self.leases and client and self.leases[lease]["client"] != client:
                raise ValueError("thumbnail lease client mismatch")
            if view is not None and (type(view) is not int or not 0 <= view <= 2**53-1):
                raise ValueError("invalid thumbnail release view")
            keys = [lease] if lease in self.leases else [key for key, item in self.leases.items() if client and item["client"] == client]
            marker = view if view is not None else -1
            for key in keys:
                marker = max(marker, self.leases[key]["view"])
                self._release(key)
            if client:
                marker = max(marker, self.released_clients.get(client, (-1, 0))[0])
                self.released_clients[client] = (marker, time.monotonic()+LEASE_SECONDS)
                if len(self.released_clients) > 64:
                    self.released_clients.pop(next(iter(self.released_clients)))
            self.wake.set()

    def _check(self, binding):
        if binding != self.binding:
            raise ValueError("stale thumbnail binding")

    def _refresh_source(self):
        if not self.path:
            return
        identity = source_key(self.path)
        if self.identity and self.identity != identity:
            self.active_cancel.set()
            for lease in self.leases:
                self._pins(lease, set())
                if self.coordinator:
                    self.coordinator.release(lease)
            self.info = None
            self.failures.clear()
            self.error = ""
            self.state = "queued"
        self.identity = identity

    def demand(self, body):
        with self.lock:
            self._check(body.get("binding"))
            view = body.get("view", 0)
            if type(view) is not int or not 0 <= view <= 2**53-1:
                raise ValueError("invalid thumbnail view")
            client = body.get("client_id", "")
            self._validate_client(body.get("lease"), client)
            ranges = body.get("ranges", [])
            representatives = body.get("representative_ms", [])
            interval = body.get("interval_ms", 2000)
            if not isinstance(representatives, list) or len(representatives) > 32:
                raise ValueError("invalid representative times")
            if any(type(value) is not int or not 0 <= value <= 2**53-1 for value in representatives):
                raise ValueError("invalid representative times")
            if any(type(body.get(field, default)) is not bool for field, default in (("playing", False), ("visible", True))):
                raise ValueError("thumbnail controls must be booleans")
            playhead = body.get("playhead_ms", 0)
            if type(playhead) is not int or not 0 <= playhead <= 2**53-1:
                raise ValueError("invalid thumbnail playhead")
            plan_targets(ranges, interval, self.info.duration_ms if self.info else 2**53-1, representatives)
            self._refresh_source()
            lease = self._lease(body.get("lease"), client, view=view)
            item = self.leases[lease]
            if view >= item["view"]:
                candidate = dict(item, view=view, playing=body.get("playing", False), visible=body.get("visible", True),
                    ranges=ranges, representatives=representatives, interval=interval, playhead=playhead)
                candidate["targets"] = self._targets(candidate)
                candidate["pending"] = bool(candidate["targets"])
                wanted = set(candidate["targets"])
                for key, current in self.leases.items():
                    if key != lease:
                        wanted.update(current["targets"])
                if len(wanted) > MAX_TARGETS:
                    raise ValueError("too many thumbnail targets across clients")
                item.update(candidate)
                if self.state == "error" and item["visible"]:
                    self.state, self.error, self.info = "queued", "", None
                if item["playing"] or (self.active_targets and not self.active_targets.intersection(wanted)):
                    self.active_cancel.set()
                if not item["visible"]:
                    self._pins(lease, set())
            item["expires"] = time.monotonic()+LEASE_SECONDS
            self._publish_lease(lease, item)
            self._start()
            self.wake.set()
            return self._snapshot(lease)

    def status(self, binding, *, lease=None, client="", view=0):
        with self.lock:
            self._check(binding)
            if type(view) is not int or not 0 <= view <= 2**53-1:
                raise ValueError("invalid thumbnail view")
            self._refresh_source()
            lease = self._lease(lease, client, view=view)
            item = self.leases[lease]
            if item["view"] < 0:
                item["view"] = view
            item["expires"] = time.monotonic()+LEASE_SECONDS
            self._publish_lease(lease, item)
            self._start()
            self.wake.set()
            return self._snapshot(lease)

    def _targets(self, item):
        if not self.info or not item["visible"]:
            return []
        return plan_targets(item["ranges"], item["interval"], self.info.duration_ms,
                            item["representatives"], item["playhead"])

    def _publish_lease(self, lease, item, *, missing=None):
        if missing is not None:
            item["pending"] = bool(missing)
        if self.coordinator and self.identity:
            self.coordinator.lease(lease, self.identity, playing=item["playing"],
                visible=bool(item["visible"] and item["pending"]))

    def _snapshot(self, lease):
        from maw import thumbnail_cache
        item = self.leases[lease]
        result = {"binding": self.binding, "lease": lease, "view": item["view"], "state": self.state,
                  "source_identity": self.identity, "duration_ms": self.info.duration_ms if self.info else 0,
                  "samples": [], "assets": [], "cache_revision": "", "image_spec": {"width": 160,"height": 90}}
        if self.path and self.info:
            result.update(thumbnail_cache.sample_manifest(self.path, item["targets"], stream_index=self.info.stream_index))
            self._pins(lease, {asset["id"] for asset in result["assets"]})
        result.update(binding=self.binding, lease=lease, view=item["view"],
            source_identity=self.identity, state="paused" if item["playing"] else self.state,
            error=self.error, retry_limit=2, decoding=self.decode_active)
        result["asset_url_template"] = "/api/thumbnails/asset/{asset}?binding={binding}&revision={cache_revision}"
        return result

    def read_asset(self, binding, asset, revision):
        from maw import thumbnail_cache
        with self.lock:
            self._check(binding)
            self._refresh_source()
            if not self.path or not self.info:
                raise ValueError("thumbnail source changed")
            current = thumbnail_cache.sample_manifest(self.path, [], stream_index=self.info.stream_index)
            if revision != current.get("cache_revision"):
                raise ValueError("stale thumbnail revision")
            return thumbnail_cache.read_asset(self.path, asset, cache_revision=revision)

    def _run(self):
        from maw import thumbnails, thumbnail_cache
        while not self.closed.is_set():
            awakened = self.wake.wait(.2)
            self.wake.clear()
            if not awakened:
                with self.lock:
                    expired = any(item["expires"] < time.monotonic() for item in self.leases.values())
                    if self.state in ("idle", "ready", "partial", "unavailable", "error") and not expired:
                        continue
            try:
                self._step(thumbnails, thumbnail_cache)
            except thumbnails.ThumbnailCancelled:
                # Playback, obsolete views and rebinding are normal cancellation boundaries.
                self.wake.set()
            except Exception as error:
                with self.lock:
                    self.error = str(error)[-300:]
                    self.state = "error"
                    for lease, item in self.leases.items():
                        item["pending"] = False
                        self._publish_lease(lease, item)
                self.closed.wait(.2)

    @staticmethod
    def _priority(point, item):
        if point in item["representatives"]:
            return 0
        if any(start["start_ms"]//item["interval"]*item["interval"] <= point < start["end_ms"] for start in item["ranges"]):
            return 1
        return 2

    def _step(self, thumbnails, cache):
        with self.lock:
            path, binding = self.path, self.binding
            if not path or self.state in ("unavailable", "error"):
                return
            self._refresh_source()
            identity = self.identity
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
            priority = {}
            for item in self.leases.values():
                for point in item["targets"]:
                    rank = (self._priority(point, item), abs(point-item["playhead"]), point)
                    priority[point] = min(priority.get(point, rank), rank)
            targets = sorted(priority, key=priority.get)[:MAX_TARGETS]
            if not cache.can_prefetch(path):
                targets = [point for point in targets if priority[point][0] < 2]
            hits = cache.lookup_frames(path, targets, stream_index=self.info.stream_index)
            missing = [point for point, hit in zip(targets, hits) if (hit is None or hit.status == "preview") and self.failures.get(point, 0) < 2]
            for lease, item in self.leases.items():
                self._publish_lease(lease, item, missing=any(point in missing for point in item["targets"]))
                manifest = cache.sample_manifest(path, item["targets"], stream_index=self.info.stream_index)
                self._pins(lease, {asset["id"] for asset in manifest["assets"]})
            if self.coordinator.paused(identity):
                self.state = "paused"
                return
            if not missing:
                self.state = "partial" if any(hit is None or hit.status != "target" for hit in hits) else "ready" if targets else "idle"
                return
            first = missing[0]
            batch = [point for point in missing if abs(point-first) <= 8000 and priority[point][0] == priority[first][0]][:16]
            stream_index = self.info.stream_index
            self.active_targets = set(batch)
            self.decode_active = True
            self.state = "generating"
        try:
            frames = coordinated_extract(path, batch, stream_index=stream_index,
                cancel=cancel, coordinator=self.coordinator)
        except thumbnails.ThumbnailCancelled:
            return
        except thumbnails.ThumbnailError as error:
            frames = []
            with self.lock:
                self.error = str(error)[-300:]
        finally:
            with self.lock:
                self.decode_active = False
                self.active_targets.clear()
        with self.lock:
            if binding != self.binding or source_key(path) != identity:
                return
            if not cancel.is_set() and not self.coordinator.paused(identity):
                ready = {frame.requested_ms for frame in frames if frame.status in ("target", "unavailable")}
                for point in batch:
                    if point not in ready and not self.coordinator.busy(cache.sample_key(path, point, stream_index=stream_index)):
                        self.failures[point] = self.failures.get(point, 0)+1
            # A retry entry belongs to a current visible target, not the entire media history.
            active = {point for item in self.leases.values() for point in item["targets"]}
            self.failures = {point: count for point, count in self.failures.items() if point in active}
            self.active_targets.clear()
        # Foreign in-flight work does not cause a tight transaction loop.
        self.closed.wait(.05)
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
