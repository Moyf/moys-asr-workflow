import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const launcherDir = new URL("../web/launcher/", import.meta.url);
const html = readFileSync(new URL("index.html", launcherDir), "utf8");
const source = readFileSync(new URL("postprocess.js", launcherDir), "utf8");
const strings = readFileSync(new URL("i18n/launcher-strings.js", launcherDir), "utf8");

test("AI processing exposes current-operation cancel and streamed output", () => {
  assert.match(source, /bridge\("run_ai_cleanup",\s*\{[\s\S]*?operationId,/);
  assert.match(source, /bridge\("run_llm_postprocess",\s*\{[\s\S]*?operationId,/);
  assert.match(source, /bridge\("cancel_postprocess",\s*\{\s*operationId\s*\}\)/);
  assert.match(source, /result\.code === "postprocess_cancelled"/);
  assert.match(source, /result\?\.cancelled === false[\s\S]*?toolbox_ai_cancel_too_late/);
  assert.match(source, /if \(!busy \|\| postprocessCancelling\) return;/);
  assert.match(strings, /toolbox_ai_cancel_too_late:\s*"AI 处理已进入收尾或保存阶段，无法取消。"/);
  assert.match(strings, /toolbox_ai_cancel_too_late:\s*"AI processing has reached finalization or saving/);
  assert.match(source, /if \(!displayedPostprocessOperationId \|\| event\.operationId !== displayedPostprocessOperationId\) return;/);
  assert.match(source, /event\.operationId !== activePostprocessOperationId\) return;/);
  assert.match(source, /beginStreamOutput\(\);[\s\S]*?setBusy\(true, "toolbox_status_ai_cleanup"\)/);
  assert.match(html, /id="stopToolboxPostprocess"[^>]*class="ghost hidden"/);
  assert.match(html, /id="toolboxStreamOutput"/);
  assert.match(strings, /toolbox_stop_ai:\s*"停止 AI 处理"/);
  assert.match(strings, /toolbox_stop_ai:\s*"Stop AI processing"/);
});

// Execute the current source functions so these lifecycle checks do not depend
// on a fresh bundle. The browser cases exercise the full Launcher separately.
function launcherFunction(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `missing ${name}`);
  const next = source.slice(start + 1).search(/\n  (?:async )?function /);
  assert.notEqual(next, -1, `missing function boundary after ${name}`);
  return source.slice(start, start + 1 + next);
}

function aiLifecycleHarness() {
  const elements = new Map();
  const fields = {
    postprocessProvider: "deepseek", postprocessOperation: "proofread",
    llmReasoningMode: "off",
  };
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        textContent: "", value: fields[id] || "", checked: true, disabled: false,
        scrollTop: 0, scrollHeight: 0,
        classList: {
          add: (...names) => names.forEach((name) => classes.add(name)),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          contains: (name) => classes.has(name),
          toggle(name, force) {
            const enabled = force === undefined ? !classes.has(name) : Boolean(force);
            if (enabled) classes.add(name);
            else classes.delete(name);
            return enabled;
          },
        },
      });
    }
    return elements.get(id);
  }
  const runs = [];
  const cancels = [];
  let sequence = 0;
  let cancelResult = { ok: true, active: true, cancelled: true };
  const context = vm.createContext({
    $: element, busy: false, activePostprocessOperationId: "",
    displayedPostprocessOperationId: "", postprocessOperationReady: false,
    postprocessOperationSequence: 0, postprocessCancelling: false,
    postprocessSettingsActionVisible: false,
    window: { crypto: { randomUUID: () => `operation-${++sequence}` } },
    t: (key) => key, autoLlmReady: () => true, setFieldError() {},
    resolveInputPaths: () => ({ projectPath: "source.mosp" }),
    provider: () => ({ id: "deepseek" }), taskPromptText: () => "task",
    postprocessFieldId: () => "", postprocessErrorText: (result) => result.code || "failed",
    setBusy(value, key) {
      context.busy = value;
      if (value) context.setResult(key);
      else context.renderPostprocessResultActions();
    },
    applySubtitleResult() { context.setResult("success", "success"); },
    bridge(method, payload) {
      if (method === "cancel_postprocess") {
        cancels.push(payload);
        return Promise.resolve(cancelResult);
      }
      return new Promise((resolve) => runs.push({ method, payload, resolve }));
    },
  });
  const functions = [
    "renderPostprocessResultActions", "setResult", "newPostprocessOperationId",
    "beginAiPostprocessOperation", "finishAiPostprocessOperation", "cancelAiPostprocess",
    "renderPostprocessStatus", "resetStreamOutput", "beginStreamOutput", "appendStreamText",
    "renderPostprocessStream", "runAiCleanup", "runLlm",
  ];
  vm.runInContext(functions.map(launcherFunction).join("\n"), context);
  return {
    runs, cancels, element,
    run: (entry) => entry === "cleanup" ? context.runAiCleanup({ projectPath: "source.mosp" }, "script.txt") : context.runLlm(),
    admit: (operationId) => context.renderPostprocessStatus({ stage: "admitted", key: "toolbox_status_starting", operationId }),
    stream: (operationId, kind, text = "") => context.renderPostprocessStream({ operationId, kind, text, batch: 1 }),
    cancel: () => context.cancelAiPostprocess(),
    deferCancel() {
      let resolveCancel;
      cancelResult = new Promise((resolve) => { resolveCancel = resolve; });
      return resolveCancel;
    },
  };
}

