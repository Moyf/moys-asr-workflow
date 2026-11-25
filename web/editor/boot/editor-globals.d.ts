// Types shared by Editor modules and browser capabilities used by the host.
// Template placeholders are replaced by the Server renderer before boot.
// Keep project data types in sync with docs/engineering/JSON_SCHEMA.md.

declare const __DATA_JSON__: ProjectData;

declare const __FILENAME_BASE_JSON__: string;
declare const __UI_LANGUAGE_JSON__: string | null;
declare const __STICKERS_JSON__: any[];
declare const __STICKER_ROOT_JSON__: string;
declare const __STICKER_URL_PREFIX_JSON__: string;
declare const __SERVER_CONFIG_JSON__: any;

/** 毫秒整数。工程契约：tracks[*].segments[*].start/end 必须为整数毫秒。 */
type Milliseconds = number;

interface ProjectSegmentItem {
  start: Milliseconds;
  end: Milliseconds;
  text?: string;
}

interface AssCueOverride { pos?: { x: number; y: number }; scale?: number; }
/** 运行时颜色标记：head 持完整 color，成员持 color_ref（仅 name + headIdx）。 */
interface ProjectColorMark { name: string; value?: string | null; start?: number; end?: number; }
interface ProjectGroupRef { name: string; headIdx: number; }
interface ProjectSegment {
  id: string;
  start: Milliseconds;
  end: Milliseconds;
  text: string;
  disabled?: boolean;
  speaker?: string | null;
  assOverride?: AssCueOverride;
  color_group_id?: string;
  sticker_group_id?: string;
  assStyle?: Record<string, any>;
  _dirty?: boolean;
  items?: ProjectSegmentItem[];
}

interface ProjectTrack {
  id: string;
  role: 'main' | 'secondary' | 'overlay';
  name: string;
  enabled: boolean;
  segments: ProjectSegment[];
  style?: { font_default?: boolean; [key: string]: any };
  language?: string;
  language_source?: string;
  split_mode?: string;
  split_mode_override?: string;
  timestamp_granularity?: string;
  model?: string;
  preserve_punctuation?: boolean;
  source_name?: string;
}

interface ProjectBinding {
  id: string;
  source: { track_id: string; segment_id: string };
  target: { track_id: string; segment_id: string };
  start_offset_ms: Milliseconds;
  end_offset_ms: Milliseconds;
}

interface ProjectMediaMetadata {
  video_fps?: number;
  video_fps_ratio?: string;
  video_width?: number;
  video_height?: number;
  selected_audio_track?: number;
  audio_tracks?: Array<Record<string, unknown>>;
}

interface ProjectWaveformInfo {
  duration_ms?: number;
  [key: string]: unknown;
}

/** 叠加轨：与主轨同构的独立段列表（JSON_SCHEMA.md overlay_track）。 */
interface ProjectOverlayTrack {
  id?: string;
  enabled?: boolean;
  segments?: ProjectSegment[];
  /** 运行时脏标记，不进工程 JSON。 */
  _dirty?: boolean;
}

interface ProjectData {
  schema: 'moy.asr.project.v2';
  speakers: Array<{ id: string; name: string; color: string }>;
  annotation_mode?: 'color' | 'speaker';
  palette_size?: 5 | 9;
  speaker_shortcuts?: Record<string, string>;
  tracks: ProjectTrack[];
  styles?: Array<Record<string, unknown>>;
  bindings: ProjectBinding[];
  bilingual: { display_mode: string; active_track_id?: string };
  subtitle_groups?: {
    next_id: number;
    color: Array<{ id: string; value: Record<string, unknown> }>;
    sticker: Array<{ id: string; value: Record<string, unknown> }>;
  };
  media?: string;
  timed_text_edit_view?: 'rows' | 'single';
  media_metadata?: ProjectMediaMetadata;
  audio_processing?: { gain_db: number; target_lufs: number; peak_ceiling_dbtp: number };
  timebase?: Record<string, unknown>;
  sticker_root?: string;
  waveform?: ProjectWaveformInfo;
  gap_remove?: unknown;
  script_alignment?: unknown;
  workspace?: unknown;
  preview?: Record<string, unknown>;
}

