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
  log: document.querySelector("#open-log"),
  version: document.querySelector("#version"),
  updateTitle: document.querySelector("#update-title"),
  updateDetail: document.querySelector("#update-detail"),
  updateAction: document.querySelector("#update-action")
};

const stateCopy = {
  starting: ["Preparando a proteção", "O núcleo está verificando proxies e configurando a rota.", "working"],
  protected: ["Live protegida", "O gateway do Discord está passando por uma saída verificada.", "protected"],
  reconnecting: ["Trocando a rota", "Aguarde enquanto o Discord abre uma nova conexão protegida.", "working"],
  no_proxy: ["Procurando uma saída", "Ainda não há proxy verificado. O IP direto não será usado pelo gateway.", "working"],
  failed: ["A reconexão não terminou", "Veja o diagnóstico abaixo e tente novamente.", "failed"],
  repair_required: ["Integração precisa de reparo", "Uma atualização do Discord alterou a integração do BIG DUCKS.", "failed"],
  stopped: ["Proteção indisponível", "O núcleo não está respondendo. Use “Reiniciar proteção” no ícone do pato.", "failed"]
};

let lastState = "";
let toastTimer;
const backendEvents = new Set();

const technicalCopy = {
  "proxy heartbeat failed": "A rota anterior parou de responder; o BIG DUCKS está escolhendo outra.",
  "no verified proxy available": "Nenhuma saída verificada respondeu dentro do prazo.",
  "context deadline exceeded": "A operação demorou mais que o limite de segurança.",
  "connection refused": "O núcleo do BIG DUCKS não está respondendo.",
  "i/o timeout": "O núcleo demorou a responder; tente novamente.",
  "EOF": "A conexão com o núcleo foi interrompida."
};

function readableDetail(detail, fallback) {
  if (!detail) return fallback;
  const normalized = String(detail).trim().toLowerCase();
  if (technicalCopy[normalized]) return technicalCopy[normalized];
  for (const [key, friendly] of Object.entries(technicalCopy)) {
    if (normalized.includes(key)) return friendly;
  }
  return detail;
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

function renderStatus(status) {
  const state = status.state || "stopped";
  const copy = stateCopy[state] || stateCopy.failed;
	ui.hero.dataset.state = state;
  ui.title.textContent = copy[0];
	const routeSummary = status.activeProxy ? `${status.activeProxy}${status.latencyMS ? ` • ${status.latencyMS} ms` : ""}` : "";
	ui.detail.textContent = routeSummary || status.lastMessage || readableDetail(status.lastError, copy[1]);
  ui.dot.className = `status-dot ${copy[2]}`;
  ui.pool.textContent = String(status.poolSize ?? 0);
  ui.tunnels.textContent = String(status.tunnelCount ?? 0);
	ui.bridge.textContent = status.latencyMS ? `${status.latencyMS} ms` : "—";
  const pending = (button) => button.getAttribute("aria-busy") === "true";
  const swapping = state === "reconnecting";
  ui.reconnect.disabled = swapping || pending(ui.reconnect);
  ui.reconnect.title = swapping ? "Uma nova rota já está sendo preparada" : "Troca a rota sem fechar o Discord";
  document.querySelector("#reconnect small").textContent = swapping
    ? "Uma nova rota já está sendo preparada…"
    : "Troca a rota sem fechar o Discord";
  ui.reload.disabled = pending(ui.reload) || !status.bridgeConnected;
  ui.reload.title = status.bridgeConnected
    ? "Recarrega a janela do Discord sem trocar a rota"
    : "Indisponível enquanto o Discord não estiver conectado ao gateway";
  ui.technical.textContent = [
    `estado: ${state}`,
    `proxies verificados: ${status.poolSize ?? 0}`,
    `túneis de gateway: ${status.tunnelCount ?? 0}`,
		`bridge Electron: ${status.bridgeConnected ? "conectada" : "desconectada"}`,
		`saída ativa: ${status.activeProxy || "nenhuma"}`,
		`latência verificada: ${status.latencyMS ? `${status.latencyMS} ms` : "não informada"}`,
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
  button.querySelector("span").textContent = pending;
  try {
    await action();
    addEvent(success, "A ação foi concluída pelo núcleo BIG DUCKS.", "success");
    showToast(success);
  } catch (error) {
    const message = readableDetail(String(error).replace(/^Error:\s*/, ""), "Falha desconhecida");
    addEvent("Ação não concluída", message, "error");
    showToast(`Não foi possível concluir: ${message}`);
  } finally {
    button.innerHTML = original;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    await refreshStatus();
  }
}

ui.reconnect.addEventListener("click", () => perform(ui.reconnect, "Reconectando…", window.bigDucksReconnect, "Nova rota protegida ativa"));
ui.route.addEventListener("click", () => perform(ui.route, "Testando…", window.bigDucksTestRoute, "PAC e gateway regional validados"));
ui.reload.addEventListener("click", () => perform(ui.reload, "Recarregando…", window.bigDucksReload, "Janela do Discord recarregada"));
ui.log.addEventListener("click", async () => {
  try { await window.bigDucksOpenLog(); }
  catch (error) { showToast(`Não foi possível abrir o log: ${error}`); }
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
