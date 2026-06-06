const TEST_CONFIG_BASE_ENDPOINT = "https://reborned.cc";
const TEST_CONFIG_FILE = "test.yaml";

const CONFIG_BASE_URL = getConfigBaseUrl();
const CHECK_TIMEOUT_MS = 10000;
const MAX_RESPONSE_CHARS = 120000;
const CLIENT_IP_ENDPOINT = "https://api.ipify.org?format=json";

const state = {
  accessCode: "",
  configUrl: "",
  startedAt: null,
  finishedAt: null,
  clientIp: "No disponible",
  userAgent: navigator.userAgent,
  config: null,
  tests: [],
  executionStatus: "idle",
  executionError: null,
};

const dom = {
  form: document.querySelector("#access-form"),
  codeInput: document.querySelector("#access-code"),
  startButton: document.querySelector("#start-button"),
  statusText: document.querySelector("#status-text"),
  progressBar: document.querySelector("#progress-bar"),
  clientIp: document.querySelector("#client-ip"),
  clientAgent: document.querySelector("#client-agent"),
  resultsList: document.querySelector("#results-list"),
  pdfButton: document.querySelector("#pdf-button"),
  jsonButton: document.querySelector("#json-button"),
  shareButton: document.querySelector("#share-button"),
  reportStage: document.querySelector("#report-stage"),
};

document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  dom.clientAgent.textContent = state.userAgent;
  dom.form.addEventListener("submit", handleStart);
  dom.pdfButton.addEventListener("click", downloadPdfReport);
  dom.jsonButton.addEventListener("click", () => downloadBlob(buildReportJson(), "application/json", "reporte-bloqueos.json"));
  dom.shareButton.addEventListener("click", shareReport);
  dom.shareButton.hidden = !isShareAvailable();
});

async function handleStart(event) {
  event.preventDefault();

  const accessCode = dom.codeInput.value.trim();
  if (!accessCode) {
    setStatus("Codigo requerido");
    dom.codeInput.focus();
    return;
  }

  resetState(accessCode);
  setBusy(true);
  setReportMessage("Probando", "loader-circle", true);
  updateCounters();

  try {
    state.executionStatus = "running";
    setStatus("Probando");
    state.clientIp = await getClientIp();
    dom.clientIp.textContent = state.clientIp;

    state.configUrl = buildAccessConfigUrl(accessCode);
    const rawConfig = await fetchConfig(state.configUrl);
    state.config = normalizeConfig(rawConfig);
    state.tests = buildTestMatrix(state.config);

    if (!state.tests.length) {
      throw new Error("La configuracion no contiene combinaciones validas.");
    }

    updateCounters();
    setReportMessage("Probando", "loader-circle", true);
    await runTests();
    state.finishedAt = new Date().toISOString();
    state.executionStatus = "completed";
    setStatus("Completado");
    setReportMessage("Reporte listo para descargar", "circle-check");
    enableReportActions(true);
  } catch (error) {
    state.finishedAt = new Date().toISOString();
    state.executionStatus = "error";
    state.executionError = buildExecutionError(error);
    setStatus("No se pudo ejecutar");
    setReportMessage("Reporte listo con el motivo del error", "circle-alert");
    enableReportActions(true);
  } finally {
    setBusy(false);
    updateCounters();
  }
}

function resetState(accessCode) {
  state.accessCode = accessCode;
  state.configUrl = "";
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.clientIp = "No disponible";
  state.config = null;
  state.tests = [];
  state.executionStatus = "idle";
  state.executionError = null;
  dom.clientIp.textContent = "Pendiente";
  dom.progressBar.style.width = "0%";
  enableReportActions(false);
}

async function getClientIp() {
  try {
    const data = await fetchJson(CLIENT_IP_ENDPOINT, { timeout: 5000 });
    return data.ip || "No disponible";
  } catch {
    return "No disponible";
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    timeout: options.timeout || CHECK_TIMEOUT_MS,
    headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`No se pudo leer ${url} (${response.status})`);
  }

  return response.json();
}

async function fetchConfig(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    timeout: options.timeout || CHECK_TIMEOUT_MS,
    headers: { Accept: "application/x-yaml, text/yaml, application/yaml, application/json, text/plain;q=0.9, */*;q=0.8" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`No se pudo leer ${url} (${response.status})`);
  }

  const text = await response.text();

  if (/\.ya?ml(?:$|\?)/i.test(url)) {
    if (!window.jsyaml?.load) {
      throw new Error("No se pudo cargar el parser YAML.");
    }

    return window.jsyaml.load(text);
  }

  return JSON.parse(text);
}

