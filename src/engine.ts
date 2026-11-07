import { useEffect, useState } from "react";
import { api, isLive, onEngine } from "./backend";

/** The container engine the core is connected to ("podman", "docker", or "none"), kept current:
 *  an engine started after KALYPSO connects on its own (core://engine). Null while unknown, and
 *  always null in the browser preview. */
export function useEngine(): string | null {
  const [engine, setEngine] = useState<string | null>(null);
  useEffect(() => {
    if (!isLive()) return;
    api.coreInfo().then((c) => setEngine(c?.runtime ?? "none")).catch(() => setEngine("none"));
    const off = onEngine((kind) => setEngine(kind));
    return () => void off.then((unlisten) => unlisten());
  }, []);
  return engine;
}
