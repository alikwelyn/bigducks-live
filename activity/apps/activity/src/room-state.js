export function createRoomState({ status, container, publish, retry, timeoutMs = 20_000 }) {
  let phase = 'loading';
  let noticeTimer;
  const notice = document.createElement('div'); notice.className = 'room-live-notice'; notice.hidden = true; notice.setAttribute('role', 'status');
  const noticeText = document.createElement('span'); const browse = document.createElement('button'); browse.type = 'button'; browse.textContent = 'Ver lives';
  browse.onclick = () => { notice.hidden = true; document.querySelector('#back-to-streams').click(); };
  notice.append(noticeText, browse); document.querySelector('.viewer-shell').append(notice);
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const icon = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="5" y="8" width="38" height="27" rx="6" stroke="currentColor" stroke-width="2"/><path d="m21 16 10 6-10 6V16Z" fill="currentColor"/><path d="M17 41h14M24 35v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const panel = (title, description, action, onClick) => {
    container.innerHTML = `<div class="room-state-panel"><span class="room-state-icon">${icon}</span><h2></h2><p></p><button type="button"></button></div>`;
    container.querySelector('h2').textContent = title;
    container.querySelector('p').textContent = description;
    const button = container.querySelector('button'); button.textContent = action; button.onclick = onClick;
  };
  const setStatus = (text, state = phase) => { status.textContent = text; status.dataset.state = state; };
  const fail = (message = 'Confira sua conexão e tente entrar na sala novamente.') => {
    clearTimeout(timeout); clearTimeout(noticeTimer); phase = 'error'; publish.disabled = true;
    notice.hidden = true;
    container.setAttribute('aria-busy', 'false');
    setStatus('Não foi possível carregar a sala');
    panel('Não conseguimos buscar as lives', message, 'Tentar novamente', retry);
  };
  publish.disabled = true;
  container.setAttribute('aria-busy', 'true');
  setStatus('Conectando com o Discord…');
  container.innerHTML = '<div class="room-loading"><div class="room-loading-copy"><span class="room-spinner" aria-hidden="true"></span><div><h2>Buscando as lives do canal</h2><p>Estamos conectando você aos seus amigos.</p></div></div><div class="room-skeletons" aria-hidden="true"><div class="room-skeleton"></div><div class="room-skeleton"></div><div class="room-skeleton"></div></div></div>';
  const timeout = setTimeout(() => fail('A conexão demorou mais que o esperado. Tente novamente para atualizar a sala.'), timeoutMs);
  const connectedStatus = (count) => count ? `${count} ${count === 1 ? 'live disponível' : 'lives disponíveis'} · Escolha uma para assistir` : 'Você está na sala · Aguardando a primeira live';
  return {
    get phase() { return phase; },
    progress(text) { if (phase === 'loading') setStatus(text); },
    ready() { if (phase === 'error') return; clearTimeout(timeout); phase = 'ready'; publish.disabled = false; container.setAttribute('aria-busy', 'false'); },
    render(count) {
      if (phase !== 'ready') return false;
      if (!noticeTimer) setStatus(connectedStatus(count));
      if (count) return true;
      panel('A sala está pronta. Só falta a primeira live.', 'Compartilhe uma janela ou tela com seus amigos. Quando alguém entrar ao vivo, a transmissão aparece aqui automaticamente.', 'Começar uma live', () => publish.click());
      return false;
    },
    announce(name, getCount) {
      clearTimeout(noticeTimer);
      setStatus(`${name} começou uma live. O novo card já está disponível.`, 'new-live');
      if (!document.querySelector('#watch-view').hidden) { noticeText.textContent = `${name} começou uma live.`; notice.hidden = false; }
      noticeTimer = setTimeout(() => { noticeTimer = null; notice.hidden = true; if (phase === 'ready') setStatus(connectedStatus(getCount())); }, 6000);
    },
    fail,
  };
}