function buildAccessConfigUrl(code) {
  if (!CONFIG_BASE_URL) {
    throw new Error("Configura TEST_CONFIG_BASE_ENDPOINT en app.js.");
  }

  const base = CONFIG_BASE_URL.replace(/\/+$/, "");
  const normalizedCode = code
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `${base}/${normalizedCode}/${TEST_CONFIG_FILE}`;
}

function getConfigBaseUrl() {
  const endpoint = window.CHECK_BLOCK_CONFIG_BASE_URL || TEST_CONFIG_BASE_ENDPOINT;

  if (endpoint) {
    return endpoint;
  }

  if (window.location.protocol === "file:") {
    return "";
  }

  return window.location.origin;
}

function normalizeConfig(rawConfig) {
  const defaultPorts = normalizePortSet(rawConfig.PORTS);
  const ipTargets = normalizeTargets(rawConfig.IP, "ip", defaultPorts);
  const dnsTargets = normalizeTargets(rawConfig.DNS, "domain", defaultPorts);

  return {
    ips: ipTargets.map((target) => target.host),
    domains: dnsTargets.map((target) => target.host),
    httpPorts: defaultPorts.HTTP,
    httpsPorts: defaultPorts.HTTPS,
    targets: [...ipTargets, ...dnsTargets],
    raw: rawConfig,
  };
}

function normalizeTargets(value, hostType, defaultPorts) {
  const items = getTargetItems(value);

  return items
    .map((item) => {
      const target = parseTargetItem(item, hostType);
      if (!target.host) return null;

      const portSet = target.customPorts ? normalizePortSet(target.customPorts) : defaultPorts;

      return {
        host: target.host,
        hostType,
        httpPorts: portSet.HTTP,
        httpsPorts: portSet.HTTPS,
        usesDefaultPorts: !target.customPorts,
      };
    })
    .filter(Boolean);
}

function getTargetItems(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    return Object.entries(value).map(([host, config]) => ({ [host]: config }));
  }

  return normalizeList(value);
}

function parseTargetItem(item, hostType) {
  if (!item || typeof item !== "object") {
    return { host: String(item || "").trim(), customPorts: null };
  }

  const namedHost = item.HOST || item.host || item.VALUE || item.value || item.ADDRESS || item.address || (hostType === "ip" ? item.IP : item.DNS);

  if (namedHost) {
    return {
      host: String(namedHost).trim(),
      customPorts: item.PORTS && typeof item.PORTS === "object" ? item.PORTS : null,
    };
  }

  const entries = Object.entries(item).filter(([, config]) => config && typeof config === "object");
  const [host, config] = entries[0] || [];

  return {
    host: String(host || "").trim(),
    customPorts: config?.PORTS && typeof config.PORTS === "object" ? config.PORTS : null,
  };
}

function normalizePortSet(value) {
  const ports = value && typeof value === "object" ? value : {};

  return {
    HTTP: normalizePorts(ports.HTTP),
    HTTPS: normalizePorts(ports.HTTPS),
  };
}

function normalizeList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizePorts(value) {
  return normalizeList(value)
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function buildTestMatrix(config) {
  const tests = [];
  const seenUrls = new Set();

  for (const target of config.targets) {
    for (const port of target.httpPorts) {
      addUniqueTest(tests, seenUrls, createTest("http", target.host, port, target.hostType, target.usesDefaultPorts));
    }

    if (target.hostType === "ip") {
      continue;
    }

    for (const port of target.httpsPorts) {
      addUniqueTest(tests, seenUrls, createTest("https", target.host, port, target.hostType, target.usesDefaultPorts));
    }
  }

  return tests;
}

function addUniqueTest(tests, seenUrls, test) {
  if (seenUrls.has(test.url)) return;
  seenUrls.add(test.url);
  tests.push(test);
}

function createTest(protocol, host, port, hostType, usesDefaultPorts) {
  const defaultPort = (protocol === "http" && port === 80) || (protocol === "https" && port === 443);
  const url = `${protocol}://${host}${defaultPort ? "" : `:${port}`}/check.json`;

  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `${protocol}-${host}-${port}-${Math.random()}`,
    protocol,
    host,
    hostType,
    usesDefaultPorts,
    port,
    url,
    status: "pending",
    ok: false,
    httpStatus: null,
    contentType: "",
    durationMs: null,
    responseText: "",
    error: "",
    isWebResponse: false,
    startedAt: null,
    finishedAt: null,
  };
}

async function runTests() {
  for (let index = 0; index < state.tests.length; index += 1) {
    const test = state.tests[index];
    setStatus("Probando");
    await runSingleTest(test);
    updateCounters();
  }
}

