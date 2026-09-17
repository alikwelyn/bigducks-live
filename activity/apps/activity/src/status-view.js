// One owner for the status line. The broadcaster page had no state styling and no
// live region, so a failure looked exactly like success and screen readers were
// never told anything.
export function createStatusView(element) {
  if (!element) throw new Error('status element required');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  let state = 'info';
  return {
    set(text, next = 'info') {
      element.textContent = text;
      state = next;
      element.dataset.state = next;
      return text;
    },
    get state() { return state; },
    get text() { return element.textContent; },
  };
}
