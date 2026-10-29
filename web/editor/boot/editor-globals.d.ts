// editor-globals.d.ts：编辑器脚本体系的共享类型契约（仅类型检查用，绝不进
// editor-scripts.txt 清单，对运行时与三个消费者零影响）。
//
// 为什么放 d.ts 而不是各模块 JSDoc：清单组装的脚本是经典脚本（无
// import/export），JSDoc typedef 不跨文件传播；d.ts 的声明天然是全局的，
// 所有被 typecheck 编译的模块共享同一契约。工程 JSON 形状与 JSON_SCHEMA.md
// 对应，修改 schema 时两处必须同步。
//
// 模板占位符由 edit.py / server-editor 在装配时注入真实 JSON。

declare const __DATA_JSON__: ProjectData;

interface Window {
  MaweAssCanvas: {
    measureRun(style: any, nativeFontSize: number, run: any, text: string): { width: number; ascent: number; descent: number };
    clearCaches(): void;
    render(payload: any): void;
    hide(): void;
    readonly lastRender: any;
  };
}
declare const __FILENAME_BASE_JSON__: string;
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
  speaker?: string;
  assOverride?: AssCueOverride;
  color_group_id?: string;
  sticker_group_id?: string;
  _dirty?: boolean;
  items?: ProjectSegmentItem[];
}

interface ProjectTrack {
  id: string;
  role: 'main' | 'secondary' | 'overlay';
  name: string;
  enabled: boolean;
  segments: ProjectSegment[];
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
  tracks: ProjectTrack[];
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
  cleanupMainSegments: () => ProjectSegment[];
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

// 裸名访问（经典脚本里 window.X 与裸名 X 同源）：已标注门面给出真实契约。
// 用 var 而非 const：var 声明会并入 typeof globalThis，IIFE 参数的
// Window & typeof globalThis 交叉类型两侧行都能拿到属性。
declare var MaweBoot: MaweBootApi;
declare var MaweExportSrt: MaweExportSrtApi;

// 浏览器与 Node/便携环境共用的全局挂载点。
interface Window {
  MaweBoot: MaweBootApi;
  MaweExportSrt: MaweExportSrtApi;
}

// === 未标注门面/跨模块符号的占位（any） ===
// 这些符号由其他模块或入口声明；本试点只为 MaweBoot / MaweExportSrt 建立真实
// 契约，其余以 any 占位消除跨文件噪音。升级方式：为对应模块写 xxxApi 接口 +
// declare const Xxx: XxxApi，随后从本占位区移除。
declare const __NINJA_SFX_BASE_URL_JSON__: string;
declare const exportColorContextResolver: any;
declare const MaweSettings: any;
declare const MaweHint: any;
declare const MaweSpeakerLabels: any;
declare const MaweCueElements: any;
declare const MaweInlineEdit: any;
declare const MaweGapRemoveData: any;
declare const MaweCoreState: any;
declare const MaweExportTimeline: any;
declare const MaweAppearance: any;
declare const MaweTimeline: any;
declare const MaweColors: any;
declare const MaweDom: any;
declare const MaweMultiSubtitleCore: any;
declare const MaweSegmentOps: any;
declare const MaweSelection: any;
declare const MaweContextMenus: any;
declare const MaweColorFilter: any;
declare const MaweCuePanelState: any;
declare const ASS_STYLE_LIBRARY: any;
declare const mergedExportSegments: any;
declare const aiCleanupExportSegments: any;
declare const activeExtensionSegments: any;

// G07 领域门面（init 化接线文件挂载，window 与裸名同源）；契约仍以 any
// 占位，升级方式同上。
interface Window {
  MaweExportContext: any;
  MaweCuePanelWiring: any;
  MaweOverlaySplitMerge: any;
  MaweAssStorageWiring: any;
  MaweAssManagerWiring: any;
  MaweKeyboardGuards: any;
  MaweStickerPreviewWiring: any;
  MaweInitialConfigWiring: any;
  MaweAssPreview: any;
  MaweGapRemovedMediaExport: any;
  MaweDomPanelsWiring: any;
  MaweContextMenusWiring: any;
  MaweDisplaySettings: any;
  MaweContextMenus: any;
}

interface Window {
  AsrEditorUtils: any;
  MAWE_I18N: any;
  MaweMarkersPanel?: {
    createAiCleanupReviewMuteButton?: (markerId: string) => HTMLButtonElement;
    updateAiCleanupReviewMuteButton?: (button: HTMLElement, markerId: string) => void;
    updateAiCleanupReviewStatusButton?: (button: HTMLElement, marker: any) => void;
    refreshAiCleanupReviewMuteButtons?: () => void;
  };
  ASR_EDITOR_PALETTE?: Array<{ name: string; value: string }>;
  // 服务端 ASS 字体别名表门面（editor-wiring-ass-font-aliases.js 注入）；
  // 便携模式/旧服务器下不存在，消费点按可选访问降级。
  MaweAssFontAliases?: any;
  showSaveFilePicker?: any;
}

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
declare var MaweHost: MaweHostApi;
interface Window { MaweHost: MaweHostApi; }

type SelectionTrack = 'main' | 'extension' | 'overlay';
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
    add(kind: SelectionTrack, index: number): void;
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
  readonly changes: { projectImportDirty: boolean; gapRemoveDirty: boolean; previewGeometryDirty: boolean; audioProcessingDirty: boolean };
  hasProjectChanges(pendingText?: boolean): boolean;
  readonly projectEpoch: number;
  projectFingerprint(value?: any): string;
  persistenceSnapshot(value: any): any;
  setSnapshotReader(reader: () => any): void;
  beginProjectSession(): void;
  establishProjectCheckpoint(options?: { repaired?: boolean }): void;
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
declare var MaweState: MaweStateApi;
interface Window {
  MaweState: MaweStateApi;
  MAWE: { register(name: string, factory: (...args: any[]) => unknown): void; resolve(name: string, ...args: any[]): any };
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
declare var MaweCommands: MaweCommandsApi;
declare var MaweViewUpdates: { invalidate(options?: ViewInvalidation): void };
declare const MaweHistory: any;
declare const MaweCuePanel: any;
declare const MaweCueListAnchor: any;
declare const MawePlaybackLoop: any;
declare const MaweServerSave: any;
interface Window {
  MaweCommands: MaweCommandsApi;
  MaweViewUpdates: typeof MaweViewUpdates;
  MaweMarkerEditing?: { isEditingEnabled(): boolean };
  MaweAssFrame?: { notifyProjectChanged?(): void };
  webkitAudioContext?: typeof AudioContext;
  AsrGapRemoveCore: {
    projectCleanupRetainedSegments(segments: ProjectSegment[], gapRemove: unknown): ProjectSegment[];
    getCleanupScopeItems(segment: ProjectSegment, gap: unknown): ProjectSegmentItem[];
    isGapRemoveDisplayProtected(gap: import('../media/waveform/waveform-types.js').Gap): boolean;
  };
}
