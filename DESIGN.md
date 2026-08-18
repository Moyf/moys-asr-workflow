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

## 5. Launcher post-processing toolbox

The Launcher adds one compact, fixed toolbox above the action footer. It reuses the
existing Launcher tokens in `web/launcher/launcher.css`; no new color, typography,
radius, or shadow system is introduced.

### Primitives

| Primitive | Purpose | States |
|---|---|---|
| `.toolbox-fab` | Round entry point at the lower-right edge | idle, hover, focus, expanded, disabled |
| `.toolbox-drawer` | Bounded panel for one active post-processing workflow | hidden, open, busy |
| `.toolbox-tabs` | Switch between LLM, fixed replacement, and FFconcat | idle, active, focus |
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
