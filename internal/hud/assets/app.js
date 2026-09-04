const zoomKeys = new Set(["+", "=", "-", "_", "0", "Add", "Subtract"]);
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && zoomKeys.has(event.key)) event.preventDefault();
}, { capture: true });
document.addEventListener("wheel", (event) => {
  if (event.ctrlKey) event.preventDefault();
}, { capture: true, passive: false });

const ui = {
  hero: document.querySelector("#route-card"),
  title: document.querySelector("#protection-title"),
  detail: document.querySelector("#status-detail"),
  dot: document.querySelector("#status-dot"),
  pool: document.querySelector("#pool-size"),
  tunnels: document.querySelector("#tunnel-count"),
  bridge: document.querySelector("#bridge-state"),
  technical: document.querySelector("#technical-output"),
  events: document.querySelector("#events"),
  toast: document.querySelector("#toast"),
  reconnect: document.querySelector("#reconnect"),
  route: document.querySelector("#test-route"),
  reload: document.querySelector("#reload"),
  repair: document.querySelector("#repair"),
  log: document.querySelector("#open-log"),
  version: document.querySelector("#version"),
  updateTitle: document.querySelector("#update-title"),
  updateDetail: document.querySelector("#update-detail"),
  updateAction: document.querySelector("#update-action"),
  telemetryTitle: document.querySelector("#telemetry-title"),
  telemetryDetail: document.querySelector("#telemetry-detail"),
  telemetryDot: document.querySelector("#telemetry-dot"),
  telemetryEnabled: document.querySelector("#telemetry-enabled"),
  telemetryToggle: document.querySelector("#telemetry-toggle"),
  telemetryToggleLabel: document.querySelector("#telemetry-toggle-label"),
  telemetryTest: document.querySelector("#telemetry-test"),
  telemetryPurge: document.querySelector("#telemetry-purge")
};

const stateCopy = {
  disabled: ["Proteção desligada", "Ative a proteção nas configurações para liberar a live.", "failed"],
  discord_closed: ["Discord fechado", "Abra o Discord para liberar a live.", "working"],
  discord_starting: ["Abrindo o Discord", "Aguarde enquanto preparamos o acesso.", "working"],
  discord_running: ["Discord aberto", "A proteção aguarda uma sessão iniciada pelo BIG DUCKS.", "failed"],
  starting_protection: ["Preparando acesso", "O BIG DUCKS está preparando a conexão.", "working"],
  direct: ["Live sem proteção", "A conexão está direta, sem saída verificada.", "failed"],
  starting: ["Preparando acesso", "Verificando a conexão e liberando a live.", "working"],
  protected: ["Live liberada", "A conexão está pronta para transmitir e assistir.", "protected"],
  reconnecting: ["Liberando acesso", "Aguarde enquanto abrimos uma nova conexão.", "working"],
  no_proxy: ["Buscando acesso", "Ainda procurando uma saída verificada.", "working"],
  failed: ["Live não liberada", "Veja os detalhes abaixo e tente novamente.", "failed"],
  repair_required: ["Ajuste necessário", "O Discord mudou a integração; corrija para liberar a live.", "failed"],
  stopped: ["Proteção indisponível", "Use “Reiniciar proteção” no ícone do pato.", "failed"]
};

let lastState = "";
let toastTimer;
const backendEvents = new Set();

const technicalCopy = {
  "proxy heartbeat failed": "A rota anterior parou de responder; o BIG DUCKS está escolhendo outra.",
  "no verified proxy available": "Nenhuma saída verificada respondeu dentro do prazo.",
  "context deadline exceeded": "A operação demorou mais que o limite de segurança."
};

const telemetryCopy = {
  enabled: ["Telemetria ativada", "Diagnósticos agregados do núcleo e da bridge podem ser enviados.", "ATIVADA"],
  disabled: ["Telemetria desativada", "Nenhum evento novo será enviado; a fila local fica disponível para purga.", "DESATIVADA"],
  enable_failed: ["Telemetria não ativada", "Não foi possível inicializar o transporte seguro.", "ERRO"],
  save_failed: ["Preferência não salva", "A telemetria foi interrompida, mas a configuração não foi gravada.", "ERRO"],
  test_sent: ["Telemetria ativada", "O evento de teste foi enviado e confirmado pelo transporte.", "ATIVADA"],
  purged: ["Telemetria ativada", "A fila local foi apagada; eventos já enviados não são removidos daqui.", "ATIVADA"],
  purged_disabled: ["Telemetria desativada", "A fila local foi apagada; eventos já enviados não são removidos daqui.", "DESATIVADA"],
  core_test_failed: ["Teste não enviado", "O núcleo não confirmou o envio do evento de teste.", "ERRO"],
  bridge_test_failed: ["Bridge não confirmou", "O núcleo enviou, mas a bridge não confirmou o teste.", "ERRO"],
  bridge_upgrade_required: ["Bridge desatualizada", "O núcleo enviou; use Corrigir Discord para ativar a bridge Sentry.", "ATUALIZAR"]
};

