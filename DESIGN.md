# MAWE Design System

This file is the minimal design contract for the MAW editor UI. It extracts the
implicit patterns already present in `web/editor.css` and `web/editor-template.html`
so new components stay consistent without inventing new tokens. It is intentionally
small: the editor is a single dark-theme tool, not a multi-product design system.

## 1. Design tokens (extracted from existing CSS)

All values are already in use; do not introduce new ones without extending this table.

| Token | Value | Used by |
|---|---|---|
| `--bg-player-empty` | `#171d23` | `.player-wrap.empty-state` background |
| `--border-player` | `#34414e` | `.player-wrap.empty-state` border |
| `--bg-overlay-text` | `rgba(0,0,0,0.65)` | `.subtitle-overlay span` background |
| `--color-overlay-text` | `#fff` | `.subtitle-overlay span` text |
| `--overlay-radius` | `4px` | `.subtitle-overlay span` radius |
| `--overlay-font` | `clamp(14px, 2.5vw, 26px)` | `.subtitle-overlay span` font-size |
| `--overlay-shadow` | `0 1px 2px rgba(0,0,0,0.8)` | `.subtitle-overlay span` text-shadow |
| `--accent-focus` | `#5ea7ff` | focused inputs / focus ring |
| `--handle-size` | `12px` | resize handle hit area (new) |
| `--handle-color` | `#fff` | resize handle fill (new, opaque only on show) |

The overlay container itself is transparent; only the inner `<span>` carries the
dark translucent pill. This is preserved by the geometry work: the container is the
movable/resizable box, the `<span>` stays centered inside it.

## 2. Subtitle overlay geometry model

The overlay (`#overlay`) is positioned absolutely inside `.player-wrap`. Its
geometry is persisted as normalized fractions of the player-wrap rect so it
survives player resize and cross-machine transfer without absolute pixels.

```json
{
  "preview": {
    "subtitle": { "x": 0.0, "y": 0.76, "width": 1.0, "height": 0.16 }
  }
}
```

- `x`, `y` — top-left corner as a fraction of player-wrap width/height, clamped to `[0, 1]`.
- `width`, `height` — box size as a fraction of player-wrap width/height.
- `width >= 0.20` and `height >= 0.08` (minimum readable box).
- `x + width <= 1` and `y + height <= 1` (box stays inside the player).
- Legacy default (when `preview.subtitle` is absent): `{ x: 0, y: 0.76, width: 1, height: 0.16 }`
  — this reproduces the original `bottom: 8%` band: the box spans 76%→92%, leaving
  an 8% bottom gap, with the text span vertically centered inside.

The geometry is applied to `#overlay` as `left/top/width/height` in `%`. The inner
`<span>` keeps its existing `max-width: 90%`, centering and pill styling, so the
visible text rendering is unchanged when the box is at the legacy default.

## 3. Interaction states for the overlay

Handles and focus affordances are **hidden by default** and revealed only when the
overlay is being used. This keeps the subtitle preview visually identical to the
legacy rendering when the user is not editing it.

| State | Class on `#overlay` | Visible |
|---|---|---|
| idle (hidden text) | `hidden` | nothing |
| idle (showing text) | — | only the text pill |
| hover / focus / dragging / resizing | `editable` | 8 resize handles + dashed outline + focus ring |

- `#overlay` gains `tabindex="0"`, `role="group"`, and an `aria-label` that exposes
  drag, Arrow/Shift/Alt, Enter/Space, and Esc controls to assistive technology.
- Pointer drag on the box body moves it; pointer drag on a handle resizes.
- Keyboard: with focus, Arrow keys nudge position by 1% (10% with Shift);
  `Alt+Arrow` resizes (Alt+Left/Right adjust width from the east edge, Alt+Up/Down
  adjust height from the south edge). `Esc` blurs; `Enter`/`Space` toggles `editable`
  for keyboard users.
- One undo record per gesture (pointer-down → pointer-up, or one keyboard nudge),
  pushed at gesture start with the pre-gesture snapshot.

## 4. Constraints carried over from AGENTS.md

