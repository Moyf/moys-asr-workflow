# PR #207: visibility-first ASS subtitle stacking

Base: `eb3e8a1acfa67b86293cac5bdb85ab5d4571a4dc` (main after #206). Branch: `code/pr205-anchor-investigation-261011`. Final source candidate: `866c94848851d894fee35eeca9897ee5288ee7e2`.

Status: implementation, independent source review and local acceptance passed. Later commits integrate the independent tests and this report without changing production source. Publication and merge require successful CI on the published head.

## Problem and resulting behavior

The #205 secondary-track margin formula only placed subtitles above main reliably with bottom alignment. Middle/top alignment, multiline text, large styled runs, rotation and movement could separate the tracks, overlap text or put subtitles outside the picture.

The user selected visibility first: secondary cues follow the active main cue, and the complete subtitle group moves into the picture when space is insufficient. The implementation uses actual styled text measurements rather than a nominal single-line font-size offset.

## Implementation

- A shared planner sweeps quantized active cue boundaries. Every simultaneous cue, including overlaps within one track, is a separate group member. Order is main, extension, overlay; each track retains its horizontal column and margins.
- Styled multiline runs, speaker prefixes, emphasis, comment and small/large text contribute to measured bounds. Explicit wrapping is serialized into ASS. Conservative 2D transform envelopes cover font animation, anisotropic scaling, rotation, outline and shadow.
- Each interval uses one movement path and one uniform group scale. Viewport translation keeps the supported group visible. If fitting would reduce the smallest actual run below the readable floor (8 pixels at 1080p, scaled with PlayRes), the planner returns an actionable diagnostic.
- Canvas and ASS export consume the same plan and injected browser font measurer. Server libass frame preview uses the exported ASS. CSS preview retains its separate existing layout. DOM-free utility calls use conservative deterministic character metrics.
- Split Dialogue events preserve each source cue's fade, move and transform clocks, including whole-cue zero-time transforms and movement. Completed movement slices remain at the endpoint. Formatted runs receive proportional font transforms; discrete underline/strike targets become the effective run baseline. A cue that participates in a group keeps those clocks across preceding/following solo intervals. A project containing only solo main cues retains the previous serializer and geometry.
- Fractional plain font sizes and line advances avoid cumulative multiline rounding error. Positive spacing uses native ASS pixel units in shared measurements and paint. Preview caches track primitive cue/style/settings changes and font-loading revisions; word metadata is not serialized per playback frame. Measurement caches are bounded.
- Preview displays diagnostics; normal and gap-removed ASS exports catch failures and show a hint before opening a save picker. Unsupported intervals cannot silently become a successful partial export.

## Supported boundaries and limits

Supported 2D transforms include font size, nonnegative spacing, X/Y scale, Z rotation, border/shadow and discrete bold/italic/underline/strike styles. Colors and alpha transforms can pass through. Native semantics for boolean targets, overlapping short fades and instantaneous movement were checked against actual libass frames.

Stacked intervals explicitly reject negative spacing, 3D perspective, custom origins, clipping, drawing/font resets, duplicate or unsupported transform geometry, and out-of-range transform values. External players may substitute fonts. Pixel acceptance used Windows Edge and installed Arial fixtures; libass logs selected ArialMT, Arial-BoldMT and Arial-BoldItalicMT. This is not an exhaustive claim for all fonts, operating systems or external players.

Portable `blank-editor.html`, release tags and packaging binaries are outside this change. The editor bundle and metadata are rebuilt and committed.

## Independent acceptance evidence

Evidence directories below are ignored local artifacts. Production paths refer to the PR worktree; independent paths refer to the separate validation worktree.

| Layer | Result | Evidence under `.debug-runs/` |
| --- | --- | --- |
| Complete Node regression | 571/571 passed, no skips | Production `20261011T044438Z-fa1a7afb` |
| Complete Python regression | 1961 total: 1935 passed, 26 skipped; exit 0 | Production `20261011T044442Z-00d25039` |
| Affected Edge browser regression | 154 distinct cases passed: 147 in the initial seven-spec run, then all 7 corrected assertions passed | Production `20261011T044438Z-90cbe71d`, `20261011T045030Z-0881a884` |
| Independent real Canvas / FFmpeg-libass matrix | 33/33 passed, retaining 3-pixel bounds tolerance, guard completeness, nonoverlap and clock controls | Independent `20261011T044852Z-4f20d5d0`, `candidate-866c948-final-33-pixel-matrix` |
| Independent decoration control | 12 native frames exactly match explicit static controls in both target directions across solo/group boundaries | Production `20261011T044439Z-8c467d5d` |
| Independent zero-time transform and fade clock | 9 native frames exactly match original unsplit cues; pure solo serialization unchanged | Production `20261011T044439Z-bc18c639` |
| Independent movement and Canvas semantics | Completed ordinary/instant moves remain at target after splitting; zero-time movement continuous; 29 actual Canvas samples match native semantics | Production `20261011T044440Z-62ae1fb1`, `20261011T044440Z-b7ef4d2f`, `20261011T044650Z-ccc57999` |
| Independent positive spacing with outline/shadow | Complete per-track paint width agrees, maximum 1-pixel bounds difference | Production `20261011T044529Z-09ff4044`, `20261011T044601Z-d2884f4e` |
| Typecheck / editor freshness / Ruff | Passed | Production `20261011T044513Z-40196e6f`, `20261011T044514Z-d0ab4f8f`, `20261011T044517Z-e5c065c0`; final integrated checks also run before commit |
| Source review | No remaining reproducible P1/P2 findings | Independent read-only review of `866c948` against the base |

The Python run retains an existing nonfatal subprocess UTF-8 reader diagnostic from intentionally invalid fixture bytes; the runner finished all 1961 tests successfully. An earlier targeted Node invocation failed when the default `uv` cache was sandbox-inaccessible; using the existing interpreter through `MAW_TEST_PYTHON` passed all targeted and full checks. These were not hidden or treated as source fixes.

Browser assertion corrections preserve real behavior: current copy and `data-title` tooltips, the existing lower cue-panel editing entry, active tracks selected by role/cue identity, and explicit split-event coverage/clocks. Three representative old assertions independently failed on the unchanged main-equivalent base `dbd76b4` in `20261011T044755Z-44bc52a1`. No unrelated product behavior was changed to satisfy them.

The pixel oracle captures actual root `drawImage` calls and replays them onto a padded Canvas to detect bitmap/viewport crop. It renders exported ASS with FFmpeg/libass at exact millisecond timestamps. A padded libass control must match the native frame when cropped back to the viewport. Color masks identify track fills; isolated per-role renders also check full colored outline/shadow geometry. Clock cases use original unsplit native ASS as an independent control. Decoration cases compare correct and deliberately different native controls. Real export clicks verify hints, absence of picker/download and absence of unhandled errors for all diagnostic categories.

Typical validation commands, using configured local interpreter/browser variables:

```text
python scripts/run_check.py --timeout 600 -- node --test tests/*.mjs
python scripts/run_check.py --timeout 600 -- python scripts/run_tests.py
python scripts/run_check.py --timeout 900 -- node node_modules/@playwright/test/cli.js test <affected specs> --project=chromium --workers=2
python scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test tests/e2e/ass-stacking-boundaries.spec.mjs --project=chromium --workers=1
node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json
node scripts/build-editor.mjs --check
python -m ruff check .
git diff --check
```

The external manual verification HTML keeps all maintainer acceptance checkboxes initially unchecked. Browser QA covers its persistence/reset/JSON export and three viewport widths; automation results do not imply maintainer manual signoff.
