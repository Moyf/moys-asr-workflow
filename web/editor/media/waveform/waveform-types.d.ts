/** Shared receiver for methods installed on WaveformEditor.prototype.
 * Methods retain their source signatures; state is declared independently to
 * avoid circular inference and accidental any from dynamic descriptor copying.
 */
type DescriptorValues<D, K extends keyof D> = {
  [P in K]: D[P] extends TypedPropertyDescriptor<infer V> ? V : never;
};
type WaveformMethods =
  DescriptorValues<ReturnType<typeof import('./word-blocks.js').createWordBlocks>, 'appendWordBlocks' | 'refreshWordBlocks' | 'previewWordBlocks' | 'rebuildWordBlocksForSegment' | 'beginWordDrag' | 'updateWordDrag' | 'detachWordDrag' | 'endWordDrag' | 'cancelWordDrag'> &
  DescriptorValues<ReturnType<typeof import('./canvas.js').createWaveformModule>, 'getWaveformEnvelope' | 'drawRow'> &
  DescriptorValues<ReturnType<typeof import('./controls.js').createWaveformModule>, 'isAdjacentCueAdjustmentIndependent' | 'isSharedBoundaryHandleIndependent' | 'adjacentSnapModeStatusHint' | 'hasCueDrag' | 'bindControls'> &
  DescriptorValues<ReturnType<typeof import('./cue-blocks.js').createWaveformModule>, 'createRow' | 'appendGapBlocks' | 'appendCueBlocks' | 'isSegmentHiddenForDisplay' | 'appendSharedBoundaryZones' | 'setBindingMarker' | 'layoutBlock' | 'layoutGapBlock' | 'refreshGapOverlay' | 'bindWordModeSentenceHandle' | 'refreshCueOverlay' | 'cueDragOverlayOccupancyChanged' | 'refreshCueBlocks' | 'refreshBoundaryZones' | 'refreshCueLabel' | 'refreshExtensionCueLabel' | 'updateSelection'> &
  DescriptorValues<ReturnType<typeof import('./cue-commands.js').createWaveformModule>, 'adjustSelectedByKeyboard' | 'adjustSelectedBoundaryByKeyboard' | 'setCueBoundaryToTime' | 'snapSelectedCueBoundaryByKeyboard' | 'adjustActiveCueDragBy' | 'handleHeldCueKey' | 'snapActiveCueBoundaryByKeyboard' | 'cancelCueDrag' | 'applyIndependentBoundaryDrag'> &
  DescriptorValues<ReturnType<typeof import('./cue-drag-update.js').createWaveformModule>, 'moveCueDrag' | 'applyMoveDrag' | 'applyResizeDrag' | 'applyBoundaryDrag' | 'endCueDrag'> &
  DescriptorValues<ReturnType<typeof import('./cue-drag.js').createWaveformModule>, 'beginCueDrag' | 'isSharedBoundary' | 'beginIndependentEdgeDrag' | 'beginSharedBoundaryZoneDrag' | 'cueDragDurationMs' | 'cueTiming' | 'cueTimingDuration' | 'cueTimingValueFromMs' | 'cueTimingValueToMs' | 'formatCueTiming' | 'captureCueDragOriginals' | 'rebaseCueDragToTrack'> &
  DescriptorValues<ReturnType<typeof import('./gap-drag.js').createWaveformModule>, 'beginGapBoundaryDrag' | 'beginGapMoveDrag' | 'gapMoveTarget' | 'moveGapMoveDrag' | 'scheduleGapMovePreview' | 'clearGapMovePreview' | 'previewGapMoveDrag' | 'endGapMoveDrag' | 'refreshGapBlocks' | 'clearGapBoundaryPreview' | 'appendGapBoundaryPreview' | 'previewGapBoundaryDrag' | 'moveGapBoundaryDrag' | 'scheduleGapPreview' | 'endGapBoundaryDrag' | 'beginGapRangeDrag' | 'gapRangePointerTime' | 'clearGapRangePreviews' | 'layoutGapRangePreview' | 'moveGapRangeDrag' | 'endGapRangeDrag'> &
  DescriptorValues<ReturnType<typeof import('./input.js').createWaveformModule>, 'seekFromPointer' | 'seekFromCue' | 'beginCreateCueDrag' | 'captureRowGeometry' | 'trackAtPoint' | 'isCueTimeOccupied' | 'clampCreateCueTime' | 'beginBlockedCueCreateDrag' | 'timeFromPointer' | 'timeFromPointerUnbounded' | 'flashSplitAtTime' | 'getSplitPointAtTime' | 'timeMsAtPoint' | 'beginPlayheadDrag' | 'beginMarqueeDrag' | 'handleWheel'> &
  DescriptorValues<ReturnType<typeof import('./markers.js').createWaveformModule>, 'getMarkers' | 'appendMarkerTrack' | 'appendMarkerElement' | 'refreshMarkerOverlay' | 'openMarkerQuickEdit' | 'syncMarkerQuickEdit' | 'positionMarkerQuickEdit' | 'closeMarkerQuickEdit' | 'findMarkerRowAtClientY' | 'markerPointerGeometry' | 'markerPointerTimeMs' | '_beginMarkerPointerTracking' | '_teardownMarkerPointerTracking' | 'beginMarkerDrag' | 'beginMarkerCreateDrag' | 'moveMarkerDrag' | 'applyMarkerDragTime' | 'markerEdgeAutoScroll' | 'stopMarkerEdgeAutoScroll' | 'clearMarkerDragPreviews' | 'updateMarkerDragPreview' | 'endMarkerDrag'> &
  DescriptorValues<ReturnType<typeof import('./media.js').createWaveformModule>, 'attachPlayer' | 'setMediaAvailable' | 'setPayload' | 'getPayload' | 'setSpectralPayload' | 'setReapeaksWaveform' | 'activeWaveShape' | 'getGapRemoveDetectionData' | 'processFile' | 'waitForPlayerDuration' | 'durationMs' | 'currentTimeMs' | 'centerBasicOnCurrentTime'> &
  DescriptorValues<ReturnType<typeof import('./playback.js').createWaveformModule>, 'updatePlayback' | 'getNavigationSnapshot' | 'restoreNavigation' | 'positionPlayheads'> &
  DescriptorValues<ReturnType<typeof import('./pointer.js').createWaveformModule>, 'pointerTimeMs' | 'refreshPointerLine' | 'showPointerLine' | 'hidePointerLine' | 'isCueBoundaryDrag' | 'findVisibleWaveformRowAtPoint' | 'findVisibleWaveformRowAtY' | 'findVisibleWaveformRowForTime' | 'cueBoundaryDragTimeMs' | 'refreshBoundaryDragPointerLine' | 'restorePointerLineAfterBoundaryDrag' | 'scheduleHoverSeekPreview' | 'cancelHoverSeekPreview' | 'flushHoverSeekPreview'> &
  DescriptorValues<ReturnType<typeof import('./render.js').createWaveformModule>, 'scheduleRender' | 'scheduleMultiVisible' | 'scheduleBasicRender' | 'scheduleRefreshCueBlocks' | '_readWaveColors' | '_getWaveColors' | 'render' | 'stretchWaveformCanvases' | 'redrawWaveformCanvases' | 'renderSegments' | 'renderBasic' | 'renderMulti' | 'renderMultiVisible' | 'createMultiRow'> &
  DescriptorValues<ReturnType<typeof import('./scale-controls.js').createWaveformModule>, 'focusWaveform' | 'changeWaveformScale' | 'applyWaveformScaleSteps' | 'renderWaveformScaleLabel' | 'setLoudnessStats' | 'fitWaveformScaleToLoudness' | 'scheduleWheelScaleChange' | 'scheduleRowHeightChange' | 'updateDisabledVisibility' | 'revealTime' | 'changeZoom' | 'setStatus' | 'setSpectralColorStatus' | 'scheduleSpectralColorRender'> &
  DescriptorValues<ReturnType<typeof import('./workspace.js').createWaveformModule>, 'bindDivider' | 'bindLayoutResizers' | 'applyLayoutVariables' | 'applyLayout' | 'updateAdvancedSettingsAvailability' | 'setMode' | 'setTool' | 'getTool' | 'setLayout' | 'toggleLayoutEditMode' | 'isMultiMode' | 'getRowHeight' | 'getMaxRowHeight' | 'setRowHeight' | 'isCustomLayout' | 'isPresetResizableLayout' | 'bindDockHandles' | 'bindWorkspaceDockTarget' | 'applyLayoutDrop' | 'showLayoutDropPreview' | 'clearLayoutDropPreview' | 'ensureCustomLayoutRoot' | 'restoreDirectLayoutModules' | 'createCustomLayoutNode' | 'applyCustomSplitRatio' | 'bindCustomLayoutDivider' | 'applyCustomLayoutTree' | 'getLayoutData' | 'getLayoutHistorySnapshot' | 'recordLayoutUndo' | 'restoreLayoutHistorySnapshot' | 'resetLayout' | 'setLayoutData'>;

