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
  assert.match(html, /<nav id="toolboxUtilitiesTabList" class="toolbox-tabs" role="tablist"/);
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

function greenScreenBurnHarness({ includeAudio = false, mediaPath = "" } = {}) {
  const elements = new Map(Object.entries({
    toolboxGreenScreen: { checked: true },
    toolboxGreenScreenIncludeAudio: { checked: includeAudio },
    toolboxUtilityMediaPath: { value: mediaPath },
    toolboxBurnSubtitlePath: { value: "D:/Demo/captions.ass" },
    toolboxGreenScreenSize: { value: "1080p" },
    toolboxBurnVideoEncoder: { value: "cpu" },
  }));
  const runs = [], errors = new Map();
  const context = vm.createContext({
    $: id => elements.get(id), busy: false, mediaToolRunning: false, mediaToolCancelling: false,
    utilityMediaManual: false,
    t: key => key, setResult() {}, setFieldError: (id, message) => errors.set(id, message),
    validateBurnEncoding: () => true, burnEncodingPayload: () => ({}),
    beginMediaToolLog() {}, setBusy() {}, syncPaths() {}, refreshAudioTracks() {}, renderMediaToolAction() {},
    bridge: async (method, payload) => {
      runs.push({ method, payload });
      return { ok: true, mediaPath: "D:/Demo/green-screen.mp4" };
    },
  });
  const constants = ["SUBTITLE_BURN_EXTS", "MEDIA_EXTS", "VIDEO_EXTS"].map(name => {
    const match = source.match(new RegExp(`^  const ${name} = .+;$`, "m"));
    assert.ok(match, `missing ${name}`);
    return match[0];
  });
  vm.runInContext([...constants, launcherFunction("extension"), launcherFunction("runBurnSubtitle")].join("\n"), context);
  return { runs, errors, run: () => context.runBurnSubtitle() };
}

