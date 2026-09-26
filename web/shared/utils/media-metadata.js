// media-metadata: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-media-metadata', function createUtilsModule(dependencies) {
  'use strict';


  // SRT files commonly come from Windows subtitle tools, which may save them
  // as UTF-8 (with or without BOM) or as the local GBK code page. Decode the
  // bytes here instead of relying on File.text(), whose encoding is fixed to
  // UTF-8 and turns GBK Chinese into replacement characters.
  function decodeSubtitleText(input) {
    if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('gb18030').decode(bytes);
    }
  }


  function readUint32LittleEndian(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    return (
      bytes[offset]
      | (bytes[offset + 1] << 8)
      | (bytes[offset + 2] << 16)
      | (bytes[offset + 3] << 24)
    ) >>> 0;
  }


  function parseBwfTimeReference(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (bytes.length < 12) return null;
    const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49
      && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isRf64 = bytes[0] === 0x52 && bytes[1] === 0x46
      && bytes[2] === 0x36 && bytes[3] === 0x34;
    const isWave = bytes[8] === 0x57 && bytes[9] === 0x41
      && bytes[10] === 0x56 && bytes[11] === 0x45;
    if ((!isRiff && !isRf64) || !isWave) return null;

    let offset = 12;
    let sampleRate = null;
    let timeReferenceSamples = null;
    while (offset + 8 <= bytes.length) {
      const chunkId = String.fromCharCode(
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
      );
      const chunkSize = readUint32LittleEndian(bytes, offset + 4);
      if (chunkSize === null) break;
      const payloadStart = offset + 8;
      if (chunkSize > bytes.length - payloadStart) break;

      if (chunkId === 'fmt ' && chunkSize >= 8) {
        sampleRate = readUint32LittleEndian(bytes, payloadStart + 4);
      } else if (chunkId === 'bext' && chunkSize >= 346) {
        const low = readUint32LittleEndian(bytes, payloadStart + 338);
        const high = readUint32LittleEndian(bytes, payloadStart + 342);
        if (low !== null && high !== null) {
          timeReferenceSamples = high * 0x100000000 + low;
        }
      }
      if (
        Number.isInteger(sampleRate)
        && sampleRate > 0
        && Number.isSafeInteger(timeReferenceSamples)
        && timeReferenceSamples >= 0
      ) {
        return {
          sample_rate: sampleRate,
          time_reference_samples: timeReferenceSamples,
        };
      }
      offset = payloadStart + chunkSize + (chunkSize % 2);
    }
    return null;
  }


  async function readBwfTimeReferenceFromFile(file) {
    if (!file || !/\.wav$/iu.test(String(file.name || '')) || typeof file.slice !== 'function') {
      return null;
    }
    const header = await file.slice(0, 1024 * 1024).arrayBuffer();
    return parseBwfTimeReference(new Uint8Array(header));
  }

  return Object.freeze({ decodeSubtitleText, parseBwfTimeReference, readBwfTimeReferenceFromFile });
});