async function runSingleTest(test) {
  test.status = "running";
  test.startedAt = new Date().toISOString();

  const started = performance.now();

  try {
    const response = await fetchWithTimeout(test.url, {
      timeout: CHECK_TIMEOUT_MS,
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "application/json, text/plain;q=0.9, text/html;q=0.8, */*;q=0.7" },
    });
    const contentType = response.headers.get("content-type") || "";
    const responseText = await response.text();

    test.httpStatus = response.status;
    test.contentType = contentType;
    test.responseText = trimResponse(responseText);
    test.isWebResponse = isHtmlResponse(contentType, responseText);
    test.ok = response.ok && responseText.trim().toUpperCase().includes("OK");
    test.status = test.ok ? "success" : "error";
  } catch (error) {
    test.error = error.name === "AbortError" ? "Tiempo de espera agotado" : error.message;
    test.status = "error";
  } finally {
    test.durationMs = Math.round(performance.now() - started);
    test.finishedAt = new Date().toISOString();
  }
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || CHECK_TIMEOUT_MS);

  return fetch(url, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    ...options,
    signal: controller.signal,
  }).finally(() => window.clearTimeout(timeout));
}

function trimResponse(text) {
  if (!text) return "";
  return text.length > MAX_RESPONSE_CHARS ? `${text.slice(0, MAX_RESPONSE_CHARS)}\n\n[Respuesta truncada]` : text;
}

function isHtmlResponse(contentType, body) {
  return contentType.includes("text/html") || /<!doctype html|<html[\s>]/i.test(body);
}

function renderResults() {
  setReportMessage("El reporte estara disponible al finalizar", "radar");
}

function updateCounters() {
  const completed = state.tests.filter((test) => test.status !== "pending" && test.status !== "running").length;
  const total = state.tests.length;

  dom.progressBar.style.width = total ? `${Math.round((completed / total) * 100)}%` : "0%";
}

function setStatus(text) {
  dom.statusText.textContent = text;
}

function setReportMessage(text, iconName = "radar", isSpinning = false) {
  const spinValue = String(isSpinning);
  const isSameMessage =
    dom.resultsList.dataset.message === text &&
    dom.resultsList.dataset.icon === iconName &&
    dom.resultsList.dataset.spinning === spinValue;

  if (isSameMessage) {
    return;
  }

  dom.resultsList.dataset.message = text;
  dom.resultsList.dataset.icon = iconName;
  dom.resultsList.dataset.spinning = spinValue;
  dom.resultsList.className = "results-list empty-state";
  dom.resultsList.innerHTML = `
    <i class="${isSpinning ? "spin-icon" : ""}" data-lucide="${escapeAttribute(iconName)}"></i>
    <p>${escapeHtml(text)}</p>
  `;
  lucide.createIcons();
}

function buildExecutionError(error) {
  return {
    message: error?.message || "Error inesperado",
    name: error?.name || "Error",
    stack: error?.stack || "",
  };
}

function setBusy(isBusy) {
  dom.startButton.disabled = isBusy;
  dom.codeInput.disabled = isBusy;
}

function enableReportActions(enabled) {
  dom.pdfButton.disabled = !enabled;
  dom.jsonButton.disabled = !enabled;
  dom.shareButton.disabled = !enabled || !isShareAvailable();
}

function isShareAvailable() {
  const isMobileOrTablet = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
  return Boolean(navigator.share && window.isSecureContext && isMobileOrTablet);
}

function buildReportJson() {
  return JSON.stringify(
    {
      accessCode: state.accessCode,
      configUrl: state.configUrl,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      clientIp: state.clientIp,
      userAgent: state.userAgent,
      executionStatus: state.executionStatus,
      executionError: state.executionError,
      config: state.config,
      tests: state.tests,
    },
    null,
    2,
  );
}

async function downloadPdfReport() {
  try {
    const report = buildPrintableReport();
    dom.reportStage.replaceChildren(report);

    await waitForFrames(report);

    const canvas = await html2canvas(report, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
      windowWidth: 794,
    });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "pt", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    let heightLeft = imgHeight;
    let position = 0;

    pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;

    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    pdf.save(`reporte-bloqueos-${dateStamp()}.pdf`);
  } catch (error) {
    console.error(error);
    openPrintableFallback();
  }
}