// 冻结门面契约：模块通过 global.MaweXxx = Object.freeze({...}) 挂载，
// 消费方经 window.MaweXxx 访问。访问器对（get/set）在接口上声明为普通
// 可写属性；浅冻结的普通属性声明为 readonly（内层对象仍共享可变）。

interface MaweBootApi {
  readonly DATA: ProjectData;
  FILENAME_BASE: string;
  PROJECT_NAME: string;
  readonly STICKERS: any[];
  STICKER_ROOT: string;
  STICKER_URL_PREFIX: string;
  readonly SERVER_CONFIG: any;
  readonly NINJA_SFX_BASE_URL: string;
  readonly MAWE_DEBUG_ENABLED: boolean;
  maweDebug(stage: string, details?: Record<string, unknown>): void;
  maweDomContractCheck(): string[];
}

interface MaweExportSrtApi {
  cleanupSegments: (segments: ProjectSegment[]) => ProjectSegment[];
  cleanupMainSegments: () => ProjectSegment[];
  cleanupPreviewSegment: (segment: ProjectSegment) => ProjectSegment;
  setCleanupProjectionCacheEnabled: (enabled: boolean) => void;
  isCleanupProjectionCacheEnabled: () => boolean;
  currentAssVideoResolution: any;
  assExportOptions: any;
  buildAss: any;
  buildExtensionSrt: any;
  /** 去空隙 SRT：必须走 buildSrtPayload + mapGapRemovedTime + 正时长保护（PR #136 评审 P1） */
  buildGapRemovedSrt: () => string;
  buildGapRemovedAss: any;
  usedSubtitleColors: any;
  updateSubtitleExportUi: any;
  safeColorExportFilenameSuffix: any;
  colorExportFilenameSuffix: any;
  EXPORT_KEEP_DISABLED_PLACEHOLDER: boolean;
  /** 主轨道 SRT 文本 */
  buildSrt: () => string;
  downloadColorSrts: any;
  gapRemovedExportContext: any;
  buildDynamicCaptionExportData: any;
  gapRemovedMediaReference: any;
  buildGapRemovedFfconcat: any;
  buildGapRemovedRegionsJson: any;
}

declare const __NINJA_SFX_BASE_URL_JSON__: string;

// Replaceable browser/desktop capabilities used by editor I/O.
interface MaweHostApi {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  files: {
    hasSavePicker(): boolean;
    pickSaveFile(options: object): Promise<FileSystemFileHandle>;
    writeBlob(handle: FileSystemFileHandle, buildBlob: () => Blob): Promise<void>;
    downloadBlob(blob: Blob, filename: string): void;
  };
  server: { fetch(url: string | URL, options?: RequestInit): Promise<Response> };
  runtime: { getNavigator(): Navigator | undefined; hasUserActivation(): boolean };
}

