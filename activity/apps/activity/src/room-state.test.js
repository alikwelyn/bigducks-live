import { afterEach, expect, it, vi } from 'vitest';
import { createRoomState } from './room-state.js';

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.hidden = false; this.disabled = false; this.click = vi.fn(); }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  // The module writes markup then queries h2/p/button, so the fake keeps one stable
  // element per selector instead of trying to parse HTML.
  querySelector(selector) {
    this._found ??= new Map();
    if (!this._found.has(selector)) this._found.set(selector, new Element(selector.replace(/[^a-z0-9]/gi, '') || 'div'));
    return this._found.get(selector);
  }
  set innerHTML(value) { this.children = []; this._found = new Map(); this._html = value; }
  get innerHTML() { return this._html ?? ''; }
}

function harness() {
  const nodes = { status: new Element(), container: new Element(), publish: new Element(), shell: new Element(), watch: new Element() };
  nodes.watch.hidden = true;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => (selector === '.viewer-shell' ? nodes.shell : nodes.watch),
  };
  const state = createRoomState({ status: nodes.status, container: nodes.container, publish: nodes.publish, retry: vi.fn(), timeoutMs: 20_000 });
  return { state, nodes };
}

afterEach(() => { delete globalThis.document; vi.useRealTimers(); });

it('reports the timeout with the code the user is asked to relay', () => {
  vi.useFakeTimers();
  const { nodes } = harness();
  vi.advanceTimersByTime(20_000);
  const message = nodes.container.querySelector('p').textContent;
  expect(message).toMatch(/demorou mais que o esperado/);
  expect(message).toMatch(/\(0x7\)$/);
  expect(nodes.container.querySelector('h2').textContent).toMatch(/Não conseguimos buscar as lives/);
});

it('leaves the room usable after recovering and refuses to render before ready', () => {
  const { state, nodes } = harness();
  expect(state.render(0)).toBe(false);
  expect(state.phase).toBe('loading');
  state.ready();
  expect(state.phase).toBe('ready');
  expect(nodes.publish.disabled).toBe(false);
  expect(state.render(0)).toBe(false);
  expect(nodes.status.textContent).toMatch(/Aguardando a primeira live/);
  expect(nodes.container.querySelector('h2').textContent).toMatch(/Só falta a primeira live/);
  expect(state.render(2)).toBe(true);
  expect(nodes.status.textContent).toMatch(/2 lives disponíveis/);
});
