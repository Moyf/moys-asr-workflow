# AI postprocess binding repair: review and verification

Scope: `fix/ai-postprocess-subtitle-bindings`, based on `main` at `9e56e60`.

## Problem and behavior

Cue and atom regrouping replace main segments but retain the old extension
bindings. Merging two bound cues leaves a stale offset for the surviving ID and
a dangling reference for the removed ID; splitting also invalidates old IDs.

The repair releases links whose original main ID or millisecond range changes.
Extension cues, their text and timing, and unaffected links remain intact.
The result includes a warning with the number of released links. The existing
one-to-one schema and strict output validation remain unchanged.

## Independent review

- Initial review: one major finding. Removing an affected binding before
  validating it could hide an already-invalid offset, track, extension reference,
  or duplicate endpoint.
- Resolution: validate the original main segments and extension structure before
  releasing any affected links. Tests cover corrupt affected links as well as
  corrupt links outside the regrouped area.
- Final independent review: no remaining blocker, major, or minor findings;
  the reviewer also reran the nine new tests successfully.

## Verification

Run from the repository root with an environment containing project dependencies:

```sh
python scripts/run_check.py --timeout 180 -- python scripts/run_tests.py tests.test_postprocess_bindings tests.test_postprocess tests.test_postprocess_resegment tests.test_translation_tracks tests.test_postprocess_pipeline tests.test_postprocess_io
python scripts/run_check.py --timeout 180 -- python -m ruff check maw/postprocess.py tests/test_postprocess_bindings.py
```

- Related Python regression set: 249 tests passed, including nine new tests.
- Documentation checker and its 22 regression tests passed; Ruff and the final
  whitespace and personal-path checks passed. Existing navigation warnings for
  older logs remain outside this change.
- Negative control: the final nine new tests run against original `main`
  produced four binding-validation errors; restoring the fix made them pass.
- Source fixture data is synthetic. No user subtitles, model responses, local
  paths, credentials, or executable archives are included in the contribution.
- The first wider attempt lacked OpenCC and Send2Trash; the isolated environment
  was completed and the related set rerun successfully. Seven annotation
  roundtrip cases from a separate attempted set failed because Node build
  dependencies were not prepared; that set is not counted as passing.
- These initial checks did not validate live AI service calls, browser acceptance,
  the complete suite, or remote CI. Later evidence is recorded below.

## CI and media-precision follow-up