function buildPrintableReport() {
  const report = document.createElement("article");
  report.className = "pdf-report";

  report.innerHTML = `
    <h1>Reporte de Bloqueos</h1>
    <div class="pdf-meta">
      ${pdfBox("Codigo", state.accessCode)}
      ${pdfBox("Configuracion", state.configUrl)}
      ${pdfBox("Inicio", formatDate(state.startedAt))}
      ${pdfBox("Fin", formatDate(state.finishedAt || new Date().toISOString()))}
      ${pdfBox("Estado", getReadableExecutionStatus())}
      ${pdfBox("Motivo de error", state.executionError?.message || "No aplica")}
      ${pdfBox("IP cliente", state.clientIp)}
      ${pdfBox("User Agent", state.userAgent)}
    </div>
    <h2>Resumen</h2>
    <div class="pdf-meta">
      ${pdfBox("Total", String(state.tests.length))}
      ${pdfBox("Conectados", String(state.tests.filter((test) => test.ok).length))}
      ${pdfBox("Fallidos", String(state.tests.filter((test) => !test.ok).length))}
      ${pdfBox("Dominios", String(state.config?.domains?.length || 0))}
    </div>
    <h2>Pruebas</h2>
    ${state.tests.map(renderPdfResult).join("")}
  `;

  hydrateWebPreviews(report);
  return report;
}

function pdfBox(label, value) {
  return `
    <div class="pdf-box">
      <div class="pdf-label">${escapeHtml(label)}</div>
      <div class="pdf-value">${escapeHtml(value || "No disponible")}</div>
    </div>
  `;
}

function getReadableExecutionStatus() {
  if (state.executionStatus === "completed") return "Completado";
  if (state.executionStatus === "error") return "No se pudo ejecutar";
  if (state.executionStatus === "running") return "Probando";
  return "Listo";
}

function renderPdfResult(test) {
  const response = test.responseText || test.error || "Sin respuesta capturable";
  const webPreview = test.isWebResponse
    ? `
      <div class="pdf-web-render">
        <div class="pdf-web-surface" data-web-preview="${escapeAttribute(test.id)}"></div>
        <iframe sandbox srcdoc="${escapeAttribute(response)}"></iframe>
      </div>
    `
    : "";

  return `
    <section class="pdf-result">
      <div class="pdf-label">${test.ok ? "OK" : "FALLO"} · ${escapeHtml(test.protocol.toUpperCase())} · Puerto ${test.port}</div>
      <div class="pdf-value">${escapeHtml(test.url)}</div>
      <pre>${escapeHtml(response)}</pre>
      ${webPreview}
    </section>
  `;
}

async function waitForFrames(root) {
  const frames = [...root.querySelectorAll("iframe")];
  await Promise.all(
    frames.map(
      (frame) =>
        new Promise((resolve) => {
          frame.addEventListener("load", () => resolve(), { once: true });
          window.setTimeout(resolve, 700);
        }),
    ),
  );
}

function hydrateWebPreviews(report) {
  for (const preview of report.querySelectorAll("[data-web-preview]")) {
    const test = state.tests.find((item) => item.id === preview.dataset.webPreview);
    if (!test?.responseText) continue;
    preview.replaceChildren(buildSafeHtmlPreview(test.responseText));
  }
}

function buildSafeHtmlPreview(html) {
  const wrapper = document.createElement("div");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const blockedSelectors = "script,noscript,iframe,object,embed,form,input,button,textarea,select,link,meta";

  for (const node of parsed.querySelectorAll(blockedSelectors)) {
    node.remove();
  }

  for (const element of parsed.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (["href", "src", "poster"].includes(name) && !isSafeUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  const content = parsed.body.childNodes.length ? parsed.body.childNodes : parsed.documentElement.childNodes;
  wrapper.append(...[...content].map((node) => node.cloneNode(true)));

  if (!wrapper.textContent.trim() && !wrapper.children.length) {
    wrapper.textContent = html;
  }

  return wrapper;
}

function isSafeUrl(value) {
  try {
    const url = new URL(value, location.href);
    return ["http:", "https:", "data:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function openPrintableFallback() {
  const printable = window.open("", "_blank", "noopener,noreferrer");
  if (!printable) return;

  printable.document.write(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Reporte de Bloqueos</title>
        <link rel="stylesheet" href="${new URL("./styles.css", location.href)}" />
      </head>
      <body>${buildPrintableReport().outerHTML}</body>
    </html>
  `);
  printable.document.close();
  printable.focus();
  printable.print();
}

async function shareReport() {
  if (!isShareAvailable()) {
    setStatus("Este navegador no es compatible con compartir");
    return;
  }

  try {
    const file = new File([buildReportJson()], `reporte-bloqueos-${dateStamp()}.json`, { type: "application/json" });

    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: "Reporte de Bloqueos", files: [file] });
      return;
    }

    await navigator.share({
      title: "Reporte de Bloqueos",
      text: state.executionError?.message || `Reporte generado para ${state.accessCode}`,
    });
  } catch (error) {
    if (error.name !== "AbortError") {
      setStatus("Este navegador no es compatible con compartir");
      dom.shareButton.disabled = true;
      dom.shareButton.hidden = true;
    }
  }
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function dateStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function formatDate(value) {
  if (!value) return "No disponible";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
