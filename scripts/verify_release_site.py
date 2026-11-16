"""Verify a deployed update index and its target detail/notes pages."""
from __future__ import annotations

import argparse
from http.client import HTTPException
import json
import math
import sys
import time
from urllib.request import Request, urlopen
import uuid

try:
    from .build_release_site import stable_key
except ImportError:
    from build_release_site import stable_key


class SiteNotReadyError(OSError):
    """A valid but old catalog (or unavailable page) may catch up on retry."""


class StaleCatalogError(SiteNotReadyError, ValueError):
    """Keep the single-round verifier's historical ValueError compatibility."""


def _remaining(deadline: float | None) -> float:
    remaining = 15 if deadline is None else deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('release site verification deadline reached')
    return min(15, remaining)


def _fetch(url: str, nonce: str | None, deadline: float | None, *, detail: bool = False):
    if nonce is not None:
        url += '?_maw_verify=' + nonce
    request = Request(url, headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
    with urlopen(request, timeout=_remaining(deadline)) as response:
        if detail:
            if response.status != 200:
                raise SiteNotReadyError(f'version detail page unavailable: HTTP {response.status}')
            result = None
        else:
            result = json.load(response)
    # Socket timeouts bound individual blocking operations, not the full read.
    # Never start another request or declare success after the overall deadline.
    _remaining(deadline)
    return result


def _target(index, expected_tag: str, observation: dict, source: str):
    if not isinstance(index, dict):
        raise ValueError('update feed must be an object')
    observation.update(source=source, latest_stable=index.get('latest_stable', '<missing>'),
                       generated_at=index.get('generated_at', '<missing>'))
    if type(index.get('schema_version')) is not int or index['schema_version'] != 1:
        raise ValueError('unsupported update feed schema')
    releases = index.get('releases')
    if not isinstance(releases, list) or any(
            not isinstance(entry, dict) or not isinstance(entry.get('version'), str) for entry in releases):
        raise ValueError('update feed releases must be a list of version objects')
    versions = [entry['version'] for entry in releases]
    if versions != sorted(set(versions), key=stable_key, reverse=True):
        raise ValueError('update feed is not in unique stable version order')
    if 'latest_stable' not in index or index['latest_stable'] != (versions[0] if versions else None):
        raise ValueError('latest_stable does not match catalog')
    target = expected_tag.removeprefix('v') if expected_tag else index['latest_stable']
    if target is not None and target not in versions:
        raise StaleCatalogError(f'deployed catalog has not caught up to {expected_tag}')
    return target


def _verify(base_url: str, expected_tag: str, deadline: float | None, observation: dict):
    base = base_url.rstrip('/')
    nonce = uuid.uuid4().hex
    target = _target(_fetch(base + '/releases/index.json', nonce, deadline),
                     expected_tag, observation, 'probe')
    # Cache-busted probes alone do not prove that the real user entry is ready.
    # Require the canonical index to advertise the same target as the probe.
    canonical_target = _target(_fetch(base + '/releases/index.json', None, deadline),
                               expected_tag, observation, 'canonical')
    if canonical_target != target:
        raise SiteNotReadyError('probe and canonical latest_stable have not converged')
    if target is None:
        return None
    for query in (nonce, None):
        notes = _fetch(f'{base}/releases/{target}/notes.json', query, deadline)
        if (not isinstance(notes, dict) or type(notes.get('schema_version')) is not int
                or notes['schema_version'] != 1 or notes.get('version') != target
                or not isinstance(notes.get('body_markdown'), str) or not notes['body_markdown'].strip()):
            raise ValueError('version notes did not verify')
    for query in (nonce, None):
        _fetch(f'{base}/releases/{target}/', query, deadline, detail=True)
    return target


def verify(base_url: str, expected_tag: str = '') -> None:
    """Verify one round; retain the public import used by publication tests."""
    _validate_expected_tag(expected_tag)
    target = _verify(base_url, expected_tag, None, {})
    print(f'Deployed release site verified: {target}')


def _positive(value: float, name: str) -> None:
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'{name} must be a finite positive number')


def _validate_expected_tag(expected_tag: str) -> None:
    if expected_tag == '':
        return
    try:
        if not isinstance(expected_tag, str) or not expected_tag.startswith('v'):
            raise ValueError('missing v prefix')
        stable_key(expected_tag[1:])
    except ValueError as error:
        raise ValueError('expected_tag must be empty or a stable release tag vX.Y.Z') from error


def _compact(value, limit: int) -> str:
    text = ' '.join(str(value).split())
    return text if len(text) <= limit else text[:limit - 3] + '...'


def _report(status: str, attempts: int, started: float, expected_tag: str, observation: dict, error) -> str:
    message = (f'Release site {status}: attempt={attempts}, elapsed={time.monotonic() - started:.1f}s, '
               f'expected={_compact(expected_tag or "latest", 64)}, '
               f'source={observation.get("source", "unknown")}, '
               f'latest_stable={_compact(observation.get("latest_stable", "<unknown>"), 96)}, '
               f'generated_at={_compact(observation.get("generated_at", "<unknown>"), 96)}, '
               f'last_error={_compact(error or "none", 240)}')
    print(message, flush=True)
    return message


def wait_for_site(base_url: str, expected_tag: str = '', *, timeout: float = 300,
                  retry_interval: float = 10) -> None:
    """Wait within one monotonic budget; malformed contracts fail immediately.

    Old valid indexes and HTTP/network failures (including truncated reads and
    malformed HTTP status lines) retry. Socket reads can overrun the budget;
    the caller must keep a process-level timeout with some headroom.
    """
    _positive(timeout, 'timeout')
    _positive(retry_interval, 'retry_interval')
    _validate_expected_tag(expected_tag)
    started = time.monotonic()
    deadline = started + timeout
    attempts, reports = 0, 0
    next_report = started
    observation, last_error = {}, None
    while time.monotonic() < deadline:
        attempts += 1
        try:
            _verify(base_url, expected_tag, deadline, observation)
            # The last response check may pass just before a scheduling delay.
            # Make the success decision against the deadline, not that old check.
            _remaining(deadline)
        except (OSError, HTTPException) as error:
            last_error = f'{type(error).__name__}: {error}'
        except ValueError as error:
            _report('failed', attempts, started, expected_tag, observation, f'{type(error).__name__}: {error}')
            raise
        else:
            _report('verified', attempts, started, expected_tag, observation, None)
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        # Bound output even if a caller selects a sub-second retry interval.
        if reports < 30 and time.monotonic() >= next_report:
            _report('waiting', attempts, started, expected_tag, observation, last_error)
            reports += 1
            next_report = time.monotonic() + 10
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(retry_interval, remaining))
    message = _report('timed out', attempts, started, expected_tag, observation, last_error)
    raise TimeoutError(message)


def positive_seconds(value: str) -> float:
    try:
        seconds = float(value)
        _positive(seconds, 'seconds')
    except ValueError as error:
        raise argparse.ArgumentTypeError('must be a finite positive number') from error
    return seconds


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--expected-tag', default='')
    parser.add_argument('--timeout', type=positive_seconds, default=300,
                        help='overall waiting budget in seconds (default: 300)')
    parser.add_argument('--retry-interval', type=positive_seconds, default=10,
                        help='delay between attempts in seconds (default: 10)')
    args = parser.parse_args(argv)
    try:
        wait_for_site(args.base_url, args.expected_tag, timeout=args.timeout, retry_interval=args.retry_interval)
    except (ValueError, OSError) as error:
        print(f'Release site verification failed: {_compact(error, 700)}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
