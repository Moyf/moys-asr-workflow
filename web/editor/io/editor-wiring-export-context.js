
// === 下载 ===
// 程序内开关（不暴露 GUI）：导出 SRT 时保留禁用项的时间轴序号但内容替换为空白




// 合并导出池：主轨 + 叠加轨按 start 归并。叠加段的 color_ref 指向叠加轨
// 自身数组，不能在合并后的大数组里按下标解析，因此同时返回归属集合，
// 由 colorContextResolver 提供每条段的颜色/说话人解析上下文。
function mergedExportSegments() {
  const overlaySegments = overlayTrackVisible() ? (getOverlayTrack()?.segments || []) : [];
  if (!overlaySegments.length) {
    return { segments: MaweBoot.DATA.segments, overlaySet: new Set(), overlaySegments };
  }
  return {
    segments: MULTI_SUBTITLE_UTILS.mergeMainAndOverlaySegments(MaweBoot.DATA.segments, overlaySegments),
    overlaySet: new Set(overlaySegments),
    overlaySegments,
  };
}

function exportColorContextResolver(overlaySet, overlaySegments) {
  return (segment) => (overlaySet.has(segment) ? overlaySegments : MaweBoot.DATA.segments);
}































const CANONICAL_PROJECT_FIELDS = new Set([
  'schema', 'media', 'language', 'language_source', 'split_mode', 'timestamp_granularity',
  'model', 'sticker_root', 'timebase', 'segments', 'multi_subtitle', 'overlay_track', 'waveform',
  'media_metadata', 'media_time_reference', 'spectral', 'waveform_reapeaks', 'loudness',
  'gap_remove', 'script_alignment', 'workspace', 'preview',
]);
let projectExtensionFields = Object.fromEntries(
  Object.entries(MaweBoot.DATA).filter(([key]) => !CANONICAL_PROJECT_FIELDS.has(key)),
);



// 保存/导出前的最后一道时间码兜底。波形拖动会把词时间码按像素取整，
// 极短词可能因此出现 1ms 的前后重叠；打开工程时的修复不足以覆盖这种
// “打开后编辑、随后保存”的路径。主轨和所有副字幕轨统一使用同一规则。
















































// 叠加字幕独立轨道：每段一个 Gap 承载 Marker（OTIO 没有文本轨原语，
// 与主轨字幕的 clip 标记同构但互不混写；颜色按叠加轨自身数组解析）。
// 标记时间沿用主轨标记的绝对媒体坐标约定。
function buildOverlaySubtitleOtioTrack(overlaySegments, intervals, sourceStartFrame) {
  const children = intervals.map((interval, index) => ({
    OTIO_SCHEMA: 'Gap.1',
    metadata: { moy: { asr_track: 'overlay', interval_index: index } },
    name: '',
    source_range: MaweExportTimeline.otioTimeRange(
      0,
      Math.max(1, MaweExportTimeline.msToOtioFrames(interval.end) - MaweExportTimeline.msToOtioFrames(interval.start)),
    ),
    effects: [],
    markers: MaweExportTimeline.buildGapRemovedSubtitleMarkers(interval, sourceStartFrame, overlaySegments, overlaySegments),
    enabled: true,
    color: null,
    })).filter((gap) => gap.markers.length > 0 || gap.source_range.duration.value > 1);
  return {
    OTIO_SCHEMA: 'Track.1',
    metadata: { moy: { asr_track: 'overlay' } },
    name: '叠加字幕',
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    color: null,
    children,
    kind: 'Video',
  };
}











// 收集表情包条目；当传入 removed gaps 时，把每条表情包的时间映射到去空隙后的时间线，
// 并跳过完全落在空隙内、映射后时长归零的条目。removed 为空数组时退化为原始时间线。
// 表情包必须有真实磁盘路径（服务器 OTIO/OTIOZ 均按 sticker_rel 读盘）。


