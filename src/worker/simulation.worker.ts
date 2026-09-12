import {
  createGame,
  advanceGame,
  applyCommand,
  getSnapshot,
  serializeGame,
  deserializeGame,
} from '../simulation';
import type { WorkerRequest, WorkerResponse } from '../shared/types';

// The simulation module has no timing/browser dependencies. This adapter owns wall time.
const scope = self as unknown as {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};
let game = createGame();
let previous = performance.now();
let remainder = 0;
function emit(message: WorkerResponse) {
  scope.postMessage(message);
}
function snapshot() {
  emit({ type: 'snapshot', snapshot: getSnapshot(game) });
}
scope.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      snapshot();
      return;
    }
    if (data.type === 'save') {
      emit({ type: 'saved', id: data.id, data: serializeGame(game) });
      return;
    }
    if (data.type === 'load') {
      const loaded = deserializeGame(data.data);
      game = loaded;
      applyCommand(game, { type: 'setRunning', value: false });
      remainder = 0;
      previous = performance.now();
      emit({ type: 'result', id: data.id, result: { ok: true } });
      snapshot();
      return;
    }
    if (data.type === 'reset') {
      game = createGame();
      remainder = 0;
      previous = performance.now();
      emit({ type: 'result', id: data.id, result: { ok: true } });
      snapshot();
      return;
    }
    const result = applyCommand(game, data.command);
    if (data.command.type === 'setRunning' || data.command.type === 'setSpeed') {
      remainder = 0;
      previous = performance.now();
    }
    emit({ type: 'result', id: data.id, result });
    snapshot();
  } catch (error) {
    console.error('[simulation]', error);
    emit({
      type: 'error',
      id: 'id' in data ? data.id : undefined,
      message: {
        zh: '无法完成操作。存档可能损坏或版本不兼容。',
        en: 'Unable to complete the action. The save may be invalid or incompatible.',
      },
    });
  }
};
setInterval(() => {
  const now = performance.now();
  // A sleeping browser never silently skips simulation events to catch up.
  const delta = Math.min((now - previous) / 1000, 0.25);
  previous = now;
  const state = getSnapshot(game);
  if (!state.running) return;
  remainder += delta * 6 * state.speed;
  const seconds = Math.min(24, Math.floor(remainder));
  if (seconds > 0) {
    remainder -= seconds;
    try {
      advanceGame(game, seconds);
      snapshot();
    } catch (error) {
      console.error(error);
      applyCommand(game, { type: 'setRunning', value: false });
      emit({
        type: 'error',
        message: {
          zh: '模拟已暂停，请保存并重新加载。',
          en: 'Simulation paused. Please save and reload.',
        },
      });
      snapshot();
    }
  }
}, 100);