- No new external assets, fonts, or icon libraries. Handles are CSS-drawn squares.
- Local server stays on `127.0.0.1`; geometry persistence goes through the existing
  `/api/project` save + `maw.project.normalize_project` round-trip — no new endpoint.
- Segment timing (`segments[*].start/end/items[*].start/end`) is never touched by
  preview geometry code.

## 5. Launcher toolbox

The Launcher adds one compact, fixed toolbox above the action footer. It reuses the
existing Launcher tokens in `web/launcher/launcher.css`; no new color, typography,
radius, or shadow system is introduced.

### Primitives

| Primitive | Purpose | States |
|---|---|---|
| `.toolbox-fab` | Round entry point at the lower-right edge | idle, hover, focus, expanded, disabled |
| `.toolbox-drawer` | Bounded panel for one active post-processing workflow | hidden, open, busy |
| `.toolbox-primary-tabs` | Switch between subtitle post-processing and media utilities | idle, active, focus |
| `.toolbox-tabs` | Switch tools within the active primary workflow | idle, active, focus |
| `.toolbox-result` | Show generated artifacts and chain state | empty, success, warning, error |
| `.artifact-context-menu` | Three-action menu for one generated artifact | hidden, open, item hover, item focus |

The drawer owns its own vertical scroll and uses `max-block-size` plus
`overflow-y: auto`; the document remains the outer Launcher scroll owner. At widths
below 620px the drawer spans the viewport inset and all two-column rows become one
column. Long paths use `overflow-wrap: anywhere` and never force horizontal scroll.

### Interaction contract

- Opening the drawer copies the Launcher's current project, SRT, and media paths.
- A successful subtitle tool updates the Launcher project/SRT fields to the new
  artifacts, so the next run consumes the previous run without overwriting source.
  When a tool emits only one format, the stale alternate-format field is cleared;
  this makes the newly generated artifact the single authoritative next input.
- A successful FFconcat run updates only the media input. It never silently rewrites
  the subtitle project or its timeline.
- The LLM provider form supports DeepSeek, Zhipu Coding Plan, Qwen, and a custom OpenAI-compatible
  endpoint. Saved keys are displayed only as masked values.
- The floating button and drawer expose `aria-expanded`, dialog labeling, keyboard
  focus, Escape close, and visible focus rings.
- Artifact buttons show localized type labels while keeping filename and full path in
  title and accessible text. Their context menu uses the existing overlay, border,
  radius, shadow, focus, and 4px spacing tokens; it opens at the pointer, clamps to an
  8px viewport inset, focuses the first action, and closes on action, Escape, outside
  pointer input, or replacement by another artifact menu.
- Launcher zoom is persisted in 5% steps from 80% through 150%, with 100% as the
  default and reset value. Pointer events and `getBoundingClientRect()` remain in
  viewport pixels; CSS geometry is written in page units through the shared
  viewport-to-page conversion, so overlays and both toolbox resize axes stay aligned.
- On narrow screens the floating button clears the two-row sticky action footer and
  the open drawer clears the button; error results use primary text over the red-soft
  background to preserve AA contrast.
- The primary navigation is immediately below the Toolbox header:「后处理」is selected
  by default and owns the subtitle / `.mosp` input, artifact chain, output selector,
  and script match, OCR dedup, LLM, and fixed replacement tools.「实用工具」owns a
  single shared media input and waveform generation, speech alignment, plus FFconcat
  rebuild; it never exposes the subtitle input or artifact chain. The shared media
  input keeps the label「媒体文件」for every utility and is not duplicated inside a
  utility panel.
- Utility tabs are ordered by the workflow priority:「口播对齐」comes first, followed
  by waveform generation and FFconcat rebuild. When a tool needs multiple source files,
  each `.toolbox-input` is a separate visual block; the parent must provide a visible
  vertical gap (use the existing 10px toolbox spacing) so adjacent inputs never touch.
