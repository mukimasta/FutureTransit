import type {
  Command,
  CommandResult,
  Snapshot,
  WorkerRequest,
  WorkerResponse,
} from '../shared/types';
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export class SimulationBridge {
  private worker = new Worker(new URL('../worker/simulation.worker.ts', import.meta.url), {
    type: 'module',
  });
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private errors = new Set<(error: Error) => void>();
  private lastSnapshot: Snapshot | null = null;
  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (data.type === 'snapshot') {
        this.lastSnapshot = data.snapshot;
        this.listeners.forEach((fn) => fn(data.snapshot));
        return;
      }
      if (data.type === 'error') {
        const error = new Error(`${data.message.zh} / ${data.message.en}`);
        if (data.id !== undefined) {
          const pending = this.pending.get(data.id);
          if (pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(data.id);
          }
        } else this.errors.forEach((fn) => fn(error));
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(data.id);
      pending.resolve(data.type === 'saved' ? data.data : data.result);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Simulation worker failed');
      this.errors.forEach((fn) => fn(error));
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
    };
    this.worker.postMessage({ type: 'init' } satisfies WorkerRequest);
  }
  subscribe(listener: (snapshot: Snapshot) => void) {
    this.listeners.add(listener);
    if (this.lastSnapshot) listener(this.lastSnapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onError(listener: (error: Error) => void) {
    this.errors.add(listener);
    return () => {
      this.errors.delete(listener);
    };
  }
  private request<T>(make: (id: number) => WorkerRequest): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('模拟响应超时 / Simulation response timed out'));
      }, 15000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.worker.postMessage(make(id));
    });
  }
  command(command: Command) {
    return this.request<CommandResult>((id) => ({ type: 'command', id, command }));
  }
  save() {
    return this.request<string>((id) => ({ type: 'save', id }));
  }
  load(data: string) {
    return this.request<CommandResult>((id) => ({ type: 'load', id, data }));
  }
  reset() {
    return this.request<CommandResult>((id) => ({ type: 'reset', id }));
  }
  destroy() {
    this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Simulation closed'));
    }
    this.pending.clear();
    this.listeners.clear();
    this.errors.clear();
  }
}
