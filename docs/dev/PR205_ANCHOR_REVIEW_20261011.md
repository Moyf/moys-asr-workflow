# PR #205 ASS anchor review and repair attempt

Baseline: `bb86f65`, branch `code/pr205-anchor-investigation-261011`.

Status: independent draft investigation. The reviewed small fixes from the final integration branch will be included only after its final base SHA is supplied. This positioning contract change is not approved for merge.

## Reproduced defect

PR #205 computes extension MarginV as main MarginV + round(1.2 × main font size), then lets each secondary style interpret that margin using its own alignment. This only places the extension above main when both use bottom alignment. For top alignment the increased margin moves down; for middle alignment the vertical margin is ignored. Different main/extension vertical alignments place cues in unrelated screen areas. Overlay inherits the same defect. The existing browser regression still expected the old extension-below-main behavior, so its assertions did not cover the new contract.

## Narrow repair

- A shared `assCanvasStackedAnchor` helper computes a fixed absolute anchor above the nominal single-line box of the preceding layer. Bottom-main default spacing remains unchanged; middle/top main alignment adjusts the nominal box origin.
- Secondary tracks retain their horizontal alignment and side margins. Their vertical attachment is bottom-aligned. ASS events carry matching `an` and `pos` overrides; Canvas consumes the same coordinates.
- Main style positioning and main move animation remain intact. Secondary tracks still do not follow main move, matching the existing animation contract.
- ASS export and Server libass frame preview both use `buildAss`; Python `maw/ass_styles.py` only normalizes and serializes styles, with no separate secondary event-position implementation. CSS preview keeps its existing DOM stack.
- The style library data stays editable and unchanged. Extension MarginV and its vertical alignment component continue to be overridden by fixed stacking. Overlay typography/color still follows main; horizontal placement follows the anchor layer.

The nominal formula is `secondaryY = mainAnchorY - round(1.2 × fontSize) + round((2 - row) × fontSize / 2)`, where screen rows are top = 0, middle = 1, bottom = 2. The secondary bottom edge attaches to that coordinate. Chaining the next layer treats the preceding secondary as bottom-aligned. This is a coordinate contract, not a measurement of actual rendered text boxes.

Independent source review confirms that main event text and main style remain untouched. The preview's main track does not receive a secondary `anchor`; its existing style/move path continues to determine positioning. Legacy export positioning is unchanged. Final-integration changes reviewed at `b38cef3` and the small-fix commit `e6d9669` add stable stage geometry, speaker formatting and cache invalidation in separate source regions; these need to be preserved during eventual integration.

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

| Boundary | What is established | What remains unverified or undecided |
| --- | --- | --- |
| Ordinary single-line cues | Shared coordinates pass unit/browser assertions; three mixed-alignment libass frames have separated actual pixel bounds | The actual pixel result is limited to the tested font/style fixtures |
| Multiline / unusual font metrics | Formula intentionally uses the unchanged nominal font size | Real text-box separation and multiline wrapping are not guaranteed |
| Inline emphasis / large text / comment size | Styling remains editable; no text-size expansion is added to the anchor model | Expanded glyph bounds may cross the nominal gap |
| Rotation / scale / font-size animation | Existing rendering transforms remain in place | Rotated or animated text-box clearance is not guaranteed |
| Main movement | Main retains the existing move path; secondary anchors remain static | Whether secondary tracks should follow main is a product-contract decision |
| Top-edge placement | Negative secondary coordinates are retained; a unit test locks this behavior | Keeping all layers on-screen without changing main positioning requires a separate policy |
| Simultaneous overlapping secondary cues | Every cue receives the same fixed track anchor | Renderer collision handling with explicit positions has not been validated |
| Mixed horizontal placement | Column and side margins are retained, and Canvas/export coordinates match | “Above” describes vertical ordering, not a requirement to horizontally overlap main |

Before merge, the intended contract must explicitly accept bottom attachment of secondary tracks, nominal single-line spacing and the off-screen behavior. If “above” instead requires measuring actual cue bounds, following main movement, or keeping every track on-screen, a broader explicit product contract and renderer-aware layout work remain necessary. The draft should remain unmerged until that decision is made. No remote push or merge is performed by this branch.
