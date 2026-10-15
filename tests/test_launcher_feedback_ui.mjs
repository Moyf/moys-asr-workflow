import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const launcherDir = new URL("../web/launcher/", import.meta.url);
const html = readFileSync(new URL("index.html", launcherDir), "utf8");
const source = readFileSync(new URL("postprocess.js", launcherDir), "utf8");
const strings = readFileSync(new URL("i18n/launcher-strings.js", launcherDir), "utf8");
const stateSource = readFileSync(new URL("boot/launcher-state.js", launcherDir), "utf8");

test("the editor action uses plain labels without emoji in both languages", () => {
  assert.match(strings, /open_editor:\s*"打开编辑器"/);
  assert.match(strings, /open_editor:\s*"Open editor"/);
  assert.match(stateSource, /start_server_editor:\s*"打开编辑器"/);
  assert.doesNotMatch(strings, /open_editor:\s*"[^"]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test("AI processing exposes current-operation cancel and streamed output", () => {
  assert.match(source, /bridge\("run_ai_cleanup",\s*\{[\s\S]*?operationId,/);
  assert.match(source, /bridge\("run_llm_postprocess",\s*\{[\s\S]*?operationId,/);
  assert.match(source, /bridge\("cancel_postprocess",\s*\{\s*operationId\s*\}\)/);
  assert.match(source, /result\.code === "postprocess_cancelled"/);
  assert.match(source, /result\?\.cancelled === false[\s\S]*?toolbox_ai_cancel_too_late/);
  assert.match(source, /if \(!busy \|\| postprocessCancelling\) return;/);
  assert.match(strings, /toolbox_ai_cancel_too_late:\s*"字幕处理已进入收尾或保存阶段，无法取消。"/);
  assert.match(strings, /toolbox_ai_cancel_too_late:\s*"Subtitle processing has reached finalization or saving/);
  assert.match(source, /if \(!displayedPostprocessOperationId \|\| event\.operationId !== displayedPostprocessOperationId\) return;/);
  assert.match(source, /event\.operationId !== activePostprocessOperationId\) return;/);
  assert.match(source, /beginStreamOutput\(\);[\s\S]*?setBusy\(true, "toolbox_status_ai_cleanup"\)/);
  assert.match(html, /id="stopToolboxPostprocess"[^>]*class="ghost hidden"/);
  assert.match(html, /id="toolboxStreamOutput"/);
  assert.match(strings, /toolbox_stop_ai:\s*"停止字幕处理"/);
  assert.match(strings, /toolbox_stop_ai:\s*"Stop subtitle processing"/);
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

test("resegmentation validates optional character limits before starting", () => {
  const field = { value: "" };
  const context = vm.createContext({ $: () => field });
  vm.runInContext(launcherFunction("resegmentMaxCharsValid"), context);
  for (const value of ["", "1", "18", "500"]) {
    field.value = value;
    assert.equal(context.resegmentMaxCharsValid(), true, value);
  }
  for (const value of ["0", "-1", "501", "1.5", "1e2", "invalid"]) {
    field.value = value;
    assert.equal(context.resegmentMaxCharsValid(), false, value);
  }
});

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
    $: element, busy: false, activeToolId: "llm", runningToolId: "", toolboxResultTool: "", toolboxStreamTool: "",
    activePostprocessOperationId: "",
    displayedPostprocessOperationId: "", postprocessOperationReady: false,
    postprocessOperationSequence: 0, postprocessCancelling: false,
    postprocessSettingsActionVisible: false,
    window: { crypto: { randomUUID: () => `operation-${++sequence}` } },
    document: { querySelector: () => null },
    t: (key) => key, autoLlmReady: () => true, setFieldError() {},
    stepProviderId: () => "deepseek",
    resolveInputPaths: () => ({ projectPath: "source.mosp" }),
    provider: () => ({ id: "deepseek" }), taskPromptText: () => "task",
    postprocessFieldId: () => "", postprocessErrorText: (result) => result.code || "failed",
    setBusy(value, key) {
      context.busy = value;
      if (value) {
        if (!context.runningToolId) context.runningToolId = context.activeToolId;
        context.setResult(key);
      } else {
        context.runningToolId = "";
        context.renderPostprocessResultActions();
      }
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
    "renderPostprocessStream", "syncSharedOutputVisibility", "resultOwningTool",
    "scrollToolboxContentToTop", "runAiCleanup", "runLlm",
  ];
  vm.runInContext(functions.map(launcherFunction).join("\n"), context);
  return {
    runs, cancels, element,
    switchTool(tool) { context.activeToolId = tool; context.syncSharedOutputVisibility(); },
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
  test(`${entry} accumulates stream output while another tool is visible`, async () => {
    const ui = aiLifecycleHarness();
    const running = ui.run(entry);
    const { payload, resolve } = ui.runs[0];
    ui.stream(payload.operationId, 'content', 'before');
    ui.switchTool('extractAudio');
    assert.equal(ui.element('toolboxStreamOutput').classList.contains('hidden'), true);
    ui.stream(payload.operationId, 'reasoning', 'hidden reasoning');
    ui.stream(payload.operationId, 'content', ' hidden tail');
    ui.switchTool('llm');
    assert.equal(ui.element('toolboxStreamOutput').classList.contains('hidden'), false);
    assert.equal(ui.element('toolboxModelOutput').textContent, 'before hidden tail');
    assert.equal(ui.element('toolboxThinkingOutput').textContent, 'hidden reasoning');
    resolve({ ok: true });
    await running;
  });
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

test("provider key status prefers a loaded key, then local no-key, then missing", () => {
  const context = vm.createContext({ t: (key) => key });
  vm.runInContext(launcherFunction("providerKeyStatusText"), context);
  const status = context.providerKeyStatusText;
  assert.equal(status({ maskedApiKey: "sk-…1", apiKeyRequired: true }), "toolbox_key_loaded");
  assert.equal(status({ maskedApiKey: "", apiKeyRequired: false }), "toolbox_key_not_required");
  assert.equal(status({ maskedApiKey: "", apiKeyRequired: true }), "toolbox_key_empty");
  assert.match(strings, /toolbox_key_not_required:\s*"本地服务，无需密钥"/);
  assert.match(strings, /toolbox_key_not_required:\s*"Local service; no API key needed"/);
});

test("busy-state controls exist in the Launcher page", () => {
  const body = launcherFunction("setBusy");
  const lists = [...body.matchAll(/\[([^\]]+)\]\.forEach\(\(id\) =>/g)];
  assert.ok(lists.length > 0);
  for (const list of lists) {
    for (const [, id] of list[1].matchAll(/"([^"]+)"/g)) {
      assert.ok(html.includes(`id="${id}"`), `missing busy-state control: ${id}`);
    }
  }
});

function providerOwnershipHarness({ remembered = {} } = {}) {
  const elements = new Map();
  const selects = new Set(["postprocessProvider", "llmProvider"]);
  function element(id) {
    if (!elements.has(id)) {
      let value = "";
      const options = [];
      const classes = new Set();
      elements.set(id, {
        id, options, textContent: "", placeholder: "", checked: false,
        get value() { return value; },
        set value(next) { value = !selects.has(id) || options.some(option => option.value === next) ? next : ""; },
        set innerHTML(_next) { options.length = 0; value = ""; },
        add(option) { options.push(option); if (!value) value = option.value; },
        classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
      });
    }
    return elements.get(id);
  }
  const providers = [
    { id: "deepseek", label: "DeepSeek", maskedApiKey: "deepseek-mask" },
    { id: "qwen", label: "Qwen", maskedApiKey: "qwen-mask" },
    { id: "custom", displayName: "First slot", hasBaseUrl: true },
    { id: "custom2", displayName: "Second slot", hasBaseUrl: false },
    { id: "custom3", displayName: "Third slot", hasBaseUrl: false },
  ];
  const requests = [];
  const noop = () => {};
  const storage = new Map([["maw.launcher.llm.provider_by_task", JSON.stringify(remembered)]]);
  const context = vm.createContext({
    $: element, window: { MAWLauncher: { config: { postprocessProviders: providers } }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } },
    Option: function Option(text, value) { this.textContent = text; this.value = value; },
    t: key => key, postprocessApiKeyRequest: 0, llmProviderByTask: remembered,
    LLM_PROVIDER_TASK_GROUPS: { proofread: "proofread", ai_cleanup: "cleanup" },
    LLM_PROVIDER_BY_TASK_KEY: "maw.launcher.llm.provider_by_task",
    bridge(method, payload) { return new Promise(resolve => requests.push({ method, payload, resolve })); },
    renderModelChoices: noop, clearSettingsErrors: noop, setSettingsSaveStatus: noop,
    AUTO_STEP_ORDER: ["match", "cleanup"], AUTO_STEP_CHECKBOXES: { match: "autoStepMatch", cleanup: "autoStepCleanup" },
    llmPrompts: {}, activeLlmOperation: "", ocrVideoManual: false,
    defaultAutoPlan: () => ({ enabled: false, steps: [] }),
    renderAiCleanupMode: noop, validateMatchPunctuation: noop, refreshScriptPreview: noop,
    syncReplacementSeparator: noop, renderReplacementPreview: noop,
    autoLlmOperation: value => value, saveLlmPrompts: noop, loadLlmPrompt: noop,
    renderOcrRegion: noop, setAutoStepsExpanded: noop, renderAutoPostprocessState: noop,
    updateBackfillLabels: noop, autoOcrVideoPath: () => "", ocrRegionPayload: () => ({}),
    punctuationLines: () => [], parseReplacements: () => [], replacementRuleText: () => "", getLlmPrompt: () => "",
    saveLlmProviderByTask: noop,
  });
  const functions = [
    "provider", "isCustomSlot", "customSlotLabelKey", "customSlotVisibleInToolbox",
    "fillProviderSelects", "syncProviderOptionLabels", "providerLabel", "providerKeyStatusText",
    "renderProviderKeyStatus", "loadPostprocessApiKey",
    "updateCustomDisplayName", "renderProvider", "knownProviderId", "llmTaskGroup",
    "loadLlmProviderByTask", "saveLlmProviderByTask", "providerIdForTask", "rememberProviderForTask", "stepProviderId", "applyAutoPostprocessPlan", "initializeAutoPostprocess", "autoPlanFromControls",
  ];
  vm.runInContext(functions.map(launcherFunction).join("\n"), context);
  context.fillProviderSelects("deepseek");
  return { context, element, providers, requests, storage };
}

test("editing an unconfigured settings slot preserves the toolbox provider and loads its own key", async () => {
  const ui = providerOwnershipHarness();
  ui.element("llmProvider").value = "custom2";
  ui.context.renderProvider("custom2", { syncToolbox: false });
  assert.equal(ui.element("postprocessProvider").value, "deepseek");
  assert.equal(ui.element("llmProvider").value, "custom2");
  const request = ui.requests[0];
  assert.equal(request.payload.providerId, "custom2");
  request.resolve({ ok: true, apiKey: "test-second-slot-key", maskedApiKey: "second-mask" });
  await new Promise(setImmediate);
  assert.equal(ui.element("llmApiKey").value, "test-second-slot-key");
  assert.match(ui.element("postprocessProviderStatus").textContent, /DeepSeek/);
  assert.match(ui.element("llmKeyStatus").textContent, /toolbox_key_loaded/);
});

test("late settings key responses cannot replace another settings slot", async () => {
  const ui = providerOwnershipHarness();
  ui.context.renderProvider("custom2", { syncToolbox: false });
  ui.context.renderProvider("custom3", { syncToolbox: false });
  ui.requests[1].resolve({ ok: true, apiKey: "test-third-slot-key" });
  await new Promise(setImmediate);
  ui.requests[0].resolve({ ok: true, apiKey: "test-second-slot-key" });
  await new Promise(setImmediate);
  assert.equal(ui.element("llmApiKey").value, "test-third-slot-key");
  assert.equal(ui.element("postprocessProvider").value, "deepseek");
});

test("a filtered preferred provider keeps valid toolbox defaults and remains editable in settings", () => {
  const ui = providerOwnershipHarness();
  for (const id of ["postprocessProvider", "llmProvider"]) ui.element(id).innerHTML = "";
  ui.context.fillProviderSelects("custom2");
  assert.equal(ui.element("postprocessProvider").value, "deepseek");
  assert.equal(ui.context.stepProviderId("cleanup"), "deepseek");
  assert.equal(ui.element("llmProvider").value, "custom2");
  ui.context.renderProvider("qwen", { syncToolbox: false });
  assert.equal(ui.element("postprocessProvider").value, "deepseek");
  assert.equal(ui.element("llmProvider").value, "qwen");
});

test("renaming a hidden settings slot changes only that slot", () => {
  const ui = providerOwnershipHarness();
  ui.context.renderProvider("custom2", { syncToolbox: false });
  ui.context.updateCustomDisplayName("Named second slot");
  assert.equal(ui.providers.find(item => item.id === "custom").displayName, "First slot");
  assert.equal(ui.providers.find(item => item.id === "custom2").displayName, "Named second slot");
  assert.equal(ui.element("postprocessProvider").value, "deepseek");
  assert.equal(ui.element("llmProvider").value, "custom2");
});

test("old automatic cleanup plans restore their provider without new task memory", () => {
  const ui = providerOwnershipHarness();
  ui.context.applyAutoPostprocessPlan({ enabled: true, steps: [{ id: "match", enabled: true, aiCleanup: true, providerId: "qwen" }] });
  assert.equal(ui.element("autoStepCleanup").checked, true);
  assert.equal(ui.element("autoStepMatch").checked, false);
  assert.equal(ui.context.stepProviderId("cleanup"), "qwen");
  assert.equal(ui.context.autoPlanFromControls().steps.find(step => step.id === "cleanup").providerId, "qwen");
  assert.equal(ui.element("postprocessProvider").value, "deepseek");
});

test("cleanup restoration keeps current task memory and falls back to a visible provider", () => {
  for (const remembered of [{ cleanup: "deepseek" }, { cleanup: "custom2" }]) {
    const ui = providerOwnershipHarness({ remembered });
    ui.context.applyAutoPostprocessPlan({ steps: [{ id: "match", aiCleanup: true, providerId: "qwen" }] });
    assert.equal(ui.context.stepProviderId("cleanup"), "deepseek");
    assert.equal(ui.context.stepProviderId("cleanup"), "deepseek");
  }
});

test("legacy cleanup provider memory migrates before an older plan is applied", () => {
  for (const [remembered, expected] of [
    [{ ai_cleanup: "qwen" }, "qwen"],
    [{ ai_cleanup: "qwen", cleanup: "deepseek" }, "deepseek"],
    [{ ai_cleanup: "qwen", cleanup: "deleted-provider" }, "qwen"],
  ]) {
    const ui = providerOwnershipHarness({ remembered });
    ui.element("postprocessOperation").value = "ai_cleanup";
    ui.context.loadLlmProviderByTask();
    ui.context.window.MAWLauncher.config.postprocessAutoPlan = { enabled: true, steps: [{ id: "match", enabled: true, aiCleanup: true, providerId: "custom" }] };
    ui.context.initializeAutoPostprocess();
    assert.equal(ui.context.stepProviderId("cleanup"), expected);
    assert.equal(ui.element("postprocessProvider").value, expected);
    const stored = JSON.parse(ui.storage.get("maw.launcher.llm.provider_by_task"));
    assert.equal(stored.cleanup, expected);
    assert.equal(Object.hasOwn(stored, "ai_cleanup"), false);
  }
});

test("shared comparison option restores from every AI step and survives saving", () => {
  for (const stepId of ["cleanup", "proofread", "resegment", "translate"]) {
    const ui = providerOwnershipHarness();
    ui.context.applyAutoPostprocessPlan({ steps: [{ id: stepId, enabled: true, generateComparison: true }] });
    assert.equal(ui.element("postprocessGenerateComparison").checked, true, stepId);
    const plan = ui.context.autoPlanFromControls();
    for (const aiStep of plan.steps.filter(step => ["cleanup", "proofread", "resegment", "translate"].includes(step.id))) {
      assert.equal(aiStep.generateComparison, true, `${stepId} -> ${aiStep.id}`);
    }
  }
  const ui = providerOwnershipHarness();
  ui.context.applyAutoPostprocessPlan({ steps: [{ id: "proofread", generateComparison: false }] });
  assert.equal(ui.element("postprocessGenerateComparison").checked, false);
});

test("green-screen generation does not require or disable for missing media", () => {
  const mediaAction = source.match(/function renderMediaToolAction\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  const burnAction = source.match(/async function runBurnSubtitle\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(mediaAction, /burn\.disabled = busy;/);
  assert.doesNotMatch(mediaAction, /utilityMediaPath|mediaPath/);
  assert.match(burnAction, /if \(!greenScreen && !mediaPath\)/);
  assert.match(burnAction, /mediaPath: greenScreen \? "" : mediaPath/);
});