- The「口播对齐」panel keeps its four visible automatic-gap settings inside
  `.toolbox-content`, below the MAW project and proofreading-script inputs. The
  visible controls mirror MAWE's current defaults (400ms minimum, -28dB threshold,
  120ms lead-in, 80ms lead-out); the less frequently used 2dB hysteresis remains an
  internal compatibility default. The settings use the existing grouped-card and
  10–12px grid spacing, persist under the Launcher-only
  `maw.launcher.alignment.gap_remove` key, and must not read or overwrite MAWE's
  editor settings.
- The standalone `server-align` page uses the same waveform interaction language as MAWE:
  `多行` is the default view, and `基础` / `多行` live in one two-option segmented slot.
  Clicking an active gap temporarily previews its original audio even when skip-gap playback
  is enabled; `Alt` + click toggles an existing gap, while `Alt` + click/drag on blank waveform
  adds a gap. Clicking an adopted complete take toggles its manual-disabled state.
- Manual take overrides and manually adjusted gap ranges use the MAWE light-blue inset treatment:
  `box-shadow: inset 0 0 0 4px rgb(65 174 207 / 35%)`. Visible standalone labels use「空隙」and「额外」;
  internal `gap_remove` / `extra` field names remain data-contract identifiers.
- The Utilities media input follows the Launcher's media path until the user chooses,
  drops, or types an override. Clearing that override restores following behavior.
  Waveform offers separate generate-only and generate-and-open-editor actions, with a
  scoped optional spectral-cache checkbox; only the latter changes the Launcher project
  and starts the existing MAWE Server flow. FFconcat accepts a picked or dropped script
  that references the scoped Utilities media input.

## 6. Layering contract: popovers inside the sticky cue-list toolbar

This rule exists because the same bug shipped three times (batch-operations menu,
cue-list settings panel, color-filter menu): a popover opens fine but is covered by
a layout resizer bar.

**The trap.** `.cues-container > .cue-list-toolbar` is `position: sticky` with
`z-index: 30`, so it forms its own stacking context. The layout resizers
(`.layout-resizer`, `z-index: 50`) are outside that context, so they paint above
the whole toolbar. Any popover inside the toolbar — even `position: fixed` with a
huge `z-index` (the color-filter menu uses 1000, settings panels use 420) — is
trapped at level 30 and loses to anything at 50. `position: fixed` does not escape:
stacking contexts limit paint order, not positioning.

**The contract.**

1. A popover must not rely on its own `z-index` to beat elements outside the
   toolbar's stacking context. Its owner (toolbar / container) must be promoted
   while the popover is open.
2. Dropdowns (`.dropdown.open` inside the toolbar) are covered by one shared rule:
   `.cues-container > .cue-list-toolbar:has(.dropdown.open) { z-index: 60; }`.
   When adding a new dropdown to this toolbar, do nothing — it is covered. Do not
   add per-dropdown `:has(...)` patches; extend the shared rule only if the
   selector stops matching.
3. Settings panels (`position: fixed; z-index: 420`) use the JS helper
   `setSettingsPanelOwnerOpen`, which toggles `.settings-panel-owner-open`
   (`z-index: 80`) on the popover's scroll/grid owner (`.player-wrap`,
   `.current-cue-panel`, `.cues-container`, `.waveform-pane`). New settings panels
   must call that helper on open/close, not invent another escape hatch.
4. When a popover opens upward (space-below flip), it may extend over the resizer
   strips too; the same owner promotion is what keeps it visible. Verify new
   popovers in both flip directions next to a layout resizer before shipping.

## 7. Typography and readability

Readability is a product constraint, not optional polish.

- UI text uses `11px` or larger by default. Do not introduce `9px` or `10px`
  text for prose, labels, hints, controls, status messages, or keyboard help.
- A value below `11px` requires an explicit component-level justification and
  must be limited to compact, non-prose chrome. The current exceptions are
  `.gap-remove-unit` at `10px` for short units (`ms`, `dB`, `%`, `秒`, `°`),
  and `.waveform-row.multi-subtitle-row::before/::after` at `10px` for the
  compact `1`/`2` track badges.
- Relative units such as `em` must be checked against their inherited size;
  their computed result must not fall below `11px` unless covered by an explicit
  exception.
- `web/` is the source of truth. After changing editor CSS, regenerate
  `blank-editor.html` with `uv run python edit.py --blank`.
