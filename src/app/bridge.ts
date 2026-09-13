import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Command,
  CommandResult,
  WorkerOutput,
  World,
} from "../shared/types";
import { loadLocal, saveLocal } from "../persistence";
import { applyWorldDelta } from "../shared/world-delta";

export function useSimulation() {
  const [world, setWorld] = useState<World | null>(null);
  const [lastResult, setLastResult] = useState<CommandResult | null>(null);
  const worker = useRef<Worker | null>(null);
  const worldRef = useRef<World | null>(null);
  useEffect(() => {
    const runtime = new Worker(
      new URL("../worker/simulation.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = runtime;
    let sequence = 0;
    runtime.onmessage = (event: MessageEvent<WorkerOutput>) => {
      const message = event.data;
      if (message.type === "world") {
        sequence = 1;
        worldRef.current = message.world;
        setWorld(message.world);
      }
      if (message.type === "delta") {
        if (!worldRef.current || message.delta.sequence !== sequence + 1) {
          runtime.postMessage({ type: "snapshot" });
          return;
        }
        try {
          const next = applyWorldDelta(worldRef.current, message.delta);
          sequence = message.delta.sequence;
          worldRef.current = next;
          setWorld(next);
        } catch {
          runtime.postMessage({ type: "snapshot" });
        }
      }
      if (message.type === "result") setLastResult(message.result);
      if (message.type === "error")
        setLastResult({
          ok: false,
          message: message.message,
          messageEn: message.message,
        });
    };
    runtime.onerror = (event) =>
      setLastResult({
        ok: false,
        message: `模拟运行错误：${event.message}`,
        messageEn: `Simulation error: ${event.message}`,
      });
    const previous = loadLocal();
    if (previous) runtime.postMessage({ type: "load", world: previous });
    let saveWarningShown = false;
    const autosave = window.setInterval(() => {
      if (worldRef.current) {
        const saved = saveLocal(worldRef.current);
        if (!saved && !saveWarningShown)
          setLastResult({
            ok: false,
            message:
              "自动保存未成功，城市可能超出浏览器存储容量。请到设置导出 JSON 备份。",
            messageEn:
              "Autosave failed; this city may exceed browser storage. Export a JSON backup in Settings.",
          });
        saveWarningShown = !saved;
      }
    }, 15000);
    const onVisibility = () => {
      if (document.hidden) {
        runtime.postMessage({
          type: "command",
          command: { type: "pause", value: true },
        });
        if (worldRef.current) saveLocal(worldRef.current);
      }
    };
    const onBeforeUnload = () => {
      if (worldRef.current) saveLocal(worldRef.current);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    if (import.meta.env.DEV)
      (window as unknown as { __futureTransit: unknown }).__futureTransit = {
        getWorld: () => worldRef.current,
      };
    return () => {
      clearInterval(autosave);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      runtime.terminate();
      worker.current = null;
    };
  }, []);
  const send = useCallback(
    (command: Command) =>
      worker.current?.postMessage({ type: "command", command }),
    [],
  );
  const replaceWorld = useCallback(
    (next: World) => worker.current?.postMessage({ type: "load", world: next }),
    [],
  );
  return { world, send, replaceWorld, lastResult };
}
