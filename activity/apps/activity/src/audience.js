export function createAudience(container) {
  const details = document.createElement('details'); details.className = 'audience';
  const summary = document.createElement('summary');
  const list = document.createElement('ul'); list.className = 'audience-list';
  details.append(summary, list); container.append(details);
  const update = (viewers = []) => {
    summary.textContent = `${viewers.length} assistindo`;
    list.replaceChildren();
    if (!viewers.length) {
      const empty = document.createElement('li'); empty.textContent = 'Ninguém assistindo agora.'; list.append(empty);
    }
    for (const viewer of viewers) {
      const item = document.createElement('li');
      if (viewer.avatar?.startsWith('https://cdn.discordapp.com/')) {
        const avatar = document.createElement('img'); avatar.src = viewer.avatar; avatar.alt = ''; avatar.width = 24; avatar.height = 24; item.append(avatar);
      }
      const name = document.createElement('span'); name.textContent = viewer.name || viewer.id; item.append(name); list.append(item);
    }
  };
  update();
  return { update, close() { details.open = false; } };
}