// 把表情包条目构建为一条可放进任意时间线 Stack 的单层视频轨（Gap 填充 + 图片 Clip）。
// stickers 会被就地排序；时间重叠时返回 { error }，由调用方决定中止还是跳过。
// 主轨与叠加轨各建一条轨，轨道名由调用方传入。






// OTIOZ 打包：前端把 timeline 交给服务器，服务器读盘打包 zip（content.otio + version.txt + media/*）。
// 需要 server-editor 模式 + 已绑定工程 + 已校验的表情包根目录（与便携文件夹导出同源）。









// 表情包导出的两种交付格式：
//   .otio（original 模式，引用 file:// 路径）始终可用
//   .otioz（服务器打包 zip）需要 server-editor + 已绑定工程文件，否则灰显并说明原因




// 灰显按钮的点击拦截：给出原因指引而非静默失败。




// === 标题区：媒体名点击复制 / 工程文件名点击复制 ===





// 浏览器「新建工程 / 另存为」选择的文件由页面持有 FileSystemFileHandle 持续写回；
// Server 绑定的工程仍由服务器按真实路径原子保存，且优先级高于句柄。





















let projectBackupTimer = null;
function syncProjectBackupControls() {
  const available = MaweServerSave.serverProjectSavingEnabled() && !MaweServerSave.projectFileHandle;
  const enabled = document.getElementById('project-backup-enabled');
  const minutes = document.getElementById('project-backup-minutes');
  const limit = document.getElementById('project-backup-limit');
  enabled.checked = MaweSettings.EDITOR_SETTINGS.projectBackupEnabled;
  enabled.disabled = !available;
  document.getElementById('project-backup-open').disabled = !available;
  minutes.value = MaweSettings.EDITOR_SETTINGS.projectBackupMinutes;
  limit.value = MaweSettings.EDITOR_SETTINGS.projectBackupLimit;
  minutes.disabled = limit.disabled = !available || !enabled.checked;
  document.getElementById('project-backup-unavailable').hidden = available;
  if (projectBackupTimer !== null) window.clearInterval(projectBackupTimer);
  projectBackupTimer = null;
  if (available && enabled.checked) {
    projectBackupTimer = window.setInterval(() => {
      void MaweProjectSave.saveProjectToServer({ silent: true, backupOnly: true });
    }, MaweSettings.EDITOR_SETTINGS.projectBackupMinutes * 60000);
  }
}
for (const [id, key, fallback, max] of [
  ['project-backup-enabled', 'projectBackupEnabled', true, 0],
  ['project-backup-minutes', 'projectBackupMinutes', 5, 1440],
  ['project-backup-limit', 'projectBackupLimit', 20, 1000],
]) {
  document.getElementById(id)?.addEventListener('change', (event) => {
    const value = max ? Math.min(max, Math.max(1, Math.round(Number(event.target.value) || fallback))) : event.target.checked;
    MaweSettings.updateEditorSettings({ [key]: value });
    syncProjectBackupControls();
  });
}

document.getElementById('project-backup-open')?.addEventListener('click', async () => {
  if (!MaweServerSave.serverProjectSavingEnabled() || MaweServerSave.projectFileHandle) return;
  try {
    const response = await MaweHost.server.fetch('/api/project/backups/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || response.status);
  } catch (error) {
    MaweHint.flashHint(`打开备份文件夹失败：${error.message || error}`, 'warning');
  }
});









// 文字编辑先写入页面内存，避免每个按键都请求服务器；失焦后短暂防抖保存，
// 这样点击其它字幕或刷新页面时不会因为 30 秒定时保存尚未到点而丢失刚完成的修改。




// 浏览器文件选择器拿不到工程的真实路径，但 MAW 工程记录的媒体是绝对路径。
// 把工程名与内容交给服务器，由它定位同目录同名工程并接管：
// 成功后整页刷新，由服务器渲染出自动加载媒体且可直接保存的状态。
// 任何失败都静默回退为「手动选择媒体」的便携流程。