function readableDetail(detail, fallback) {
  if (!detail) return fallback;
  const normalized = String(detail).trim().toLowerCase();
  return technicalCopy[normalized] || detail;
}

function showToast(message) {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.add("visible");
  toastTimer = setTimeout(() => ui.toast.classList.remove("visible"), 4200);
}

function addEvent(title, detail, kind = "info") {
  const item = document.createElement("li");
  const icon = document.createElement("span");
  icon.className = `event-icon ${kind}`;
  const copy = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = detail;
  copy.append(strong, paragraph);
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  item.append(icon, copy, time);
  ui.events.prepend(item);
  while (ui.events.children.length > 5) ui.events.lastElementChild.remove();
}

function renderTelemetry(status) {
  const telemetry = status.telemetry || {};
  const enabled = telemetry.enabled === true;
  const resultKey = !enabled && telemetry.lastResult === "purged" ? "purged_disabled" : telemetry.lastResult;
  const copy = telemetryCopy[resultKey] || telemetryCopy[enabled ? "enabled" : "disabled"];
  ui.telemetryTitle.textContent = copy[0];
  ui.telemetryDetail.textContent = copy[1];
  ui.telemetryEnabled.textContent = copy[2];
  ui.telemetryDot.className = `status-dot ${enabled ? "protected" : "failed"}`;
  ui.telemetryToggle.setAttribute("aria-checked", String(enabled));
  ui.telemetryToggle.setAttribute("aria-label", enabled ? "Desativar telemetria" : "Ativar telemetria");
  ui.telemetryToggle.classList.toggle("is-on", enabled);
  ui.telemetryToggleLabel.textContent = enabled ? "Desativar" : "Ativar";
  ui.telemetryTest.disabled = !enabled;
  ui.telemetryPurge.disabled = false;
}

function renderStatus(status) {
  const state = status.state || "stopped";
  const copy = stateCopy[state] || stateCopy.failed;
  renderTelemetry(status);
	ui.hero.dataset.state = state;
  ui.title.textContent = copy[0];
	const routeSummary = status.activeProxy ? `${status.activeProxy}${status.latencyMS ? ` • ${status.latencyMS} ms` : ""}` : "";
	ui.detail.textContent = routeSummary || status.lastMessage || status.lastError || copy[1];
  ui.dot.className = `status-dot ${copy[2]}`;
  ui.pool.textContent = String(status.poolSize ?? 0);
  ui.tunnels.textContent = String(status.tunnelCount ?? 0);
	ui.bridge.textContent = status.latencyMS ? `${status.latencyMS} ms` : "—";
  ui.reload.disabled = !status.bridgeConnected || state === "discord_closed" || state === "disabled";
  ui.repair.disabled = state === "disabled" || state === "stopped";
  ui.technical.textContent = [
    `estado: ${state}`,
    `proxies verificados: ${status.poolSize ?? 0}`,
    `túneis de gateway: ${status.tunnelCount ?? 0}`,
		`bridge Electron: ${status.bridgeConnected ? "conectada" : "desconectada"}`,
		`saída ativa: ${status.activeProxy || "nenhuma"}`,
		`latência verificada: ${status.latencyMS ? `${status.latencyMS} ms` : "não informada"}`,
    `mídia: ${status.media?.state || "não informada"}`,
    `diagnóstico RTC nativo: ${status.media?.native?.state || "não informado"}`,
    `frames de vídeo: ${status.media?.videoFrames ?? 0}`,
    `pacotes de áudio: ${status.media?.audioPackets ?? 0}`,
    `telemetria: ${status.telemetry?.enabled ? "ativada" : "desativada"}`,
    `injeção: ${status.injectionState || "não informada"}`,
    status.lastError ? `último erro: ${status.lastError}` : "último erro: nenhum"
	].join("\n");
	for (const event of status.recentEvents || []) {
		const key = `${event.at}|${event.code}|${event.message}`;
		if (backendEvents.has(key)) continue;
		backendEvents.add(key);
		addEvent(event.message, readableDetail(event.details, "Evento registrado pelo núcleo BIG DUCKS."), event.level || "info");
	}
  if (state !== lastState) {
    const kind = state === "protected" ? "success" : (state === "failed" || state === "stopped" ? "error" : "info");
    addEvent(copy[0], status.lastMessage || copy[1], kind);
    lastState = state;
  }
}

async function refreshStatus() {
  try {
    renderStatus(await window.bigDucksStatus());
  } catch (error) {
    renderStatus({ state: "stopped", lastError: String(error) });
  }
}

async function perform(button, pending, action, success) {
  if (button.disabled) return;
  const original = button.innerHTML;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const label = button.querySelector(".button-label") || button.querySelector("span");
  if (label) label.textContent = pending;
  try {
    await action();
    addEvent(success, "A ação foi concluída pelo núcleo BIG DUCKS.", "success");
    showToast(success);
  } catch (error) {
    addEvent("Ação não concluída", String(error), "error");
    showToast(`Não foi possível concluir: ${error}`);
  } finally {
    button.innerHTML = original;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    await refreshStatus();
  }
}

