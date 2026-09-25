const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function localBridgeHandler() {
  const source = fs.readFileSync(path.join(__dirname, 'web', 'preload.js'), 'utf8');
  const start = source.indexOf('    local.onmessage = (event) => {');
  const end = source.indexOf('    local.onclose =', start);
  assert.ok(start >= 0 && end > start, 'handler da ponte local encontrado');
  const forwarded = [];
  const context = {
    local: {},
    ownerRendererHubId: 2,
    refreshOwnerRendererHubId() {},
    bridgeNonce: 'test',
    REMOTE_ID_BASE: 900000,
    bridgeStats: { fromHub: 0 },
    sendRemote(text) { forwarded.push(JSON.parse(text)); },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { handler: context.local.onmessage, forwarded };
}

test('request-offer pode ser reenviado quando o publicador aparece depois', () => {
  const { handler, forwarded } = localBridgeHandler();
  const request = JSON.stringify({ from: 2, type: 'request-offer' });
  handler({ data: request });
  handler({ data: request });
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].type, 'request-offer');
  assert.equal(forwarded[1].from, 'bd-test-2');
});

test('a ponte continua filtrando outras janelas e mensagens retornadas', () => {
  const { handler, forwarded } = localBridgeHandler();
  handler({ data: JSON.stringify({ from: 3, type: 'request-offer' }) });
  handler({ data: JSON.stringify({ from: 2, type: 'request-offer', bdOrigin: true }) });
  assert.equal(forwarded.length, 0);
});

test('oferta local nao atravessa o relay; oferta remota atravessa', () => {
  const { handler, forwarded } = localBridgeHandler();
  handler({ data: JSON.stringify({ from: 2, type: 'offer', to: 3, sdp: 'local' }) });
  handler({ data: JSON.stringify({ from: 2, type: 'offer', to: 'bd-abcdefabcdefabcdefabcdef-3', sdp: 'remote' }) });
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].to, 'bd-abcdefabcdefabcdefabcdef-3');
});

test('ponte remota entrega apenas o destinatario e restaura seu ID local', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web', 'preload.js'), 'utf8');
  const wire = source.indexOf('  const wireRemote = (socket, via) => {');
  const start = source.indexOf('    socket.onmessage = (event) => {', wire);
  const end = source.indexOf('    socket.onclose =', start);
  assert.ok(wire >= 0 && start > wire && end > start, 'handler da ponte remota encontrado');
  const sent = [];
  const context = {
    socket: {},
    bridgeNonce: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    REMOTE_ID_BASE: 1000000000000,
    isBridgedPeerId(value) { return /^bd-[0-9a-f]{24}-[1-9][0-9]*$/.test(value); },
    bridgeStats: { fromRemote: 0, toHub: 0, welcome: false },
    sendLocal(text) { sent.push(JSON.parse(text)); },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const from = 'bd-bbbbbbbbbbbbbbbbbbbbbbbb-2';
  context.socket.onmessage({ data: JSON.stringify({ from, type: 'offer', to: 'bd-cccccccccccccccccccccccc-4' }) });
  context.socket.onmessage({ data: JSON.stringify({ from, type: 'offer', to: 'bd-aaaaaaaaaaaaaaaaaaaaaaaa-4' }) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 4);
  assert.equal(sent[0].from, from);
});

test('ao parar e reabrir a live, o espectador pede outra oferta automaticamente', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'web', 'renderer.js'), 'utf8');
  const start = source.indexOf('  async function onHub(message) {');
  const end = source.indexOf('  // ----------------------------------------------------------- webrtc', start);
  assert.ok(start >= 0 && end > start, 'handler do renderer encontrado');
  const incomingPeers = new Map([['old', { from: 'publisher-1', publisherKey: 'publisher-1' }]]);
  const sent = [];
  const context = {
    incomingPeers,
    closeIncomingPeer(entry) { incomingPeers.delete('old'); },
    validDiscordUserId() { return ''; },
    hasIncomingPublisher(key) { return [...incomingPeers.values()].some((entry) => entry.publisherKey === key); },
    send(packet) { sent.push(packet); },
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.testOnHub = onHub;', context);
  await context.testOnHub({ type: 'publisher-stopped', from: 'publisher-1' });
  assert.equal(incomingPeers.size, 0);
  await context.testOnHub({ type: 'publisher-ready', from: 'publisher-1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'request-offer');
});

test('renegociacao preserva o player antigo ate o primeiro frame novo', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web', 'renderer.js'), 'utf8');
  const start = source.indexOf('  function stageReplacement(entry, stream) {');
  const end = source.indexOf('  function updateReceivedPublisherIdentity(', start);
  assert.ok(start >= 0 && end > start, 'staging da trilha encontrado');
  let onFrame;
  const video = {
    style: {},
    requestVideoFrameCallback(callback) { onFrame = callback; },
    play() { return Promise.resolve(); },
    pause() {},
    remove() {},
  };
  const old = { publisherKey: 'note', routeKey: 'old' };
  const replacement = { publisherKey: 'note', routeKey: 'new', from: 'note', publisherUserId: '' };
  const incomingPeers = new Map([['old', old], ['new', replacement]]);
  const shown = [];
  const closed = [];
  const context = {
    document: { createElement() { return video; }, body: { appendChild() {} } },
    incomingPeers,
    incomingByPublisher: new Map([['note', 'old']]),
    showStream(stream) { shown.push(stream); },
    closeIncomingPeer(entry) { closed.push(entry); incomingPeers.delete(entry.routeKey); },
    report() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.stage = stageReplacement;', context);
  const stream = { id: 'new-video' };
  context.stage(replacement, stream);
  assert.equal(shown.length, 0);
  assert.equal(closed.length, 0);
  assert.equal(context.incomingByPublisher.get('note'), 'old');
  onFrame();
  assert.deepEqual(shown, [stream]);
  assert.deepEqual(closed, [old]);
  assert.equal(context.incomingByPublisher.get('note'), 'new');
});
