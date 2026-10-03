// fcp7: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-fcp7', function createUtilsModule(dependencies) {
  'use strict';
  const { EXPORT_SUBTITLE_TRACKS, assertExportPlan, buildExportNames, escapeExportXml, exportPathToFileUrl, exportPlanFrame, fileBasename, freezeExportValue, normalizeExportOptions, selectedSubtitleTracks, serializeMappedSrt } = dependencies;


  // FCP 7 XML 的 timebase 必须是整数帧率（29.97 → timebase 30 + ntsc TRUE）；
  // 写成 "30/1" 分数形式会被 Premiere 解析失败并回退到默认序列设置（DV NTSC）。
  function fcpTimebase(profile) {
    return profile.denominator === 1001 ? profile.numerator / 1000 : profile.numerator;
  }


  function fcpRate(profile) {
    return `<rate><timebase>${fcpTimebase(profile)}</timebase><ntsc>${profile.denominator === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  }


  function fcpTimeRange(startMs, endMs, plan) {
    const start = exportPlanFrame(plan, startMs, 'floor');
    const end = Math.max(start + 1, exportPlanFrame(plan, endMs, 'ceil'));
    return { start, end, duration: end - start };
  }


  function encodeGraphicAndTypeText(text, fontFamily = 'FangSong', fontSize = FCP7_TEXT_FONT_SIZE_2160P) {
    // 结构逐字段对齐真实 Premiere 导出的单一样式 run payload（OpenTimelineIO
    // 测试样例 empty_name_tags.xml）：顶层只有 mTextParam 与 mVersion，样式表
    // 中没有 mUnderline 键。实机验证 PR 对超出此结构的写法（如 mUnderline 写
    // 裸布尔 false）会静默丢弃整个 mStyleSheet——文字仍渲染，但字体/字号全部
    // 回落默认（Myriad Pro / 100）。
    const payload = {
      mTextParam: {
        // 段落对齐：实测 0=左对齐、1=右对齐、2=居中（PR 实机反馈校准）。
        mAlignment: 2,
        mBackFillColor: 0,
        mBackFillOpacity: 100,
        mBackFillSize: 0,
        mBackFillVisible: false,
        mDefaultRun: [],
        mHeight: 0,
        mHindiDigits: false,
        mIndic: false,
        mIsMask: false,
        mIsMaskInverted: false,
        mIsVerticalText: false,
        mLeading: 0,
        mLigatures: false,
        mLineCapType: 0,
        mLineJoinType: 0,
        mMiterLimit: 2.5,
        mNumStrokes: 1,
        mRTL: false,
        mShadowAngle: 0,
        mShadowBlur: 0,
        mShadowColor: 0,
        mShadowOffset: 0,
        mShadowOpacity: 0,
        mShadowSize: 0,
        mShadowVisible: false,
        mStyleSheet: {
          mAdditionalStrokeColor: [],
          mAdditionalStrokeVisible: [],
          mAdditionalStrokeWidth: [],
          mBaselineOption: { mParamValues: [[0, 0]] },
          mBaselineShift: { mParamValues: [[0, 0]] },
          mCapsOption: { mParamValues: [[0, 0]] },
          mFauxBold: { mParamValues: [[0, false]] },
          mFauxItalic: { mParamValues: [[0, false]] },
          mFillColor: { mParamValues: [[0, 16777215]] },
          mFillOverStroke: { mParamValues: [[0, true]] },
          mFillVisible: { mParamValues: [[0, true]] },
          mFontName: { mParamValues: [[0, fontFamily]] },
          mFontSize: { mParamValues: [[0, fontSize]] },
          mKerning: { mParamValues: [[0, 0]] },
          mStrokeColor: { mParamValues: [[0, 16777215]] },
          mStrokeVisible: { mParamValues: [[0, false]] },
          mStrokeWidth: { mParamValues: [[0, 1]] },
          mText: String(text ?? ''),
          mTracking: { mParamValues: [[0, 0]] },
          mTsumi: { mParamValues: [[0, 0]] },
        },
        mTabWidth: 400,
        mWidth: 0,
      },
      mVersion: 1,
    };
    const json = JSON.stringify(payload);
    const bytes = new Uint8Array(8 + json.length * 2);
    bytes[0] = 0xf6;
    bytes[1] = 0x0a;
    for (let index = 0; index < json.length; index += 1) {
      const code = json.charCodeAt(index);
      bytes[8 + index * 2] = code & 0xff;
      bytes[9 + index * 2] = code >>> 8;
    }
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let encoded = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      encoded += alphabet[first >> 2];
      encoded += alphabet[((first & 3) << 4) | (second === undefined ? 0 : second >> 4)];
      encoded += second === undefined ? '=' : alphabet[((second & 15) << 2) | (third === undefined ? 0 : third >> 6)];
      encoded += third === undefined ? '=' : alphabet[third & 63];
    }
    return encoded;
  }


  // 原生文字默认位置：水平居中、偏下（相对帧宽高的归一化坐标，与 Premiere
  // 导出 XML 的 Position 参数格式一致；任何序列分辨率下表现一致）。
  const FCP7_TEXT_POSITION_X = 0.5;

  const FCP7_TEXT_POSITION_Y = 0.85;

  // 字号锚定 4K（2160p）序列的 120（用户实机确认的合适大小），按序列高度
  // 等比缩放以保持跨分辨率的视觉比例（1080p → 60）。
  const FCP7_TEXT_FONT_SIZE_2160P = 120;

  // Premiere 关键帧时间戳的“无限早”哨兵值，表示静态属性而非动画关键帧。
  const FCP7_TEXT_STATIC_KEYFRAME_TIME = '-91445760000000000';


  // GraphicAndType 的变换参数必须整套（2–22）书写：实测只写 Transform +
  // Position 的“半套”会让 Premiere 初始化出不可见的文字；完整结构逐字段
  // 对齐 Premiere 自己导出的 XML（Scale/Opacity 默认 100）。
  function fcp7TextMotionParameters() {
    const ts = FCP7_TEXT_STATIC_KEYFRAME_TIME;
    const parameter = (id, name, bounds, value) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name>${bounds}<value>${value}</value></parameter>`;
    const staticValue = (data) => `${ts},${data},0,0,0,0,0,0`;
    const pointValue = (x, y) => `${ts},${x}:${y},0,0,0,0,0,0,5,4,0,0,0,0`;
    const rangeBounds = (lower, upper) => `<LowerBound>${lower}</LowerBound><UpperBound>${upper}</UpperBound>`;
    const rotationBounds = '<ParameterControlType>3</ParameterControlType><LowerBound>-32768</LowerBound><UpperBound>32767</UpperBound>';
    return [
      parameter(2, 'Transform', '<ParameterControlType>11</ParameterControlType><UpperBound>false</UpperBound>', staticValue('false')),
      parameter(3, 'Position', '', pointValue(FCP7_TEXT_POSITION_X, FCP7_TEXT_POSITION_Y)),
      parameter(4, 'Scale', rangeBounds(0, 4000), staticValue('100.')),
      parameter(5, 'Horizontal Scale', rangeBounds(0, 4000), staticValue('100.')),
      parameter(6, ' ', '', staticValue('true')),
      parameter(7, 'Rotation', rotationBounds, staticValue('0.')),
      parameter(8, 'Opacity', rangeBounds(0, 100), staticValue('100.')),
      parameter(9, 'Anchor Point', '', pointValue(0, 0)),
      parameter(10, '', '<ParameterControlType>12</ParameterControlType><UpperBound>false</UpperBound>', staticValue('false')),
      parameter(11, ' ', rangeBounds(0, 32768), staticValue('0.')),
      parameter(12, ' ', rangeBounds(0, 32768), staticValue('0.')),
      parameter(13, 'start', rangeBounds(-100, 1000000000), staticValue('-1.')),
      parameter(14, 'end', rangeBounds(-100, 1000000000), staticValue('-1.')),
      parameter(15, ' ', '', staticValue('false')),
      parameter(16, ' ', '', staticValue('false')),
      parameter(17, ' ', '', staticValue('false')),
      parameter(18, ' ', '', staticValue('false')),
      parameter(19, 'Parent Width', rangeBounds(0, 20000), staticValue('0.')),
      parameter(20, 'Parent Height', rangeBounds(0, 20000), staticValue('0.')),
      parameter(21, 'Parent Rotation', rotationBounds, staticValue('0.')),
      parameter(22, ' ', '', staticValue('false')),
    ].join('');
  }


  // Graphic（含 GraphicAndType）剪辑必须带 Vector Motion（GraphicGroup）组：
  // 实测缺失时 Premiere 用异常锚点初始化（导入后不显示，或粘贴后文字从
  // Position 点向右下排布而不居中）；结构逐字段对齐 PR 导出的默认组。
  function fcp7TextGraphicGroupFilter() {
    const ts = FCP7_TEXT_STATIC_KEYFRAME_TIME;
    const parameter = (id, name, bounds, value) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name>${bounds}<value>${value}</value></parameter>`;
    const staticValue = (data) => `${ts},${data},0,0,0,0,0,0`;
    const pointValue = (x, y) => `${ts},${x}:${y},0,0,0,0,0,0,5,4,0,0,0,0`;
    const scaleBounds = '<LowerBound>0</LowerBound><UpperBound>10000</UpperBound><UpperUIBound>200</UpperUIBound>';
    const rotationBounds = '<ParameterControlType>3</ParameterControlType><LowerBound>-32768</LowerBound><UpperBound>32767</UpperBound>';
    const effect = `<effect><name>Vector Motion</name><effectid>GraphicGroup</effectid><effectcategory>graphic</effectcategory><effecttype>filter</effecttype><mediatype>video</mediatype><pproBypass>false</pproBypass>${parameter(1, 'Position', '', pointValue(0, 0))}${parameter(2, 'Scale', scaleBounds, staticValue('100.'))}${parameter(3, 'Scale Width', scaleBounds, staticValue('100.'))}${parameter(4, ' ', '', staticValue('true'))}${parameter(5, 'Rotation', rotationBounds, staticValue('0.'))}${parameter(6, 'Anchor Point', '', pointValue(0, 0))}</effect>`;
    return `<filter>${effect}</filter>`;
  }


  function fcpClipItem({ id, fileId, name, path, width, height, sourceStartMs, sourceEndMs, sourceStartFrame = null, startMs, endMs, startFrame, endFrame, plan, mediaKind, track, link, defineFile = true, encodeDriveColon = false }) {
    const sourceRange = fcpTimeRange(sourceStartMs, sourceEndMs, plan);
    const timeline = fcpTimeRange(startMs, endMs, plan);
    const url = escapeExportXml(exportPathToFileUrl(path, { encodeDriveColon }));
    const isSticker = mediaKind === 'sticker';
    const media = mediaKind === 'audio' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex><channel>1</channel><channelcount>2</channelcount></sourcetrack>'
      : '<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>';
    const sourceDuration = exportPlanFrame(plan, plan.sourceDurationMs, 'ceil');
    const fileMedia = mediaKind === 'audio'
      ? `<media><audio><duration>${sourceDuration}</duration><channelcount>2</channelcount></audio></media>`
      : isSticker
        ? `<media><video><samplecharacteristics><rate><timebase>${plan.frameProfile.numerator}/${plan.frameProfile.denominator}</timebase><ntsc>${plan.frameProfile.denominator === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate><width>${Number.isInteger(width) && width > 0 ? width : 720}</width><height>${Number.isInteger(height) && height > 0 ? height : 480}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>`
        : `<media><video><duration>${sourceDuration}</duration></video><audio><duration>${sourceDuration}</duration><channelcount>2</channelcount></audio></media>`;
    const file = defineFile
      ? `<file id="${escapeExportXml(fileId)}"><name>${escapeExportXml(fileBasename(path))}</name><pathurl>${url}</pathurl><duration>${sourceDuration}</duration>${fcpRate(plan.frameProfile)}${isSticker ? `<timecode><rate>${fcpRate(plan.frameProfile).replace('<rate>', '').replace('</rate>', '')}</rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>` : ''}${fileMedia}</file>`
      : `<file id="${escapeExportXml(fileId)}"/>`;
    const frameStart = startFrame ?? timeline.start;
    const frameEnd = Math.max(frameStart + 1, endFrame ?? frameStart + sourceRange.duration);
    // 显式传入 sourceStartFrame 时（媒体片段），in/out 按时间线区间长度对齐，
    // 保证源区间与时间线区间等长（1:1 播放速率），两端不再各自向外取整。
    const source = sourceStartFrame != null
      ? { start: sourceStartFrame, end: sourceStartFrame + (frameEnd - frameStart) }
      : sourceRange;
    const stickerClipMetadata = isSticker
      ? `<enabled>TRUE</enabled><alphatype>${/\.(?:gif|png|webp)$/iu.test(path) ? 'straight' : 'none'}</alphatype><pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic>`
      : '';
    const masterClipMetadata = isSticker ? `<masterclipid>${escapeExportXml(fileId.replace(/^file-/, 'master-'))}</masterclipid>` : '';
    return `<clipitem id="${escapeExportXml(id)}">${masterClipMetadata}<name>${escapeExportXml(name)}</name>${stickerClipMetadata}<duration>${frameEnd - frameStart}</duration>${fcpRate(plan.frameProfile)}<start>${frameStart}</start><end>${frameEnd}</end><in>${source.start}</in><out>${source.end}</out>${file}${media}${link ? `<link><linkclipref>${escapeExportXml(link)}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>` : ''}<label>${escapeExportXml(track)}</label></clipitem>`;
  }


  function serializeFcp7Xml(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    if (options.nativeTextObjects !== undefined && typeof options.nativeTextObjects !== 'boolean') {
      throw new Error('native text option must be boolean');
    }
    const nativeTextObjects = options.nativeTextObjects === true;
    const subtitleTracks = options.subtitleTracks || 'main';
    if (!EXPORT_SUBTITLE_TRACKS.includes(subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${subtitleTracks}`);
    }
    const mediaType = String(exportPlan.media.type || 'video').toLowerCase();
    const hasVideo = mediaType !== 'audio';
    // 序列级 format 告诉 Premiere 按媒体实际尺寸/帧率建序列；
    // 缺失时 Premiere 会回退到默认的 DV NTSC 720x480 序列设置。
    const sequenceWidth = Number.isInteger(exportPlan.media.width) && exportPlan.media.width > 0
      ? exportPlan.media.width : 1920;
    const sequenceHeight = Number.isInteger(exportPlan.media.height) && exportPlan.media.height > 0
      ? exportPlan.media.height : 1080;
    const videoFormat = `<format><samplecharacteristics>${fcpRate(exportPlan.frameProfile)}<width>${sequenceWidth}</width><height>${sequenceHeight}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance><colordepth>24</colordepth></samplecharacteristics></format>`;
    const audioFormat = '<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>';
    const sourceTracks = [];
    const intervals = Array.isArray(exportPlan.keptIntervals) ? exportPlan.keptIntervals : [];
    // 时间线边界在 ms 域按保留区间长度精确累加，再对每个边界单次取整（floor，
    // 末边界 ceil 保总长）；媒体、音频、字幕、贴纸由此共享同一帧网格。此前对每段
    // 保留区间「start floor + end ceil」向外取整再逐段累加帧长，每段最多膨胀 2 帧
    // 且随空隙数量线性累积，去空隙导出后字幕会越往后越提前。
    const msBoundaries = [0];
    intervals.forEach((interval) => msBoundaries.push(
      msBoundaries[msBoundaries.length - 1] + interval.end - interval.start,
    ));
    const boundaries = msBoundaries.map((ms, index) => exportPlanFrame(exportPlan, ms,
      index === msBoundaries.length - 1 ? 'ceil' : 'floor'));
    const duration = boundaries[boundaries.length - 1];
    intervals.forEach((interval, index) => {
      sourceTracks.push(fcpClipItem({
        id: `video-clip-${index + 1}`, fileId: 'file-source-video-1', name: `${fileBasename(exportPlan.media.path)} [${index + 1}]`,
        path: exportPlan.media.path, sourceStartMs: interval.start, sourceEndMs: interval.end,
        sourceStartFrame: exportPlanFrame(exportPlan, interval.start, 'floor'),
        startMs: msBoundaries[index], endMs: msBoundaries[index + 1],
        startFrame: boundaries[index], endFrame: boundaries[index + 1], plan: exportPlan, mediaKind: mediaType, track: 'source', defineFile: index === 0,
      }));
    });
    const audioTracks = hasVideo ? intervals.map((interval, index) => fcpClipItem({
      id: `audio-clip-${index + 1}`, fileId: 'file-source-audio', name: `${fileBasename(exportPlan.media.path)} audio [${index + 1}]`,
      path: exportPlan.media.path, sourceStartMs: interval.start, sourceEndMs: interval.end,
      sourceStartFrame: exportPlanFrame(exportPlan, interval.start, 'floor'),
      startMs: msBoundaries[index], endMs: msBoundaries[index + 1],
      startFrame: boundaries[index], endFrame: boundaries[index + 1], plan: exportPlan, mediaKind: 'audio', track: 'source-audio', link: `video-clip-${index + 1}`, defineFile: index === 0,
    })) : [];
    const videoTracks = hasVideo ? [`<track>${sourceTracks.join('')}</track>`] : [];
    const stickerFileIds = new Map();
    const buildStickerTracks = (list, trackPrefix, clipPrefix) => (Array.isArray(list) ? list : [])
      .map((sticker, index) => {
        if (!String(sticker.path || '').trim()) return '';
        const stickerKey = `${trackPrefix}:${String(sticker.path)}`;
        const fileId = stickerFileIds.get(stickerKey) || `file-${trackPrefix}-${stickerFileIds.size + 1}`;
        const defineFile = !stickerFileIds.has(stickerKey);
        stickerFileIds.set(stickerKey, fileId);
        const clip = fcpClipItem({
          id: `${clipPrefix}-clip-${index + 1}`, fileId, name: `MAW sticker - ${sticker.name || index + 1}`,
          path: sticker.path, width: sticker.width, height: sticker.height, sourceStartMs: 0,
          sourceEndMs: Math.max(1, sticker.endMs - sticker.startMs),
          startMs: sticker.startMs, endMs: sticker.endMs, plan: exportPlan, mediaKind: 'sticker', track: `${trackPrefix}-${index + 1}`,
          defineFile, encodeDriveColon: true,
        });
        return `<track>${clip}</track>`;
      }).filter(Boolean);
    const stickerTracks = hasVideo
      ? buildStickerTracks(exportPlan.stickers, 'sticker', 'sticker')
        .concat(buildStickerTracks(exportPlan.overlayStickers, 'overlay-sticker', 'overlay-sticker'))
      : [];
    const textTracks = nativeTextObjects && hasVideo ? (subtitleTracks === 'main_and_extension' || subtitleTracks === 'both'
      ? ['main', 'extension']
      : subtitleTracks === 'all'
        ? ['main', 'extension', 'overlay']
        : subtitleTracks === 'overlay' ? ['overlay'] : subtitleTracks === 'extension' ? ['extension'] : ['main']).map((track) => {
      const cues = selectedSubtitleTracks(exportPlan, track);
      const generators = cues.map((cue, index) => {
        const range = fcpTimeRange(cue.startMs, cue.endMs, exportPlan);
        const text = encodeGraphicAndTypeText(cue.text, exportPlan.subtitleFontFamily,
          Math.round(FCP7_TEXT_FONT_SIZE_2160P * sequenceHeight / 2160));
        const clipId = `text-${track}-${index + 1}`;
        // clip / effect 名与 PR 原生 Graphic 一致使用字幕内容，时间线标签直接可读。
        // Transform(2)–Parent Rotation(21) 等变换参数按 Premiere 导出格式整套书写；
        // 只写 Position 时 Premiere 会初始化出不可见的文字。
        const motionParams = fcp7TextMotionParameters();
        // Graphic 画布尺寸必须与序列一致：缺失时 Premiere 按 DV NTSC 720x480
        // 分配画布，与序列不匹配导致文字不显示（粘贴重置后才能显示）。
        const textFileMedia = `<media><video><duration>${range.duration}</duration><samplecharacteristics>${fcpRate(exportPlan.frameProfile)}<width>${sequenceWidth}</width><height>${sequenceHeight}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>`;
        return `<clipitem id="${clipId}"><name>${escapeExportXml(cue.text)}</name><enabled>TRUE</enabled><duration>${range.duration}</duration>${fcpRate(exportPlan.frameProfile)}<start>${range.start}</start><end>${range.end}</end><in>0</in><out>${range.duration}</out><file id="file-${clipId}"><name>MAW GraphicAndType</name><mediaSource>GraphicAndType</mediaSource><duration>${range.duration}</duration>${fcpRate(exportPlan.frameProfile)}${textFileMedia}</file>${fcp7TextGraphicGroupFilter()}<filter><effect><name>${escapeExportXml(cue.text)}</name><effectid>GraphicAndType</effectid><effectcategory>graphic</effectcategory><effecttype>filter</effecttype><mediatype>video</mediatype><pproBypass>false</pproBypass><parameter authoringApp="MAW"><parameterid>1</parameterid><name>Source Text</name><value>${text}</value></parameter>${motionParams}</effect></filter></clipitem>`;
      }).join('');
      return generators ? `<track>${generators}</track>` : '';
    }).filter(Boolean) : [];
    const video = hasVideo ? `<video>${videoFormat}${videoTracks.concat(stickerTracks, textTracks).join('')}</video>` : '';
    const audio = mediaType === 'audio' ? `<audio>${audioFormat}<track>${sourceTracks.join('')}</track></audio>` : `<audio>${audioFormat}<track>${audioTracks.join('')}</track></audio>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="MAW-sequence"><name>MAW FCP 7 Premiere handoff</name><duration>${duration}</duration>${fcpRate(exportPlan.frameProfile)}<media>${video}${audio}</media></sequence></xmeml>`;
    return xml;
  }


  function buildFcp7ExportArtifacts(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    const normalized = normalizeExportOptions({
      timelineMode: exportPlan.mode,
      fps: exportPlan.frameProfile.name,
      ...options,
    });
    if (normalized.timelineMode !== exportPlan.mode
      || normalized.fps !== exportPlan.frameProfile.name) {
      throw new Error('export artifact options do not match the shared plan');
    }
    const names = buildExportNames(normalized.baseName);
    const serializerOptions = {
      nativeTextObjects: normalized.nativeTextObjects,
      subtitleTracks: normalized.subtitleTracks,
    };
    return freezeExportValue([
      {
        kind: 'xml', filename: names.files.project, mime: 'application/xml',
        content: serializeFcp7Xml(exportPlan, serializerOptions), plan: exportPlan,
      },
      {
        kind: 'srt', filename: names.files.subtitles, mime: 'text/plain',
        content: serializeMappedSrt(exportPlan, serializerOptions), plan: exportPlan,
      },
    ]);
  }

  return Object.freeze({ buildFcp7ExportArtifacts, serializeFcp7Xml });
});
