import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/launcher/postprocess.js", import.meta.url), "utf8");
const start = source.indexOf("  function renderPostprocessStream(event) {");
const end = source.indexOf("\n  function ", start + 1);
const renderSource = source.slice(start, end);

test("a resegmentation retry remains in its logical batch and later batches clear the retry suffix", () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", classList: { remove() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    $: element,
    displayedPostprocessOperationId: "current",
    t: (key) => ({ toolbox_stream_batch: "第 {batch} 批", toolbox_stream_retry: " · 重试 {retry}", toolbox_stream_chars: "{count} 个字符" })[key],
    beginStreamOutput: () => { element("toolboxModelOutput").textContent = ""; },
    appendStreamText: (node, text) => { node.textContent += text; },
  });
  vm.runInContext(renderSource, context);
  context.renderPostprocessStream({ operationId: "current", kind: "content", batch: 1, attempt: 1, text: "[c0001]" });
  assert.equal(element("toolboxStreamMeta").textContent, "第 1 批");
  context.renderPostprocessStream({ operationId: "current", kind: "reset", batch: 1, attempt: 2 });
  context.renderPostprocessStream({ operationId: "current", kind: "content", batch: 1, attempt: 2, text: "[c0002]" });
  assert.equal(element("toolboxStreamMeta").textContent, "第 1 批 · 重试 1");
  assert.equal(element("toolboxModelOutput").textContent, "[c0002]");
  context.renderPostprocessStream({ operationId: "old", kind: "content", batch: 8, attempt: 2, text: "stale" });
  assert.equal(element("toolboxStreamMeta").textContent, "第 1 批 · 重试 1");
  context.renderPostprocessStream({ operationId: "current", kind: "content", batch: 2, attempt: 1, text: "[c0003]" });
  assert.equal(element("toolboxStreamMeta").textContent, "第 2 批");
});
