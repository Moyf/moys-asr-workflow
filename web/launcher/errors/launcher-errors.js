// 消息与错误报告：日志追加、错误面板渲染、复制与反馈链接。

function appendMessageText(container, text) {
  String(text).split("\n").forEach((part, index) => {
    if (index > 0) container.append(document.createElement("br"));
    if (part) container.append(document.createTextNode(part));
  });
}
function renderMessage(container, message) {
  container.replaceChildren();
  const value = String(message || "");
  const urlPattern = /https?:\/\/[^\s<>"'|)\]}，。；：！？）】》」』]+/gi;
  let cursor = 0;
  for (const match of value.matchAll(urlPattern)) {
    const index = match.index ?? cursor;
    const rawUrl = match[0];
    const url = rawUrl.replace(/[),.;:!?，。；：！？）】》]+$/u, "");
    const trailing = rawUrl.slice(url.length);
    if (index > cursor) appendMessageText(container, value.slice(cursor, index));
    if (!url) {
      appendMessageText(container, rawUrl);
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.textContent = url;
      link.className = "status-link";
      link.addEventListener("click", (event) => { event.preventDefault(); bridge("open_url", { url }); });
      container.append(link);
      if (trailing) appendMessageText(container, trailing);
    }
    cursor = index + rawUrl.length;
  }
  if (cursor < value.length) appendMessageText(container, value.slice(cursor));
}
function releaseLink(url) {
  try {
    const parsed = new URL(String(url || ""), window.location.href);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch (_error) {
    return "";
  }
}
// Release bodies are untrusted GitHub input. Build only allowlisted DOM
// nodes so Markdown is useful without ever interpreting raw HTML.
function appendReleaseLink(container, label, url) {
  const safeUrl = releaseLink(url);
  if (!safeUrl) {
    container.append(document.createTextNode(String(label || "")));
    return;
  }
  const link = document.createElement("a");
  link.className = "update-release-link";
  link.href = safeUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = String(label || safeUrl);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void bridge("open_url", { url: safeUrl });
  });
  container.append(link);
}
function appendReleaseInline(container, value) {
  const source = String(value || "");
  let rest = source;
  while (rest) {
    const matches = [];
    const addMatch = (regex, type, priority = 0) => {
      const match = regex.exec(rest);
      if (match) matches.push({ match, type, priority });
    };
    addMatch(/`([^`\n]+)`/u, "code");
    addMatch(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/iu, "link");
    addMatch(/(\*\*|__)([^\n]+?)\1/u, "strong");
    addMatch(/(~~)([^\n]+?)\1/u, "strike");
    addMatch(/(\*|_)([^\n]+?)\1/u, "emphasis", 1);
    addMatch(/https?:\/\/[^\s<>"'`]+/iu, "url", 2);
    if (!matches.length) {
      container.append(document.createTextNode(rest));
      break;
    }
    matches.sort((left, right) => (left.match.index ?? 0) - (right.match.index ?? 0) || left.priority - right.priority);
    const chosen = matches[0];
    const match = chosen.match;
    const index = match.index ?? 0;
    if (index > 0) container.append(document.createTextNode(rest.slice(0, index)));
    if (chosen.type === "code") {
      const code = document.createElement("code");
      code.textContent = match[1];
      container.append(code);
    } else if (chosen.type === "link") {
      appendReleaseLink(container, match[1], match[2]);
    } else if (chosen.type === "url") {
      const raw = match[0];
      const url = raw.replace(/[),.;:!?，。；：！？）】》」』]+$/u, "");
      appendReleaseLink(container, url, url);
      if (raw.length > url.length) container.append(document.createTextNode(raw.slice(url.length)));
    } else {
      const element = document.createElement(chosen.type === "strong" ? "strong" : chosen.type === "strike" ? "del" : "em");
      appendReleaseInline(element, match[2]);
      container.append(element);
    }
    rest = rest.slice(index + match[0].length);
  }
}
function appendReleaseBlock(container, type, lines, marker = "") {
  const value = lines.join(" ").trim();
  if (!value) return;
  if (type === "heading") {
    const heading = document.createElement(`h${Math.max(1, Math.min(6, marker.length))}`);
    appendReleaseInline(heading, value);
    container.append(heading);
    return;
  }
  if (type === "quote") {
    const quote = document.createElement("blockquote");
    appendReleaseInline(quote, value);
    container.append(quote);
    return;
  }
  const paragraph = document.createElement("p");
  appendReleaseInline(paragraph, value);
  container.append(paragraph);
}
function renderReleaseNotes(container, markdown) {
  container.replaceChildren();
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
  let paragraph = [];
  let quote = [];
  let list = null;
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length) appendReleaseBlock(container, "paragraph", paragraph);
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length) appendReleaseBlock(container, "quote", quote);
    quote = [];
  };
  const flushList = () => {
    if (!list) return;
    const element = document.createElement(list.ordered ? "ol" : "ul");
    list.items.forEach((item) => {
      const row = document.createElement("li");
      appendReleaseInline(row, item);
      element.append(row);
    });
    container.append(element);
    list = null;
  };
  const flushCode = () => {
    if (!code) return;
    const pre = document.createElement("pre");
    const codeElement = document.createElement("code");
    if (code.language) codeElement.className = `language-${code.language}`;
    codeElement.textContent = code.lines.join("\n");
    pre.append(codeElement);
    container.append(pre);
    code = null;
  };
  for (const line of lines) {
    if (code) {
      const closing = /^\s*```\s*$/u.test(line);
      if (closing) flushCode();
      else code.lines.push(line);
      continue;
    }
    const fence = /^\s*```\s*([A-Za-z0-9_-]*)\s*$/u.exec(line);
    if (fence) {
      flushParagraph(); flushQuote(); flushList();
      code = { language: fence[1], lines: [] };
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/u.exec(line);
    if (heading) {
      flushParagraph(); flushQuote(); flushList();
      appendReleaseBlock(container, "heading", [heading[2]], heading[1]);
      continue;
    }
    const unordered = /^\s*[-+*]\s+(.+)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      flushParagraph(); flushQuote();
      const orderedList = Boolean(ordered);
      if (!list || list.ordered !== orderedList) { flushList(); list = { ordered: orderedList, items: [] }; }
      list.items.push((ordered || unordered)[1]);
      continue;
    }
    const quoteLine = /^\s*>\s?(.*)$/u.exec(line);
    if (quoteLine) {
      flushParagraph(); flushList();
      quote.push(quoteLine[1]);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/u.test(line)) {
      flushParagraph(); flushQuote(); flushList();
      container.append(document.createElement("hr"));
      continue;
    }
    if (!line.trim()) {
      flushParagraph(); flushQuote(); flushList();
      continue;
    }
    flushQuote(); flushList();
    paragraph.push(line.trim());
  }
  if (code) flushCode();
  flushParagraph(); flushQuote(); flushList();
}
const setStatus = (message) => { if (state.detectedServerUrl) setServerStatus(state.detectedServerUrl, true, message); else renderMessage($("status"), message); };
function syncFixedFooterClearance() {
  const footer = document.querySelector(".actions");
  if (!footer) return;
  const footerTop = footer.getBoundingClientRect().top;
  const clearance = Math.max(116, Math.ceil(window.innerHeight - footerTop + 24));
  document.documentElement.style.setProperty("--launcher-footer-clearance", `${clearance}px`);
  const shellScroll = document.querySelector(".shell-scroll");
  const notice = $("errorNotice");
  const status = $("status");
  if (shellScroll && notice && !notice.classList.contains("hidden")) {
    const noticeBottom = notice.getBoundingClientRect().bottom;
    const statusBottom = status?.getBoundingClientRect().bottom || noticeBottom;
    if (noticeBottom > footerTop || statusBottom > footerTop) shellScroll.scrollTop = shellScroll.scrollHeight;
  }
}
function revealErrorNotice(notice) {
  syncFixedFooterClearance();
  const shellScroll = document.querySelector(".shell-scroll");
  if (shellScroll) {
    shellScroll.scrollTop = shellScroll.scrollHeight;
    return;
  }
  notice.scrollIntoView({ behavior: "smooth", block: "nearest" });
  window.requestAnimationFrame(() => {
    const footer = document.querySelector(".actions");
    if (!footer) return;
    const overlap = notice.getBoundingClientRect().bottom - footer.getBoundingClientRect().top + 1;
    if (overlap > 0) window.scrollBy({ top: overlap, behavior: "smooth" });
  });
}
function redactSensitive(value) {
  // Cover common key/value forms and HTTP Authorization: Bearer <token>
  // output before an error report is copied out of the local Launcher.
  return String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/(["']?\b[\w.-]*(?:api[-_ ]?key|(?:access[-_ ]?)?token|secret(?:[-_ ]?(?:key|id))?|password)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[REDACTED]")
    .replace(/(["']?\bauthorization\b["']?\s*[:=]\s*bearer\s+|\bbearer\s*(?::|=|\s)\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[REDACTED]");
}
function renderErrorContext() {
  const report = state.errorReport;
  $("errorNoticeContext").textContent = !report ? "" : state.lang === "zh"
    ? `版本：${report.version}\n发生时间：${report.occurredAt.replace("T", " ")}`
    : `Version: ${report.version}\nOccurred at: ${report.occurredAt.replace("T", " ")}`;
}
function clearErrorReport() {
  state.errorReport = null;
  renderErrorContext();
  if (state.errorCopyTimer) { clearTimeout(state.errorCopyTimer); state.errorCopyTimer = 0; }
  const button = $("errorNoticeCopy");
  if (button) { button.disabled = false; button.textContent = t("error_copy_report"); }
  const diagnostics = $("errorNoticeDiagnostics");
  if (diagnostics) { diagnostics.replaceChildren(); diagnostics.classList.add("hidden"); }
}
function hideErrorNotice() {
  const notice = $("errorNotice");
  notice.classList.add("hidden");
  notice.dataset.action = "";
  clearErrorReport();
}
function showErrorNotice(message, code = "", detail = "", diagnostics = "", context = null) {
  const notice = $("errorNotice");
  const action = $("errorNoticeAction");
  const issue = $("errorNoticeIssue");
  clearErrorReport();
  const diagnostic = diagnosticText(diagnostics);
  const version = context?.version || state.config?.appVersion || $("appVersion")?.textContent?.trim().replace(/^v/, "") || "unknown";
  const occurredAt = context?.occurredAt || new Date().toISOString();
  state.errorReport = { code: code || "backend_error", message: String(message || ""), detail: String(detail || ""), diagnostics: diagnostic, version, occurredAt };
  renderErrorContext();
  $("errorNoticeTitle").textContent = t("error_notice_title");
  renderMessage($("errorNoticeMessage"), message);
  const diagnosticNode = $("errorNoticeDiagnostics");
  if (diagnosticNode) {
    renderMessage(diagnosticNode, diagnostic);
    diagnosticNode.classList.toggle("hidden", !diagnostic);
  }
  if (code === "ffmpeg_missing") {
    notice.dataset.action = "ffmpeg-settings";
    action.textContent = t("error_open_ffmpeg_settings");
    action.classList.remove("hidden");
  } else {
    notice.dataset.action = "";
    action.classList.add("hidden");
  }
  // The worker uses transcription_failed as its catch-all for unclassified
  // runtime exceptions, so it must retain the Issue route despite having a
  // friendly localized message.
  const knownCode = Boolean(code && code !== "transcription_failed" && Object.prototype.hasOwnProperty.call(ERROR_TEXT.zh, code));
  issue.classList.toggle("hidden", knownCode);
  notice.classList.remove("hidden");
  revealErrorNotice(notice);
}
function errorReportText() {
  const report = state.errorReport;
  if (!report) return "";
  const version = report.version;
  const log = redactSensitive($("log")?.textContent || "");
  const labels = state.lang === "zh"
    ? { title: "MAW Launcher 错误报告", version: "版本", code: "错误码", message: "提示", detail: "详细信息", diagnostics: "诊断信息", log: "日志" }
    : { title: "MAW Launcher error report", version: "Version", code: "Error code", message: "Message", detail: "Detail", diagnostics: "Diagnostics", log: "Log" };
  const message = compactDetail(report.message);
  const detail = compactDetail(report.detail);
  const diagnostics = compactDetail(report.diagnostics);
  return [
    labels.title,
    ...(diagnostics ? [labels.diagnostics + ": " + redactSensitive(report.diagnostics)] : []),
    `${labels.version}: ${redactSensitive(version)}`,
    `${state.lang === "zh" ? "发生时间" : "Occurred at"}: ${report.occurredAt}`,
    `${labels.code}: ${redactSensitive(report.code)}`,
    `${labels.message}: ${redactSensitive(report.message)}`,
    ...(detail && detail !== message ? [`${labels.detail}: ${redactSensitive(report.detail)}`] : []),
    `${labels.log}:`,
    log,
  ].join("\n");
}
function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } finally { area.remove(); }
  return copied;
}
function setCopyReportButton(key) {
  const button = $("errorNoticeCopy");
  if (!button) return;
  button.disabled = key !== "error_copy_report";
  button.textContent = t(key);
  if (state.errorCopyTimer) clearTimeout(state.errorCopyTimer);
  if (key !== "error_copy_report") {
    state.errorCopyTimer = setTimeout(() => { state.errorCopyTimer = 0; if (state.errorReport) setCopyReportButton("error_copy_report"); }, 2200);
  }
}
async function copyErrorReport() {
  const text = errorReportText();
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); }
      catch (_error) { if (!fallbackCopy(text)) throw new Error("clipboard fallback failed"); }
    } else if (!fallbackCopy(text)) {
      throw new Error("clipboard fallback failed");
    }
    setCopyReportButton("error_copy_report_success");
  } catch (_error) {
    setCopyReportButton("error_copy_report_failed");
  }
}
async function openErrorFaq() {
  try {
    const result = await window.MAWLauncher.callBackend("open_faq");
    if (result?.ok) return;
    const detail = result?.detail || result?.error || t("error_open_faq_failed");
    setStatus(detail);
    appendLog(`[error] open_faq: ${detail}`);
  } catch (error) {
    const detail = error?.message || String(error || t("error_open_faq_failed"));
    setStatus(detail);
    appendLog(`[error] open_faq: ${detail}`);
  }
}
async function openErrorIssue() {
  try {
    const result = await window.MAWLauncher.callBackend("open_url", { url: "https://github.com/Moyf/moys-asr-workflow" });
    if (result?.ok) return;
    const detail = result?.detail || result?.error || t("error_open_issue_failed");
    setStatus(detail);
    appendLog(`[error] open_issue: ${detail}`);
  } catch (error) {
    const detail = error?.message || String(error || t("error_open_issue_failed"));
    setStatus(detail);
    appendLog(`[error] open_issue: ${detail}`);
  }
}

// 编辑器服务器状态监控与轮询，含 appendLog/confirm 桥。