test("silent green-screen generation does not require or disable for missing media", async () => {
  const mediaAction = source.match(/function renderMediaToolAction\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(mediaAction, /burn\.disabled = busy;/);
  assert.doesNotMatch(mediaAction, /utilityMediaPath|mediaPath/);
  for (const mediaPath of ["", "D:/Demo/unused.mp3"]) {
    const ui = greenScreenBurnHarness({ mediaPath });
    await ui.run();
    assert.equal(ui.runs.length, 1);
    assert.equal(ui.runs[0].method, "run_burn_subtitles");
    assert.equal(ui.runs[0].payload.mediaPath, "");
    assert.equal(ui.runs[0].payload.greenScreen, true);
    assert.equal(ui.runs[0].payload.greenScreenIncludeAudio, false);
    assert.equal(ui.errors.get("toolboxUtilityMediaPath"), "");
  }
});

test("green-screen audio retains supported audio and video sources", async () => {
  for (const mediaPath of ["D:/Demo/voice.mp3", "D:/Demo/video.mp4"]) {
    const ui = greenScreenBurnHarness({ includeAudio: true, mediaPath });
    await ui.run();
    assert.equal(ui.runs.length, 1);
    assert.equal(ui.runs[0].payload.mediaPath, mediaPath);
    assert.equal(ui.runs[0].payload.greenScreenIncludeAudio, true);
  }
});

test("green-screen audio rejects missing or unsupported sources before starting", async () => {
  for (const mediaPath of ["", "D:/Demo/document.txt"]) {
    const ui = greenScreenBurnHarness({ includeAudio: true, mediaPath });
    await ui.run();
    assert.equal(ui.runs.length, 0);
    assert.equal(ui.errors.get("toolboxUtilityMediaPath"), "toolbox_green_screen_audio_required");
  }
});

// 回归：口播整理 / AI 校对勾选门槛（provider 绑定与验证状态）。
function providerGateHarness({ providers, storedTaskMemory = {}, backendProviders = null } = {}) {
  const fields = {
    postprocessProvider: { value: "deepseek", options: [{ value: "deepseek" }, { value: "custom" }] },
    postprocessOperation: { value: "ai_cleanup" },
    postprocessCleanupScriptPath: { value: "" },
    postprocessResegmentMaxChars: { value: "" },
    llmProvider: { value: "deepseek" },
    llmApiKey: { value: "demo-key" },
    llmBaseUrl: { value: "https://api.deepseek.com" },
    llmModel: { value: "deepseek-chat" },
    llmReasoningMode: { value: "off" },
    testLlmConnection: {}, getLlmModels: {},
    autoStepCleanup: { checked: false }, autoStepProofread: { checked: false },
    settingsModal: { classList: { add() {} } },
    llmKeyStatus: { textContent: "" },
    postprocessProviderStatus: { textContent: "" },
  };
  const storage = { "maw.launcher.llm.provider_by_task": JSON.stringify(storedTaskMemory) };
  const localStorageStub = {
    getItem: (key) => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = String(value); },
  };
  const openedSettings = [];
  const context = vm.createContext({
    console,
    window: { MAWLauncher: { config: { postprocessProviders: providers }, openSettings: (section, focus) => openedSettings.push({ section, focus }) }, localStorage: localStorageStub },
    document: { querySelector: () => null },
    $: (id) => fields[id] || { value: "", textContent: "" },
    localStorage: localStorageStub,
    t: (key) => key,
    SCRIPT_EXTS: new Set([".txt", ".md", ".markdown"]),
    LLM_PROVIDER_TASK_GROUPS: { translate_zh: "translate", translate_en: "translate", proofread: "proofread", resegment: "resegment", custom: "custom", ai_cleanup: "cleanup" },
    AUTO_LLM_OPERATIONS: { cleanup: "ai_cleanup", proofread: "proofread", resegment: "resegment" },
    LLM_PROVIDER_BY_TASK_KEY: "maw.launcher.llm.provider_by_task",
    extension: (path) => (String(path || "").match(/\.[^.\\/]+$/u)?.[0] || "").toLowerCase(),
    resegmentMaxCharsValid: () => true,
    parseReplacements: () => [],
    bridge: async (method) => {
      if (method === "get_config") return { postprocessProviders: (backendProviders ?? providers).map((item) => ({ ...item })) };
      return { ok: true };
    },
    // openAutoStep 的完整 UI 链路不在本 harness 范围；记录调用参数即可。
    openAutoStep: (stepId, invalidField, options) => {
      context.setPendingAutoStep(stepId);
      openedSettings.push({ blockedStep: stepId, invalidField, options });
    },
    busy: false,
    AUTO_STEP_CHECKBOXES: { cleanup: "autoStepCleanup", proofread: "autoStepProofread" },
    setTestConnectionAttention() {}, setSettingsSaveStatus() {}, clearSettingsErrors() {}, fillProviderSelects() {},
    providerLabel: (item) => item.label,
    renderProviderKeyStatus() {},
    renderAutoPostprocessState() {},
    persistAutoPlanSoon() {},
  });
  const names = [
    "llmTaskGroup", "loadLlmProviderByTask", "saveLlmProviderByTask", "knownProviderId",
    "providerIdForTask", "rememberProviderForTask", "stepProviderId",
    "isCustomSlot", "customSlotVisibleInToolbox", "provider", "autoLlmOperation", "autoLlmReady",
    "autoStepReady", "refreshPostprocessProviderStatus", "bindPendingStepProvider", "confirmAutoStepCheck",
    "cancelPendingAutoStep", "maybeEnablePendingAutoStep", "llmSettingsState", "acceptLlmSettingsResponse", "saveSettings", "testConnection",
  ];
  vm.runInContext(names.map((name) => launcherFunction(name)).join("\n"), context);
  vm.runInContext(`
    var pendingAutoStep = "";
    var pendingAutoStepRequest = null;
    var autoStepCheckRequests = new Map();
    var llmSettingsRequest = 0;
    var providerSettingsRequests = new Map();
    var providerStatusRequest = 0;
    var providerStatusApplied = 0;
    var llmProviderByTask = {};
    loadLlmProviderByTask();
    var getPendingAutoStep = () => pendingAutoStep;
    var setPendingAutoStep = (value) => { pendingAutoStep = value; pendingAutoStepRequest = {}; };
  `, context);
  context.window.MAWLauncher.onSettingsClosed = context.cancelPendingAutoStep;
  const settingsSource = readFileSync(new URL("boot/launcher-settings-startup.js", launcherDir), "utf8");
  vm.runInContext(settingsSource.match(/function closeSettings\(\) \{[\s\S]*?\n\}/u)[0], context);
  return {
    context,
    fields,
    openedSettings,
    ready: () => context.autoStepReady("cleanup"),
    setPending: (value) => context.setPendingAutoStep(value),
    getPending: () => context.getPendingAutoStep(),
  };
}

function providerStub(overrides = {}) {
  return {
    id: "deepseek", label: "DeepSeek", defaultLabel: "DeepSeek", baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat", reasoningMode: "off", maskedApiKey: "", verified: false,
    hasApiKey: false, apiKeyRequired: true, hasBaseUrl: true, hasModel: true, selected: true,
    ...overrides,
  };
}

