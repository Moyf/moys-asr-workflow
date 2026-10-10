// lrc: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule() {
  'use strict';


  // LRC 时间戳标签：[mm:ss]、[mm:ss.xx]（小数兼容逗号；分钟 >= 60 视为累计分钟，
  // 覆盖长音频常见的 [75:30.00] 写法），以及长格式 [hh:mm:ss.xx]。
  const LRC_LONG_TIMESTAMP_TAG = /^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;
  const LRC_SHORT_TIMESTAMP_TAG = /^(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/;
  // 增强 LRC（A2）的字词时间戳 <mm:ss.xx>：导入不生成逐字 items，仅从文本剥除。
  const LRC_ENHANCED_WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.,]\d{1,3})?>/g;
  // 头部元数据标签（ti/ar/al/by/re/ve 等）：「字母开头 + 冒号/等号」。
  const LRC_METADATA_TAG = /^[a-z][a-z0-9 _'-]*[:=]/i;
  const LRC_OFFSET_TAG = /^offset[:=]([+-]?\d+(?:\.\d+)?)$/i;
  // LRC 只有起点：每句持续到下一时间戳（空文本时间戳同样充当边界），
  // 最后一句没有后续时间戳时兜底 5s，避免最后一条字幕无限长。
  const LRC_LAST_CUE_FALLBACK_MS = 5000;


  function parseLrcTimestampMs(tag) {
    const value = String(tag || '').trim();
    const long = LRC_LONG_TIMESTAMP_TAG.exec(value);
    if (long) {
      const hours = Number(long[1]);
      const minutes = Number(long[2]);
      const seconds = Number(long[3]);
      if (minutes >= 60 || seconds >= 60) return null;
      const milliseconds = long[4] ? Number(long[4].padEnd(3, '0')) : 0;
      return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
    }
    const short = LRC_SHORT_TIMESTAMP_TAG.exec(value);
    if (!short) return null;
    const minutes = Number(short[1]);
    const seconds = Number(short[2]);
    if (seconds >= 60) return null;
    const milliseconds = short[3] ? Number(short[3].padEnd(3, '0')) : 0;
    return (minutes * 60 + seconds) * 1000 + milliseconds;
  }


  // 解析 LRC 歌词为工程字幕段（start/end 为整数毫秒，start 严格递增）：
  // - 每行可带多个时间戳（如 [00:12.00][01:24.00]副歌）。
  // - [offset:+n] 为全局时间调整，按主流播放器约定正值让歌词提前，即整体减 n 毫秒。
  // - 同一时间戳的多条文本合并为一条字幕（换行连接），空文本时间戳只作为上一句的结束边界。
  // - 乱序行按时间稳定排序；调整后落在同一时刻的边界同样合并，保证段不重叠。
  function parseLrcSegments(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    let offsetMs = 0;
    const entries = [];
    for (const line of lines) {
      let rest = line;
      const stamps = [];
      for (;;) {
        const tag = /^\s*\[([^\[\]]*)\]/.exec(rest);
        if (!tag) break;
        const stamp = parseLrcTimestampMs(tag[1]);
        if (stamp !== null) {
          stamps.push(stamp);
          rest = rest.slice(tag[0].length);
          continue;
        }
        const offset = LRC_OFFSET_TAG.exec(tag[1].trim());
        if (offset) {
          offsetMs = Math.round(Number(offset[1]));
          rest = rest.slice(tag[0].length);
          continue;
        }
        // 只有尚未进入时间戳部分时才消费元数据标签；正文开始后不再剥除方括号，
        // 避免把歌词里合法的「[Chorus]」一类文本误当标签。
        if (!stamps.length && LRC_METADATA_TAG.test(tag[1].trim())) {
          rest = rest.slice(tag[0].length);
          continue;
        }
        break;
      }
      if (!stamps.length) continue;
      const cueText = rest.replace(LRC_ENHANCED_WORD_TAG, '').trim();
      for (const stamp of stamps) {
        entries.push({ time: stamp, text: cueText, order: entries.length });
      }
    }
    // offset 是整文件级标签（主流播放器不关心它出现在哪一行），收集完统一应用。
    for (const entry of entries) entry.time = Math.max(0, entry.time - offsetMs);
    entries.sort((a, b) => a.time - b.time || a.order - b.order);
    const merged = [];
    for (const entry of entries) {
      const last = merged[merged.length - 1];
      if (last && last.time === entry.time) {
        if (entry.text && last.text !== entry.text) {
          last.text = last.text ? `${last.text}\n${entry.text}` : entry.text;
        }
        continue;
      }
      merged.push({ time: entry.time, text: entry.text });
    }
    const segments = [];
    merged.forEach((entry, index) => {
      if (!entry.text) return;
      const next = merged[index + 1];
      const end = next ? next.time : entry.time + LRC_LAST_CUE_FALLBACK_MS;
      segments.push({ start: entry.time, end, text: entry.text });
    });
    if (!segments.length) throw new Error('没有可导入的歌词时间轴');
    return segments;
  }


  return Object.freeze({ parseLrcSegments });
}
