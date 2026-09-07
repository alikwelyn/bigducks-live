const pending = new WeakMap();

// getParameters must run after any earlier setParameters has finished.
export function updateSender(sender, mutate) {
  const next = (pending.get(sender) || Promise.resolve()).catch(() => {}).then(async () => {
    const parameters = sender.getParameters();
    if (mutate(parameters) !== false) await sender.setParameters(parameters);
  });
  pending.set(sender, next);
  return next;
}
