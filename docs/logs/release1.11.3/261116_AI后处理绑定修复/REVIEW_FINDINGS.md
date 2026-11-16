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
- Live AI service calls, browser acceptance, the complete suite, and remote CI
  have not been validated by these local checks.