test("verified local-model provider unblocks the cleanup checkbox after dialog test connection", async () => {
  // 症状 1：任务记忆把口播整理钉在 deepseek，用户在设置弹窗验证的是本地模型（custom，回环地址允许空 Key）。
  const providers = [
    providerStub({ id: "deepseek" }),
    providerStub({
      id: "custom", label: "Gemma", baseUrl: "http://127.0.0.1:1234/v1", model: "google/gemma-4-e4b",
      verified: true, apiKeyRequired: false, hasApiKey: false, hasBaseUrl: true, hasModel: true, selected: false,
    }),
  ];
  const gate = providerGateHarness({ providers, storedTaskMemory: { cleanup: "deepseek" } });
  assert.equal(gate.ready(), false, "验证 custom 前门槛应拦截（记忆指向未验证的 deepseek）");
  gate.setPending("cleanup");
  // 设置弹窗里测试连接成功（testConnection 成功分支调用 bindPendingStepProvider(item.id)）。
  assert.equal(gate.context.bindPendingStepProvider("custom"), true);
  assert.equal(gate.ready(), true, "验证成功后应放行：步骤改用已验证的 custom，回环地址允许空 Key");
  assert.equal(gate.context.stepProviderId("cleanup"), "custom");
  assert.equal(JSON.parse(gate.context.localStorage.getItem("maw.launcher.llm.provider_by_task")).cleanup, "custom");
});

test("stale unverified cache no longer reopens the settings dialog when backend says verified", async () => {
  // 症状 2：勾选→取消→再勾选不再重复弹配置。内存标记过期（false）但后端权威状态已验证 → 静默放行。
  const providers = [providerStub({ id: "deepseek", verified: false, hasApiKey: true })];
  const backend = [providerStub({ id: "deepseek", verified: true, hasApiKey: true })];
  const gate = providerGateHarness({ providers, storedTaskMemory: { cleanup: "deepseek" }, backendProviders: backend });
  assert.equal(gate.ready(), false, "过期缓存下同步门槛会拦截");
  gate.setPending("cleanup");
  const checkbox = { checked: true };
  await gate.context.confirmAutoStepCheck("cleanup", checkbox);
  assert.equal(checkbox.checked, true, "后端确认已验证：保留勾选");
  assert.equal(gate.openedSettings.length, 0, "不应再弹配置弹窗");
  assert.equal(gate.context.autoLlmReady("deepseek"), true, "缓存已按后端权威状态刷新");
});

test("genuinely unverified provider still blocks the checkbox and opens settings", async () => {
  // 后端权威状态确实未验证：维持原有拦截行为（取消勾选 + 打开配置并高亮测试连接）。
  const providers = [providerStub({ id: "deepseek" })];
  const gate = providerGateHarness({ providers, storedTaskMemory: { cleanup: "deepseek" }, backendProviders: [providerStub({ id: "deepseek" })] });
  gate.setPending("cleanup");
  const checkbox = { checked: true };
  await gate.context.confirmAutoStepCheck("cleanup", checkbox);
  assert.equal(checkbox.checked, false, "确实未验证：取消勾选");
  assert.equal(gate.openedSettings.length, 1);
  assert.equal(gate.openedSettings[0].blockedStep, "cleanup");
  assert.equal(gate.openedSettings[0].options.highlightConnection, true);
  assert.equal(gate.getPending(), "cleanup", "保留待处理步骤，验证成功后自动补勾选");
});

test("dialog verification rebinds the pending auto step and refreshes stale state", () => {
  // 契约：验证/保存成功后绑定供应商；勾选被拦先刷新权威状态；弹窗预选门槛检查的供应商。
  const saveBlock = source.slice(source.indexOf("async function saveSettings()"), source.indexOf("async function testConnection()"));
  const testBlock = source.slice(source.indexOf("async function testConnection()"), source.indexOf("async function getModels()"));
  assert.match(saveBlock, /if \(result\.verified\) bindPendingStepProvider\(item\.id, pendingRequest\);/);
  assert.match(saveBlock, /maybeEnablePendingAutoStep\(pendingRequest\);/);
  assert.match(testBlock, /bindPendingStepProvider\(item\.id, pendingRequest\);/);
  assert.match(source, /if \(\$\("llmProvider"\)\.value !== checkedProviderId\) renderProvider\(checkedProviderId, \{ syncToolbox: false \}\);/);
  assert.match(source, /void confirmAutoStepCheck\(stepId, checkbox\);/);
  assert.match(source, /await refreshPostprocessProviderStatus\(isCurrent\);/);
});