export type Track = 'main' | 'extension' | 'overlay';
export interface TimedItem { start: number; end: number; text?: string; start_frame?: number; end_frame?: number; }
export interface Cue extends TimedItem {
  id?: string; disabled?: boolean; items?: TimedItem[];
  color?: {name?: string; value?: string}; color_ref?: {headIdx?: number; name?: string};
  [extension: string]: unknown;
}
export interface Marker {
  id: string; type: string; time_ms?: number; start?: number; end?: number;
  name?: string; label?: string; color?: string; note?: string;
  review?: {status: string; reason?: string};
  [extension: string]: unknown;
}
export interface Gap { start: number; end: number; removed?: boolean; protected?: boolean; [extension: string]: unknown; }
export interface RowGeometry { left: number; width: number; startMs: number; endMs: number; }
export interface PointerPosition { clientX: number; clientY: number; }
export interface LayoutTree {
  type: 'split' | 'module'; id?: string; direction?: 'row' | 'column'; ratio?: number; children?: LayoutTree[];
}
export interface WaveformSettings {
  mode: string; layout: string; visibleSeconds: number; secondsPerRow: number;
  rowHeight: number; side: string; splitPercent: number; layoutColumnPercent: number;
  layoutRows: number[]; layoutTree: LayoutTree; layoutEditing: boolean;
  waveformScale: number; waveformScaleAuto: boolean; disabledDisplay: string;
  showGroupBadges: boolean; dragPlayhead: boolean; spectralColor: boolean;
}
export interface Payload {
  schema: string; encoding: string; duration_ms: number; data: string;
  peaks_per_second?: number; sample_rate?: number; division?: number; peak_count?: number;
  source?: {name: string; size: number; modified_ms: number};
}
export interface Clock {
  unit: string; fps: number; minDuration: number; snapThreshold: number;
  round(value: number): number; getStart(cue: Cue): number; getEnd(cue: Cue): number;
  setStart(cue: Cue, value: number): void; setEnd(cue: Cue, value: number): void;
  getItemStart(item: TimedItem): number; getItemEnd(item: TimedItem): number;
  setItemStart(item: TimedItem, value: number): void; setItemEnd(item: TimedItem, value: number): void;
  fromMs(value: number): number; toMs(value: number): number; format(value: number): string;
}
export interface WaveformRow extends HTMLDivElement { _waveformPlayhead?: HTMLDivElement; }
export interface WaveformPointerMarker extends HTMLDivElement { _hideTimer?: number; }
// The existing renderer assigns disabled to these div-based resizers.
export interface LayoutDivider extends HTMLDivElement { disabled?: boolean; }
export interface CueDragState {
  rangeMs?: number; rowWidth?: number; commitIndices?: Set<number>;
  started?: boolean; changed?: boolean; independent?: boolean;
  shiftOverlay?: boolean; shiftRangeSelect?: boolean; altToggleDisabledOnClick?: boolean;
  seekedOnPointerDown?: boolean; captureTarget?: HTMLElement;
  sharedBoundaryZone?: boolean; previewRowIndex?: number; edge?: string; dragIndex?: number;
  pointerId: number; startClientX: number; currentClientX?: number; startClientY?: number;
  lastPointerPosition?: PointerPosition; lastEvent?: PointerEvent; row: HTMLElement;
  geometry?: RowGeometry; kind?: string; track: string; index?: number; boundaryIndex?: number;
  indices?: number[]; originals?: Map<number, Cue>; cancelOriginals?: Map<number, Cue>;
  allOriginals?: Map<number, Cue>; timing?: Clock; startPointerTime?: number;
  moved?: boolean; frame?: number; previewFrame?: number; altKey?: boolean;
  shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; trackChanged?: boolean;
  convertedToOverlay?: boolean; squeezeOriginals?: Map<number, Cue>; allowSqueeze?: boolean;
}
export interface CueCreateState {
  pointerId: number; row: HTMLElement; geometry: RowGeometry; startMs: number;
  currentMs: number; startClientX: number; startClientY: number;
  lastEvent: PointerEvent; preview: HTMLElement | null; frame: number;
  finish: ((cancelled?: boolean) => void) | null;
}
export interface MarkerDragState {
  pointerId: number; mode: string; row: HTMLElement; captureTarget: HTMLElement;
  startClientX: number; startClientY: number; moved: boolean; frame: number;
  lastEvent: PointerEvent | null; markerId?: string; original?: Marker; pending?: Marker;
  pointerStartMs?: number; startMs?: number; endMs?: number;
}
export interface GapDragState {
  pointerId: number; row: HTMLElement; startClientX: number; startClientY?: number;
  moved?: boolean; frame?: number; lastEvent?: PointerEvent; geometry?: RowGeometry;
  index?: number; startMs?: number; endMs?: number; original?: Gap;
  originalGaps?: Gap[]; nextGaps?: Gap[]; captureTarget?: HTMLElement;
  changed?: boolean; targetGap?: Gap; deltaMs?: number; startPointerMs?: number;
  edge?: string; mode?: string; valueMs?: number; removed?: boolean; previews?: HTMLElement[];
}
export interface NavigationSnapshot {
  cueListScrollTop?: number; waveformTopEdgeMs?: number;
}
export interface WaveformOptions {
  wordTiming?: {
    readonly enabled: boolean;
    getSelection(segment: Cue): ReadonlySet<number>;
    select(index: number, itemIndex: number, event?: Partial<PointerEvent>): void;
    showMenu(x: number, y: number, index: number, itemIndex: number): void;
    previewItems(segment: Cue, items: TimedItem[]): void;
    clearSelection(): void;
  };
  beginWordEdit?(): EditorTransaction;
  commitWordEdit?(command: EditorTransaction, segment: Cue): boolean;
  getSegments(track?: string): Cue[];
  getSelection(track?: string): ReadonlySet<number>;
  selectCue(index: number): void;
  getExtensionSegments?(trackId?: string | null): Cue[];
  getExtensionSelection?(): ReadonlySet<number>;
  getOverlaySelection?(): ReadonlySet<number>;
  getGapRemoveGaps?(): Gap[];
  getMarkers?(): Marker[];
  getCueTiming?(): Partial<Clock>;
  getBindingMarkerTargets?(): {main?: ReadonlySet<number>; extension?: ReadonlySet<number>};
  getCrossTrackSnapTargets?(track?: string): number[];
  getWaveShapeSource?(): string;
  getAutoSnapAdjacentCues?(): boolean;
  getAdjacentBoundaryMode?(): string;
  getGapOperationMode?(): string;
  getClickBehavior?(): string;
  getClickTarget?(): string;
  multiSubtitleVisible?(): boolean;
  showTrackBadges?(): boolean;
  getOverlayCreateEnabled?(): boolean;
  getHideDisabled?(): boolean;
  getSnapToFrame?(): boolean;
  getHoverSeekPreview?(): boolean;
  isPlaybackActive?(): boolean;
  convertCueToOverlay?(index: number): number | null;
  convertOverlayCueToMainDrag?(index: number): number | null;
  resizeGapBoundary?(...args: unknown[]): Gap[] | null;
  onCueCreateRejected?(...args: unknown[]): void;
  clearSelection?(...args: unknown[]): void;
  togglePlayback?(...args: unknown[]): void;
  showBlankWaveformMenu?(...args: unknown[]): void;
  toggleGapRemoved?(...args: unknown[]): void;
  previewGapAt?(...args: unknown[]): void;
  seek?(...args: unknown[]): void;
  showGapContextMenu?(...args: unknown[]): void;
  showContextMenu?(...args: unknown[]): void;
  enterCueEditor?(...args: unknown[]): void;
  activateCue?(...args: unknown[]): void;
  showOverlayContextMenu?(...args: unknown[]): void;
  enterOverlayCueEditor?(...args: unknown[]): void;
  showExtensionContextMenu?(...args: unknown[]): void;
  enterExtensionCueEditor?(...args: unknown[]): void;
  activateExtensionCue?(...args: unknown[]): void;
  onBeginEdit?(...args: unknown[]): void;
  onCommitEdit?(...args: unknown[]): void;
  syncBoundCueDrag?(...args: unknown[]): void;
  onCancelEdit?(...args: unknown[]): void;
  selectOverlayRange?(...args: unknown[]): void;
  selectCueRange?(...args: unknown[]): void;
  toggleDisabled?(...args: unknown[]): void;
  splitOverlayCueAtTime?(...args: unknown[]): void;
  splitCueAtTime?(...args: unknown[]): void;
  toggleExtensionSelection?(...args: unknown[]): void;
  toggleOverlaySelection?(...args: unknown[]): void;
  toggleCueSelection?(...args: unknown[]): void;
  selectExtensionRange?(...args: unknown[]): void;
  selectExtensionCue?(...args: unknown[]): void;
  selectOverlayCue?(...args: unknown[]): void;
  activateOverlayCue?(...args: unknown[]): void;
  addExtensionSelection?(...args: unknown[]): void;
  addCueSelection?(...args: unknown[]): void;
  copyGap?(...args: unknown[]): void;
  moveGap?(...args: unknown[]): void;
  applyGapRange?(...args: unknown[]): void;
  addCueRange?(...args: unknown[]): void;
  onPlayheadDragStateChange?(...args: unknown[]): void;
  onMarkerQuickEditFields?(...args: unknown[]): void;
  onMarkerQuickEditDelete?(...args: unknown[]): void;
  onMarkerCreateRegion?(...args: unknown[]): void;
  onMarkerAdd?(...args: unknown[]): void;
  onMarkerMove?(...args: unknown[]): void;
  onMarkerResize?(...args: unknown[]): void;
  onPayload?(...args: unknown[]): void;
  onLayoutUndo?(...args: unknown[]): void;
}

