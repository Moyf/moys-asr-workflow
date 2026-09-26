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
declare const __FILENAME_BASE_JSON__: string;
declare const __STICKERS_JSON__: any[];
declare const __STICKER_ROOT_JSON__: string;
declare const __STICKER_URL_PREFIX_JSON__: string;
declare const __SERVER_CONFIG_JSON__: any;

/** 毫秒整数。JSON_SCHEMA.md：segments[*].start/end 必须为整数毫秒。 */
type Milliseconds = number;

interface ProjectSegmentItem {
  start: Milliseconds;
  end: Milliseconds;
  text?: string;
}

interface ProjectSegment {
  start: Milliseconds;
  end: Milliseconds;
  text: string;
  disabled?: boolean;
  speaker?: string;
  color?: string;
  items?: ProjectSegmentItem[];
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

interface ProjectData {
  schema?: string;
  segments: ProjectSegment[];
  media?: string;
  language?: string;
  language_source?: string;
  split_mode?: string;
  timestamp_granularity?: string;
  model?: string;
  media_metadata?: ProjectMediaMetadata;
  timebase?: Record<string, unknown>;
  sticker_root?: string;
  waveform?: ProjectWaveformInfo;
  gap_remove?: unknown;
  script_alignment?: unknown;
  workspace?: unknown;
  preview?: Record<string, unknown>;
  overlay_track?: unknown;
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
declare const ASS_STYLE_LIBRARY: any;
declare const mergedExportSegments: any;
declare const activeExtensionSegments: any;

interface Window {
  AsrEditorUtils: any;
  MAWE_I18N: any;
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