test("dismissed setup cannot bind or enable a step during an unrelated provider test", async () => {
  const gate = providerGateHarness({ providers: [providerStub()] });
  gate.setPending("cleanup");
  gate.context.closeSettings();
  gate.context.bridge = async () => ({ ok: true, verified: true, saved: true });
  await gate.context.testConnection();
  assert.equal(gate.getPending(), "");
  assert.equal(gate.fields.autoStepCleanup.checked, false);
  assert.equal(gate.context.localStorage.getItem("maw.launcher.llm.provider_by_task"), "{}");
});

test("an active setup still binds and enables its step after successful verification", async () => {
  const gate = providerGateHarness({ providers: [providerStub()] });
  gate.setPending("cleanup");
  gate.context.bridge = async () => ({ ok: true, verified: true, saved: true });
  await gate.context.testConnection();
  assert.equal(gate.fields.autoStepCleanup.checked, true);
  assert.equal(gate.getPending(), "");
});

for (const method of ["testConnection", "saveSettings"]) {
  for (const field of ["llmProvider", "llmBaseUrl", "llmModel", "llmApiKey", "llmReasoningMode"]) {
    test(`${method} ignores a reply after the settings field ${field} changes`, async () => {
      const gate = providerGateHarness({ providers: [providerStub(), providerStub({ id: "custom" })] });
      gate.setPending("cleanup");
      let finish;
      gate.context.bridge = () => new Promise(resolve => { finish = resolve; });
      const oldAction = gate.context[method]();
      gate.fields[field].value = field === "llmProvider" ? "custom" : "changed";
      finish({ ok: true, verified: true, saved: true, baseUrl: "https://api.deepseek.com" });
      await oldAction;
      assert.equal(gate.fields[field].value, field === "llmProvider" ? "custom" : "changed");
      assert.equal(gate.fields.autoStepCleanup.checked, false);
      assert.equal(gate.getPending(), "cleanup");
      assert.equal(gate.context.localStorage.getItem("maw.launcher.llm.provider_by_task"), "{}");
    });
  }
  test(`${method} ignores the previous setup request after close and reopen`, async () => {
    const gate = providerGateHarness({ providers: [providerStub()] });
    gate.setPending("cleanup");
    let finish;
    gate.context.bridge = () => new Promise((resolve) => { finish = resolve; });
    const oldAction = gate.context[method]();
    gate.context.closeSettings();
    gate.setPending("proofread");
    finish({ ok: true, verified: true, saved: true });
    await oldAction;
    assert.equal(gate.fields.autoStepCleanup.checked, false);
    assert.equal(gate.fields.autoStepProofread.checked, false);
    assert.equal(gate.getPending(), "proofread");
    assert.equal(gate.context.localStorage.getItem("maw.launcher.llm.provider_by_task"), "{}");
  });
}

test("unchecked steps ignore a pending provider refresh", async () => {
  const gate = providerGateHarness({ providers: [providerStub()] });
  let finish;
  gate.context.bridge = () => new Promise((resolve) => { finish = resolve; });
  const checkbox = { checked: true };
  const checking = gate.context.confirmAutoStepCheck("cleanup", checkbox);
  checkbox.checked = false;
  finish({ postprocessProviders: [providerStub()] });
  await checking;
  assert.equal(checkbox.checked, false);
  assert.equal(gate.openedSettings.length, 0);
  assert.equal(gate.getPending(), "");
});

test("a saved configuration still invalidates cached readiness when the user has edited the form again", async () => {
  const gate = providerGateHarness({ providers: [providerStub({ verified: true, hasApiKey: true })] });
  gate.fields.llmModel.value = "saved-model";
  let finish;
  gate.context.bridge = () => new Promise(resolve => { finish = resolve; });
  const saving = gate.context.saveSettings();
  gate.fields.llmModel.value = "next-edit";
  finish({ ok: true, verified: false, model: "saved-model" });
  await saving;
  assert.equal(gate.fields.llmModel.value, "next-edit");
  assert.equal(gate.ready(), false);
});

