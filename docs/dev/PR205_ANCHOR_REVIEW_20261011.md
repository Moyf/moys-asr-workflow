# PR #205 ASS anchor review and repair attempt

Baseline: `bb86f65`, branch `code/pr205-anchor-investigation-261011`.

## Reproduced defect

PR #205 computes extension MarginV as main MarginV + round(1.2 × main font size), then lets each secondary style interpret that margin using its own alignment. This only places the extension above main when both use bottom alignment. For top alignment the increased margin moves down; for middle alignment the vertical margin is ignored. Different main/extension vertical alignments place cues in unrelated screen areas. Overlay inherits the same defect. The existing browser regression still expected the old extension-below-main behavior, so its assertions did not cover the new contract.

## Narrow repair

- A shared `assCanvasStackedAnchor` helper computes a fixed absolute anchor above the nominal single-line box of the preceding layer. Bottom-main default spacing remains unchanged; middle/top main alignment adjusts the nominal box origin.
- Secondary tracks retain their horizontal alignment and side margins. Their vertical attachment is bottom-aligned. ASS events carry matching `an` and `pos` overrides; Canvas consumes the same coordinates.
- Main style positioning and main move animation remain intact. Secondary tracks still do not follow main move, matching the existing animation contract.
- ASS export and Server libass frame preview both use `buildAss`; Python `maw/ass_styles.py` only normalizes and serializes styles, with no separate secondary event-position implementation. CSS preview keeps its existing DOM stack.
- The style library data stays editable and unchanged. Extension MarginV and its vertical alignment component continue to be overridden by fixed stacking. Overlay typography/color still follows main; horizontal placement follows the anchor layer.

## Verification

All checks use `scripts/run_check.py`. Editor bundle and metadata were rebuilt; the committed portable HTML was not regenerated.

| Layer | Result | Evidence under `.debug-runs/` |
| --- | --- | --- |
| Node layout/export regression | 316 passed | `20261011T033436Z-847b599c/result.json` |
| Typecheck | Passed | `20261011T033440Z-21018b00/result.json` |
| Build | Passed | `20261011T033436Z-6d1624d5/result.json` |
| Edge browser | 1 passed, covering main 2/5/8 × extension 1/6/9 and export-coordinate parity | `20261011T033650Z-ff6f2800/result.json` |
| FFmpeg/libass actual rendered pixels | Bottom, middle and top all show overlay above extension above main; mixed alignment retained | `20261011T033639Z-61285688/result.json` |

The browser screenshot is `test-results/multi-subtitle-ASS-mode-pr-687a7--the-shared-extension-style-chromium/top-right-ass-anchor.png`. Actual libass frames are `.debug-runs/anchor-{bottom,middle,top}.png`. These ignored local artifacts were visually inspected and are not committed. Initial unit failures came from missing `MAW_TEST_PYTHON`; rerunning with the existing venv passed. Browser attempts inside the sandbox failed before assertions (missing Playwright cache, then Edge launch); the same targeted test passed outside the sandbox. The libass probe initially used malformed color fixtures; correcting the fixture produced three successful pixel-order assertions.

## Review and merge limits

This repair preserves the existing nominal single-line 1.2 × font-size model. It does not guarantee separation for multiline text, unusual font bounds, emphasized glyph sizes, rotation or font-size animation. Main move can cross the fixed secondary anchors. Top-aligned main cues near the screen edge can put secondary anchors off-screen; no clamp is applied because moving them down would overlap the user-positioned main cue.

The attempt is suitable to integrate if the intended contract is this existing nominal fixed-stack model with editable horizontal placement. If “above” instead requires measuring actual cue bounds, following main movement, or keeping every track on-screen, a broader explicit product contract and renderer-aware layout work remain necessary. No remote push or merge is performed by this branch.