for (const entry of ["cleanup", "llm"]) {
  test(`${entry} keeps queued reasoning/content after the completion Promise settles`, async () => {
    const ui = aiLifecycleHarness();
    const running = ui.run(entry);
    const { payload, resolve } = ui.runs[0];
    assert.equal(ui.element("stopToolboxPostprocess").disabled, true);
    await ui.cancel();
    assert.equal(ui.cancels.length, 0, "registration must precede a cancel request");
    ui.admit("another-operation");
    assert.equal(ui.element("stopToolboxPostprocess").disabled, true);
    ui.admit(payload.operationId);
    assert.equal(ui.element("stopToolboxPostprocess").disabled, false);
    resolve({ ok: true });
    await running;
    ui.admit(payload.operationId);
    assert.equal(ui.element("stopToolboxPostprocess").disabled, true);
    ui.stream(payload.operationId, "reasoning", "queued reasoning");
    ui.stream(payload.operationId, "content", "queued result");
    ui.stream("another-operation", "reset");
    ui.stream("another-operation", "content", "wrong result");
    assert.equal(ui.element("toolboxThinkingOutput").textContent, "queued reasoning");
    assert.equal(ui.element("toolboxModelOutput").textContent, "queued result");
  });

  test(`${entry} rejects cancelled and previous-operation streams before and after a new run`, async () => {
    const ui = aiLifecycleHarness();
    const running = ui.run(entry);
    const first = ui.runs[0];
    ui.admit(first.payload.operationId);
    ui.stream(first.payload.operationId, "content", "partial");
    await ui.cancel();
    assert.equal(ui.cancels.length, 1);
    first.resolve({ ok: false, code: "postprocess_cancelled" });
    await running;
    ui.stream(first.payload.operationId, "reset");
    ui.stream(first.payload.operationId, "content", "late cancelled content");
    assert.equal(ui.element("toolboxModelOutput").textContent, "partial");
    const nextRunning = ui.run(entry);
    const next = ui.runs[1];
    ui.admit(first.payload.operationId);
    assert.equal(ui.element("stopToolboxPostprocess").disabled, true);
    ui.admit(next.payload.operationId);
    ui.stream(next.payload.operationId, "content", "next");
    ui.stream(first.payload.operationId, "reset");
    ui.stream(first.payload.operationId, "content", "stale");
    assert.equal(ui.element("toolboxModelOutput").textContent, "next");
    next.resolve({ ok: true });
    await nextRunning;
    ui.stream(first.payload.operationId, "content", "stale after completion");
    ui.stream(next.payload.operationId, "content", " tail");
    assert.equal(ui.element("toolboxModelOutput").textContent, "next tail");
  });

  test(`${entry} rejects a backend cancellation's late reset even without a Stop click`, async () => {
    const ui = aiLifecycleHarness();
    const running = ui.run(entry);
    const { payload, resolve } = ui.runs[0];
    ui.stream(payload.operationId, "content", "partial");
    resolve({ ok: false, code: "postprocess_cancelled" });
    await running;
    ui.stream(payload.operationId, "reset");
    ui.stream(payload.operationId, "content", "late");
    assert.equal(ui.element("toolboxModelOutput").textContent, "partial");
  });

  test(`${entry} preserves tail events arriving before a pending Stop is rejected`, async () => {
    const ui = aiLifecycleHarness();
    const running = ui.run(entry);
    const { payload, resolve } = ui.runs[0];
    ui.admit(payload.operationId);
    const resolveCancel = ui.deferCancel();
    const cancelling = ui.cancel();
    ui.stream(payload.operationId, "reasoning", "pending reasoning");
    ui.stream(payload.operationId, "content", "pending tail");
    resolveCancel({ ok: true, active: true, cancelled: false });
    await cancelling;
    resolve({ ok: true });
    await running;
    ui.stream(payload.operationId, "content", " saved");
    assert.equal(ui.element("toolboxThinkingOutput").textContent, "pending reasoning");
    assert.equal(ui.element("toolboxModelOutput").textContent, "pending tail saved");
  });
}

test("missing AI provider offers settings and media rebuild tab alone stays hidden", () => {
  assert.match(source, /toolbox_ai_cleanup_need_provider"\), "error", \{ showAiSettings: true \}\)/);
  assert.match(source, /openSettings\("llmSettingsSection"\)/);
  assert.match(html, /id="toolboxPostprocessSettings"[^>]*data-i18n="toolbox_open_ai_settings"/);
  assert.match(html, /id="toolboxFfconcatTab" class="toolbox-tab hidden"/);
  assert.match(html, /id="toolboxFfconcatPanel"/);
  assert.match(html, /id="toolboxUtilitiesTabList"[^]*?<div class="toolbox-tab-list">/);
});

test("green-screen generation does not require or disable for missing media", () => {
  const mediaAction = source.match(/function renderMediaToolAction\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  const burnAction = source.match(/async function runBurnSubtitle\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(mediaAction, /burn\.disabled = busy;/);
  assert.doesNotMatch(mediaAction, /utilityMediaPath|mediaPath/);
  assert.match(burnAction, /if \(!greenScreen && !mediaPath\)/);
  assert.match(burnAction, /mediaPath: greenScreen \? "" : mediaPath/);
});
