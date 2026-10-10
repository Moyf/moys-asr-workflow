// Keep startup diagnostics bounded even after a server has become ready.
import { StringDecoder } from 'node:string_decoder';

export function createOutputTail(limit = 4096) {
  const decoders = new Map();
  let tail = '';
  let truncated = false;
  return {
    append(chunk, stream = 'stdout') {
      if (!decoders.has(stream)) decoders.set(stream, new StringDecoder('utf8'));
      tail += Buffer.isBuffer(chunk) ? decoders.get(stream).write(chunk) : String(chunk);
      if (tail.length > limit) {
        tail = tail.slice(-limit);
        truncated = true;
      }
    },
    text() { return `${truncated ? '[earlier server output omitted]\n' : ''}${tail}`; },
  };
}
