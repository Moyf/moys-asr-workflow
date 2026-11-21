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
- The updated head still needs its own remote checks. The earlier green Python
  receipts, local browser proof and source checks do not set human acceptance,
  establish GPU-encoder coverage, or prove the complete cross-platform matrix.