export interface WaveformState {
  wordDrag: WordDragState | null;
  wordRefreshFrame: number;
  options: WaveformOptions;
  settings: WaveformSettings;
  payload: Payload | null;
  peaks: Int8Array | Float32Array | null;
  spectral: ReturnType<ReturnType<typeof import('./payload.js').createWaveformModule>['decodeSpectralPayload']>;
  reapeaksPayload: Payload | null;
  reapeaksPeaks: Int8Array | Float32Array | null;
  loudnessStats: {schema: string; input_i?: number; input_tp?: number; [metric: string]: unknown} | null;
  player: HTMLMediaElement | null;
  mediaAvailable: boolean; spectralColorBusy: boolean; spectralColorRenderToken: number;
  basicWindowStartMs: number; manualFollowUntil: number; multiRange: number[];
  activeIndex: number; activeExtensionIndex: number; activeOverlayIndex: number;
  activeVisualHit: boolean; activeExtensionVisualHit: boolean; activeOverlayVisualHit: boolean;
  drag: CueDragState | null; createCueDrag: CueCreateState | null;
  gapRangeDrag: GapDragState | null; gapBoundaryDrag: GapDragState | null; gapMoveDrag: GapDragState | null;
  gapMovePreviewFrame: number; gapPreviewFrame: number; suppressGapClickUntil: number;
  autoScrolling: boolean; autoScrollTarget: number | null; navigationRestoring: boolean;
  multiFollowRowIndex: number; multiFollowCheckPending: boolean;
  resizeFrame: number; multiVisibleFrame: number; basicRenderFrame: number; cueRefreshFrame: number;
  hoverSeekPreviewFrame: number; hoverSeekPreviewLastEvent: PointerEvent | null;
  hoverSeekPreviewRow: HTMLElement | null; pointerLineEvent: Pick<PointerEvent, 'clientX'> | null;
  pointerLineRow: WaveformRow | null; pointerLineMarker: WaveformPointerMarker | null;
  pointerLineOverrideActive: boolean; playheadDragActive: boolean;
  pendingScaleDirection: number; scaleDebounceTimer: number;
  pendingRowHeightDirection: number; rowHeightDebounceTimer: number;
  renderedRows: WaveformRow[]; tool: string;
  workspace: HTMLElement; panel: HTMLElement; playerWrap: HTMLElement; cues: HTMLElement;
  pane: HTMLElement; scroll: HTMLElement; content: HTMLElement; empty: HTMLElement; status: HTMLElement;
  spectralColorStatus: HTMLElement; divider: LayoutDivider; secondaryDivider: LayoutDivider;
  windowLabel: HTMLElement; waveformScaleLabel: HTMLElement;
  waveformScaleDownButton: HTMLButtonElement; waveformScaleUpButton: HTMLButtonElement; waveformScaleFitButton: HTMLButtonElement;
  secondsPerRowSelect: HTMLSelectElement; rowHeightSelect: HTMLSelectElement;
  showGroupBadgesToggle: HTMLInputElement; dragPlayheadToggle: HTMLInputElement; spectralColorToggle: HTMLInputElement;
  sideSelect: HTMLSelectElement; disabledDisplaySelect: HTMLSelectElement;
  layoutEditToggle: HTMLInputElement; layoutResetButton: HTMLButtonElement; layoutPreview: HTMLElement;
  layoutResizers: {column: HTMLElement; rowTop: HTMLElement; rowMiddle: HTMLElement};
  _onPlayerTime: () => void; _onResize: () => void; resizeObserver: ResizeObserver;
  _dragMove: (event: PointerEvent) => void; _dragEnd: (event: PointerEvent) => void;
  _gapBoundaryMove: (event: PointerEvent) => void; _gapBoundaryEnd: (event: PointerEvent) => void;
  _gapMoveMove: (event: PointerEvent) => void; _gapMoveEnd: (event: PointerEvent) => void;
  _gapRangeMove: (event: PointerEvent) => void; _gapRangeEnd: (event: PointerEvent) => void;
  markerQuickEdit: {markerId: string; element: HTMLElement} | null;
  _markerQuickEditOutside: ((event: PointerEvent) => void) | null;
  _markerQuickEditKey: ((event: KeyboardEvent) => void) | null;
  markerDrag: MarkerDragState | null; markerCreateDrag: MarkerDragState | null;
  _markerDragMove: (event: PointerEvent) => void; _markerDragEnd: (event: PointerEvent) => void;
  markerEdgeScrollDirection: number; markerEdgeScrollFrame: number;
  pendingNavigation: NavigationSnapshot | null;
  _waveColors: {rowBg: string; rowBorder: string; rowGrid: string; rowTick: string; peak: string; peakDim: string};
  layoutDragging: boolean; layoutDragSource: string | null;
  layoutDropIntent: {mode?: string; kind?: string; targetId?: string; sourceId: string; edge?: string; direction?: string; ratio?: number} | null;
  customLayoutRoot: HTMLElement | null; renderedCustomLayoutTree: LayoutTree | null;
}
export type WaveformInstance = WaveformState & WaveformMethods;

export interface WordDragState {
  pointerId: number; segment: Cue; timing: Clock; row: HTMLElement;
  geometry: RowGeometry; pointer: number; clientX: number; clientY: number;
  moved: boolean; command: EditorTransaction | null; original: Cue;
  indices: number[]; resize: boolean; edge: string; seam: boolean; itemIndex: number;
  move?: (event: PointerEvent) => void; up?: (event: PointerEvent) => void; cancel?: () => void;
}