type SelectionTrack = 'main' | 'extension' | 'overlay';
interface CueRef { track_id: string; segment_id: string; }
interface SelectionSnapshot { refs: CueRef[]; current: CueRef | null; anchors: Record<SelectionTrack, CueRef | null>; }
interface SelectionIndices extends Iterable<number> {
  readonly size: number;
  has(index: number): boolean;
  values(): IterableIterator<number>;
  keys(): IterableIterator<number>;
  entries(): IterableIterator<[number, number]>;
  forEach(callback: (index: number, key: number, view: SelectionIndices) => void, receiver?: unknown): void;
}
interface MaweStateApi {
  readonly project: ProjectData;
  readonly selection: {
    mainAnchor: number; extensionAnchor: number; overlayAnchor: number;
    indices(kind: SelectionTrack): SelectionIndices;
    add(kind: SelectionTrack, index: number, options?: { activate?: boolean }): void;
    addRef(ref: CueRef, options?: { activate?: boolean }): void;
    activateRef(ref: CueRef): void;
    removeRef(ref: CueRef): boolean;
    replaceRefs(refs: Iterable<CueRef>, active?: CueRef | null): void;
    getSelectedCueRefs(): CueRef[];
    getCurrentCueRef(): CueRef | null;
    getCurrentTrack(): ProjectTrack | null;
    snapshot(): SelectionSnapshot;
    restore(snapshot: SelectionSnapshot): void;
    remove(kind: SelectionTrack, index: number): boolean;
    clear(kind: SelectionTrack): void;
    replace(kind: SelectionTrack, indices: Iterable<number>): void;
    removeAndShift(kind: SelectionTrack, removedIndex: number): { wasSelected: boolean; nextAnchor: number };
    anchor(kind: SelectionTrack): number;
    setAnchor(kind: SelectionTrack, index: number): void;
    reset(): void;
  };
  readonly preferences: { editor: Record<string, unknown> };
  readonly runtime: { player: HTMLMediaElement | null; waveformEditor: any;
    playbackFrameId: number; playbackFramePlayer: HTMLMediaElement | null; waveformLoadedFromProject: boolean };
  readonly panel: { gapPreviewRange: any; gapRemovePanelDrag: any;
    currentCuePanelIdx: number; currentCuePanelKind: SelectionTrack; currentCuePanelTrackId: string | null;
    cuePanelUndoPushed: boolean; cuePanelUndoRecord: any; cuePanelTextEditSnapshot: any; cuePanelCanceling: boolean };
  readonly editing: { editingState: any; extensionEditingState: any };
  readonly changes: { projectImportDirty: boolean; gapRemoveDirty: boolean; previewGeometryDirty: boolean; audioProcessingDirty: boolean; processingOverridesDirty: boolean };
  hasProjectChanges(pendingText?: boolean): boolean;
  readonly projectEpoch: number;
  readonly projectLoadGeneration: number;
  readonly projectLoadPending: boolean;
  projectFingerprint(value?: any): string;
  persistenceSnapshot(value: any): any;
  setSnapshotReader(reader: () => any): void;
  beginProjectSession(): void;
  establishProjectCheckpoint(options?: { repaired?: boolean }): void;
  includeProjectStyleDefaults(applyDefaults: (project: any) => boolean): void;
  rememberSessionHighlights(): void;
  restoreSessionHighlights(): void;
  segmentsFingerprint(): string;
  noteSavedSegments(fingerprint?: string): void;
  markSaved(): void;
  reconcileSegmentsDirty(): void;
  markProjectDirty(): void;
  getProjectDirtyEpoch(): number;
  onProjectDirtyChange(listener: (epoch: number) => void): () => void;
}

interface ViewInvalidation {
  cueList?: boolean; waveform?: 'none' | 'overlay' | 'full'; preserveCueListScroll?: boolean; cueListAnchor?: unknown;
  cueListPatch?: { mainIndices?: readonly number[]; overlayIndices?: readonly number[] } | null;
  preview?: false | 'update' | 'refresh'; save?: boolean;
}
interface EditorTransaction {
  commit(invalidation?: ViewInvalidation): boolean;
  cancel(): boolean;
  discard(): void;
}
interface MaweCommandsApi {
  begin(label: string, options?: { captureView?: boolean }): EditorTransaction;
  run<T>(label: string, mutate: (command: EditorTransaction) => T,
    options?: { captureView?: boolean; invalidate?: ViewInvalidation }): T;
  onBeforeBegin(listener: (label: string, options: { captureView?: boolean }) => void): () => boolean;
}

interface Window {
  showSaveFilePicker?: (options?: object) => Promise<FileSystemFileHandle>;
  queryLocalFonts?: () => Promise<Array<{ family: string; postscriptName: string; fullName: string; style: string }>>;
  webkitAudioContext?: typeof AudioContext;
}

interface Permissions {
  query(descriptor: { name: 'local-fonts' }): Promise<PermissionStatus>;
}