test("an older save cannot invalidate a later successful test of the same provider", async () => {
  const gate = providerGateHarness({ providers: [providerStub({ verified: true, hasApiKey: true })] });
  const replies = [];
  gate.context.bridge = () => new Promise(resolve => replies.push(resolve));
  const saving = gate.context.saveSettings();
  gate.fields.llmModel.value = "new-model";
  const testing = gate.context.testConnection();
  replies[1]({ ok: true, verified: true });
  await testing;
  replies[0]({ ok: true, verified: false });
  await saving;
  assert.equal(gate.fields.llmModel.value, "new-model");
  assert.equal(gate.ready(), true);
});

test("out-of-order provider refreshes cannot undo the latest choice or readiness", async () => {
  const gate = providerGateHarness({ providers: [providerStub()] });
  const replies = [];
  gate.context.bridge = () => new Promise((resolve) => replies.push(resolve));
  const checkbox = { checked: true };
  const oldCheck = gate.context.confirmAutoStepCheck("cleanup", checkbox);
  checkbox.checked = false;
  checkbox.checked = true;
  const newCheck = gate.context.confirmAutoStepCheck("cleanup", checkbox);
  replies[1]({ postprocessProviders: [providerStub({ verified: true, hasApiKey: true })] });
  await newCheck;
  replies[0]({ postprocessProviders: [providerStub()] });
  await oldCheck;
  assert.equal(checkbox.checked, true);
  assert.equal(gate.openedSettings.length, 0);
  assert.equal(gate.context.autoLlmReady("deepseek"), true);
});

test("out-of-order refreshes from different steps share the newest provider state", async () => {
  const gate = providerGateHarness({ providers: [providerStub()] });
  const replies = [];
  gate.context.bridge = () => new Promise(resolve => replies.push(resolve));
  const cleanup = { checked: true };
  const proofread = { checked: true };
  const oldCheck = gate.context.confirmAutoStepCheck("cleanup", cleanup);
  const newCheck = gate.context.confirmAutoStepCheck("proofread", proofread);
  replies[1]({ postprocessProviders: [providerStub({ verified: true, hasApiKey: true })] });
  await newCheck;
  replies[0]({ postprocessProviders: [providerStub()] });
  await oldCheck;
  assert.equal(cleanup.checked, true);
  assert.equal(proofread.checked, true);
  assert.equal(gate.openedSettings.length, 0);
  assert.equal(gate.ready(), true);
});

test("mock providers preserve saved readiness and independently named custom slots after refresh", async () => {
  const mockSource = readFileSync(new URL("boot/launcher-mock-api.js", launcherDir), "utf8");
  const context = vm.createContext({
    URL, navigator: { platform: "Win32" }, localStorage: { getItem: () => null },
    LAST_MODEL_KEY: "model", LAST_LANGUAGE_KEY: "language", ZOOM_PERCENT_KEY: "zoom", ZOOM_DEFAULT: 100,
    OPENAI_ASR_CUSTOM_MODEL_ID: "custom",
    state: { config: {} }, isCustomSlotId: (id) => /^custom[23]?$/u.test(id),
  });
  vm.runInContext(mockSource, context);
  const api = context.mockApi();
  const local = { providerId: "custom", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", apiKey: "", displayName: "Local", save: true };
  await api.test_postprocess_connection(local);
  await api.test_postprocess_connection({ providerId: "deepseek", apiKey: "demo-key", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", save: true });
  await api.save_postprocess_settings({ providerId: "custom2", displayName: "Second", baseUrl: "https://example.test/v1", model: "second-model", apiKey: "second-key" });
  const config = await api.get_config();
  const providers = config.postprocessProviders;
  const first = providers.find((item) => item.id === "custom");
  assert.equal(first.label, "Local");
  assert.equal(first.baseUrl, local.baseUrl);
  assert.equal(first.model, local.model);
  assert.equal(first.verified, true);
  assert.equal(first.apiKeyRequired, false);
  assert.equal(first.hasApiKey, false);
  assert.equal(first.hasBaseUrl && first.hasModel, true);
  assert.equal(providers.find((item) => item.id === "custom2").label, "Second");
  assert.equal(providers.find((item) => item.id === "deepseek").hasApiKey, true);
  const gate = providerGateHarness({ providers, storedTaskMemory: { cleanup: "custom" }, backendProviders: providers });
  await gate.context.confirmAutoStepCheck("proofread", { checked: true });
  assert.equal(gate.ready(), true, "refreshing another step must preserve the verified local provider");
  assert.equal((await api.save_postprocess_settings(local)).verified, true);
  assert.equal((await api.save_postprocess_settings({ ...local, displayName: "Renamed", reasoningMode: "on" })).verified, true);
  assert.equal((await api.save_postprocess_settings({ ...local, model: "changed" })).verified, false);
});