The [complete matrix run 43843664106](https://github.com/Moyf/moys-asr-workflow/actions/runs/43843664106)
tested `31b278e09702d67354e5d52e6f2ec90a26ffc35e`. Its only failed test was
`server-align.spec.mjs` / `dragging one gap boundary highlights only that gap`
on Ubuntu browser shard 3/4: `boundingBox()` returned `null` immediately after
an early render. The final matrix gate failed as a consequence. Both Python
jobs completed 3196 cases, with 11 Windows / 12 Ubuntu skips; both required
media runs completed 128 cases with no skips. Those are receipts for the old
commit, not proof of the follow-up changes.

The branch incorporates current `main` through merge `fe2f77b6ea`. That includes
the alignment regression's actionable-handle wait before reading its bounds;
the count of gap nodes alone does not guarantee that a replacement handle is
ready. Local Chromium verification passed all five `server-align.spec.mjs`
cases with zero retries. A separate live-page mouse drag produced exactly one
boundary preview, hid only the edited source gap, and left the other visible.

The earlier review's three media precision failures were addressed without
relaxing their assertions:

- Interval subtitle burning keeps the filter's timestamp time base instead of
  quantizing cuts to nominal frame ticks. Older encoders' missing packet
  durations are filled from adjacent decode timestamps, preserving valid
  durations and presentation order. The output still uses the requested total
  kept-interval duration, including silent and delayed audio.
- For Matroska without a stream duration, the thumbnail probe seeks to the
  reported tail and includes each media packet's own duration. Older muxers
  can omit the final frame's duration in the header. No nominal-FPS guess or
  full-file decode is used; cancellation and bounded probe output still apply.

### Follow-up verification and limits

- The three original failing cases passed together with FFmpeg 7.0.2.
- The affected media/cache set ran 187 cases with FFmpeg 7.0.2 and again with
  the distribution's 8.1.2. In each run, 184 passed, two cache timestamp cases
  failed and one symlink case skipped. All 80 burn/thumbnail-probe cases passed
  in both versions, including the original three. These mixed runs are not
  recorded as an overall pass.
- The two extra cache failures used a local temporary filesystem that rounded
  timestamp changes to seconds, so the intended sub-millisecond changes were
  not represented. A direct `os.utime` / `stat` probe demonstrated this loss.
  Repeating the complete 44-case cache module in the system temporary directory,
  which preserved 100-nanosecond changes, passed all 44 with no skips. No cache
  implementation or test assertion was changed to hide these failures.
- A one-frame FFmpeg 7.0.2 encode retained one frame and a 40 ms duration;
  both 7.0.2 and 8.1.2 probes read those values. Ruff passed for the two changed
  Python implementation files.
- Documentation navigation reported no new broken links or structure errors;
  all 22 documentation-check regression tests passed. The 14 registered
  historical broken links remain outside this repair.
- Raw reports, media probes and local screenshots remain in ignored local
  artifacts, not in the contribution. No personal media or model calls were used.
- At the previous handoff, `64a5f41947` still awaited remote approval. On
  2026-11-22, its [Change checks](https://github.com/Moyf/moys-asr-workflow/actions/runs/44916700302)
  (all 12 jobs), [Python lint](https://github.com/Moyf/moys-asr-workflow/actions/runs/44916700345)
  and [Windows preview](https://github.com/Moyf/moys-asr-workflow/actions/runs/44916700356)
  were observed completed with `success`. These receipts apply only to that
  previous head, not the compatibility follow-up below; they do not establish
  human acceptance, GPU coverage or the complete cross-platform matrix.

## FFmpeg compatibility and optional-tail follow-up

The [2026-11-22 upstream review](https://github.com/Moyf/moys-asr-workflow/pull/385#issuecomment-7074210357)
identified two regressions in the media-precision follow-up. Both are scoped
local fixes; the AI binding contract, schemas, dependencies, encoder fallback,
and unrelated export/job failures remain unchanged.

- Interval burning now sets the video filter clock to `AVTB` and uses the
  equivalent numeric encoder time base `1:1000000`, supported by FFmpeg 5.1.
  This preserves microsecond cut offsets without the unsupported `filter`
  keyword, version detection, or another retry. Existing real-media precision
  assertions remain unchanged.
- The Matroska tail scan is an optional correction after a valid header probe.
  Output-budget errors, timeouts and unsuccessful scans keep that valid
  duration. `ThumbnailCancelled` is re-raised before the broader probe-error
  handler; a final event check also preserves cancellation if a budget error
  wins the subprocess polling race. Initial-probe failures still propagate.
  Two regression methods cover these fallback and cancellation boundaries.
- Scope: the two implementation files, their two existing test modules, these
  existing review notes and the two existing changelog entries. The burn fixture
  now includes an explicit ASS style: FFmpeg 5.1's libass rejects the previous
  style-less synthetic input, even for unchanged full-video burning. The font
  alias fixture changes that same style instead of inserting a duplicate.
  Assertions are not relaxed. No generated UI or installed binary is changed.
  Revert this follow-up if its clock regresses existing precision assertions.

### Direct long-GOP verification

FFmpeg 7.0.2 generated a 64 x 64, 120 fps, 720-second Matroska video with only
the initial keyframe (`libx264`, `-g 1000000 -keyint_min 1000000 -sc_threshold 0`).
The actual optional seek scan exceeded the unchanged 8 MiB output budget.
The corrected probe still returned `duration_ms=720000`; extracting the first
thumbnail produced a real JPEG with `status=target` and `actual_pts_ms=0`.
The artifact was visually inspected. Neither the 20-second timeout nor output
limits were raised, and the fixture is kept only in ignored local artifacts.

### Compatibility regression results

The final fixture and implementation passed the same 48 tests on Windows with
FFmpeg / FFprobe 5.1.2, 7.0.2 and the bundled 8.1.2 separately, with no skips:

```sh
python scripts/run_check.py --timeout 240 -- python scripts/run_tests.py tests.test_burn_video_export.BurnAssVideoTests tests.test_burn_video_export.BurnVideoPrecisionTests tests.test_thumbnails
```

Each version was selected with a native Windows PATH separator, then verified
with executable resolution and `-version` before the test subprocess started.
Earlier shell-PATH attempts resolved the system development build instead and
are not counted as evidence for those releases. The first actual 5.1.2 run
reported ten errors because the style-less shared ASS fixture was rejected;
that failed run remains recorded, rather than being counted as a pass. Adding
the explicit style made the same assertions pass on all three versions.

The remaining 34 HTTP, diagnostic and sticker tests in the shared ASS-fixture
module also passed with no skips. After adding the explicit cancellation-race
event check, its focused regression passed; Ruff passed again for those two
files. The navigation index also retains the latest main's two new log entries
while preserving this contribution's existing review link.

Ruff passed for both implementation files and both changed test modules.
No Debian runtime, GPU encoder, packaged installation or human acceptance was
performed; fresh remote checks must apply to the new pushed head.

The contribution was synchronized with `main@a3121f0d4de725d50fb9fb56775ca9589caaf847`
without conflicts after retaining both incoming log-index entries. The upstream
script-match and recent-project features were merged unchanged; they are not
part of this compatibility repair's test claims.

After integration, the documentation checker found zero new broken links and
zero structure errors across 1772 files; 14 registered historical broken links
remain unchanged. Its 22 regression tests passed. Verification stayed scoped:
no full test suite, release, package or installation was run.
