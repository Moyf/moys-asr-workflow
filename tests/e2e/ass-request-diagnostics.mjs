// Passive network evidence for font cold loading versus frame rendering failures.
// This helper must not fetch, prewarm, wait, or alter request/response handling.
export function observeAssRequests(page, now = () => Date.now()) {
  const start = now();
  const rows = [];
  const active = new Map();
  let omitted = 0;
  const request = req => {
    const path = new URL(req.url()).pathname;
    if (!/\/api\/(?:ass-frame|.*font.*)$/u.test(path)) return;
    if (rows.length >= 100) { omitted++; return; }
    const row = { path, method: req.method(), startedMs: now() - start, state: 'pending' };
    rows.push(row); active.set(req, row);
  };
  const response = res => { const row = active.get(res.request()); if (row) { row.status = res.status(); row.responseMs = now() - start; } };
  const finished = req => { const row = active.get(req); if (row) { row.state = 'finished'; row.finishedMs = now() - start; active.delete(req); } };
  const failed = req => { const row = active.get(req); if (row) { row.state = 'failed'; row.error = req.failure()?.errorText; row.finishedMs = now() - start; active.delete(req); } };
  const handlers = { request, response, requestfinished: finished, requestfailed: failed };
  for (const [event, handler] of Object.entries(handlers)) page.on(event, handler);
  return { finish() {
    for (const [event, handler] of Object.entries(handlers)) page.off(event, handler);
    return { elapsedMs: now() - start, omitted, requests: rows };
  } };
}