ui.reconnect.addEventListener("click", () => perform(ui.reconnect, "Liberando…", window.bigDucksReconnect, "Live liberada"));
ui.route.addEventListener("click", () => perform(ui.route, "Testando…", window.bigDucksTestRoute, "Conexão validada"));
ui.reload.addEventListener("click", () => perform(ui.reload, "Recarregando…", window.bigDucksReload, "Janela do Discord recarregada"));
ui.repair.addEventListener("click", () => {
  if (!window.confirm("Corrigir a integração? O Discord será fechado e reaberto pela rota protegida.")) return;
  perform(ui.repair, "Corrigindo…", window.bigDucksRepairDiscord, "Discord corrigido");
});
ui.log.addEventListener("click", async () => {
  try { await window.bigDucksOpenLog(); }
  catch (error) { showToast(`Não foi possível abrir o log: ${error}`); }
});
ui.telemetryToggle.addEventListener("click", () => {
  const enabled = ui.telemetryToggle.getAttribute("aria-checked") === "true";
  if (enabled && !window.confirm("Desativar a telemetria e apagar somente os dados locais do BIG DUCKS?")) return;
  const action = enabled ? window.bigDucksTelemetryDisable : window.bigDucksTelemetryEnable;
  const pending = enabled ? "Desativando…" : "Ativando…";
  const success = enabled ? "Telemetria desativada" : "Telemetria ativada";
  perform(ui.telemetryToggle, pending, action, success);
});
ui.telemetryTest.addEventListener("click", () => perform(ui.telemetryTest, "Enviando…", window.bigDucksTelemetryTest, "Teste do núcleo enviado"));
ui.telemetryPurge.addEventListener("click", () => {
  if (!window.confirm("Apagar a fila local de telemetria? Eventos já enviados não podem ser removidos por aqui.")) return;
  perform(ui.telemetryPurge, "Apagando…", window.bigDucksTelemetryPurge, "Fila local apagada");
});

let updatePollTimer;

function renderUpdate(result) {
  ui.version.textContent = `v${result.current}`;
  ui.updateAction.dataset.available = result.available ? "true" : "false";
  if (result.checking) {
    ui.updateTitle.textContent = "Verificando nova versão…";
    ui.updateDetail.textContent = result.message;
    ui.updateAction.textContent = "Verificando…";
    ui.updateAction.disabled = true;
    return;
  }
  ui.updateTitle.textContent = result.error ? "Não foi possível verificar" : (result.available ? `BIG DUCKS ${result.latest} disponível` : "BIG DUCKS atualizado");
  ui.updateDetail.textContent = result.message;
  ui.updateAction.textContent = result.available ? "Atualizar agora" : (result.error ? "Tentar novamente" : "Verificar");
  ui.updateAction.disabled = false;
}

function renderUpdateError(error) {
  ui.updateTitle.textContent = "Não foi possível verificar";
  ui.updateDetail.textContent = String(error);
  ui.updateAction.textContent = "Tentar novamente";
  ui.updateAction.disabled = false;
}

async function pollUpdateStatus() {
  try {
    const result = await window.bigDucksUpdateStatus();
    renderUpdate(result);
    if (result.checking) updatePollTimer = setTimeout(pollUpdateStatus, 250);
  } catch (error) {
    renderUpdateError(error);
  }
}

async function checkUpdate() {
  clearTimeout(updatePollTimer);
  try {
    const result = await window.bigDucksCheckUpdate();
    renderUpdate(result);
    if (result.checking) updatePollTimer = setTimeout(pollUpdateStatus, 250);
  } catch (error) {
    renderUpdateError(error);
  }
}

ui.updateAction.addEventListener("click", async () => {
  if (ui.updateAction.dataset.available !== "true") {
    await checkUpdate();
    return;
  }
  ui.updateAction.disabled = true;
  ui.updateAction.textContent = "Baixando…";
  ui.updateDetail.textContent = "Validando assinatura e preparando a troca do aplicativo.";
  try {
    await window.bigDucksInstallUpdate();
    ui.updateTitle.textContent = "Atualização pronta";
    ui.updateDetail.textContent = "O painel será reaberto pela versão nova; o Discord continuará aberto.";
    ui.updateAction.textContent = "Reiniciando…";
    setTimeout(() => window.bigDucksClose(), 500);
  } catch (error) {
    ui.updateTitle.textContent = "Atualização não instalada";
    ui.updateDetail.textContent = String(error);
    ui.updateAction.textContent = "Tentar novamente";
    ui.updateAction.disabled = false;
  }
});

refreshStatus();
setTimeout(checkUpdate, 1200);
setInterval(() => { if (!document.hidden) refreshStatus(); }, 2000);
