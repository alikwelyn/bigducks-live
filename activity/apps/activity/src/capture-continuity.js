// Keep audio negotiated while windows are replaced; video stays native during capture.
export function createCaptureContinuity(initial, { onReplace, onWaiting, onChanged, onError, AudioContextClass = AudioContext } = {}) {
  const audio = new AudioContextClass();
  const destination = audio.createMediaStreamDestination();
  let input;
  let source = initial;
  let closed = false;
  let waiting = false;
  let revision = 0;
  let pending = Promise.resolve();
  let placeholder;
  let placeholderTimer;
  const stream = new MediaStream([initial.getVideoTracks()[0], ...destination.stream.getAudioTracks()]);
  const connectAudio = (value) => {
    input?.disconnect(); input = null;
    if (value.getAudioTracks().length) { input = audio.createMediaStreamSource(value); input.connect(destination); }
    void audio.resume().catch(() => {});
  };
  const stopTracks = (value) => value?.getTracks().forEach((track) => track.stop());
  const waitingStream = () => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d');
    const draw = () => {
      context.fillStyle = '#07111f'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#65dfae'; context.font = 'bold 36px sans-serif'; context.textAlign = 'center';
      context.fillText('A transmissão continua', 640, 330);
      context.fillStyle = '#c3d2e3'; context.font = '24px sans-serif';
      context.fillText('Aguardando o streamer compartilhar o monitor…', 640, 390);
    };
    draw(); placeholder = canvas.captureStream(1); placeholderTimer = setInterval(draw, 1000);
    return placeholder;
  };
  const attach = (value) => {
    const ended = () => {
    if (closed || source !== value) return;
    waiting = true; onWaiting?.();
    const next = waitingStream();
    void replace(next, true).catch((error) => { if (!closed) onError?.(error); });
    };
    value.getVideoTracks()[0].addEventListener('ended', ended, { once: true });
    if (value.getVideoTracks()[0].readyState === 'ended') queueMicrotask(ended);
  };
  const replace = (next, isPlaceholder = false) => {
    const nextRevision = ++revision;
    const operation = pending.catch(() => {}).then(async () => {
      if (closed || nextRevision !== revision) { stopTracks(next); return false; }
      const track = next.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') { stopTracks(next); throw new Error('A nova fonte foi encerrada. Selecione o monitor novamente.'); }
      track.contentHint = 'detail';
      try { await onReplace?.(track); } catch (error) { stopTracks(next); throw error; }
      if (closed) { stopTracks(next); return false; }
      const previous = source;
      source = next; waiting = isPlaceholder;
      for (const old of stream.getVideoTracks()) stream.removeTrack(old);
      stream.addTrack(track);
      connectAudio(next);
      stopTracks(previous);
      if (!isPlaceholder) { clearInterval(placeholderTimer); stopTracks(placeholder); placeholder = null; attach(next); }
      await onChanged?.({ stream, source: next, waiting });
      return true;
    });
    pending = operation;
    return operation;
  };
  connectAudio(initial); attach(initial);
  return {
    stream,
    get waiting() { return waiting; },
    get source() { return source; },
    replace,
    close() { closed = true; revision++; clearInterval(placeholderTimer); stopTracks(source); stopTracks(placeholder); stopTracks(stream); input?.disconnect(); void audio.close().catch(() => {}); },
  };
}
