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
