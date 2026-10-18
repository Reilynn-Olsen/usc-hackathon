"use client";

import { useEffect, useRef, useState } from "react";
import type { SimulationState } from "../../lib/harbormind/types";
import { ingestVesselReport } from "../lib/vessel-state";

export function useVesselFeed() {
  const latestState = useRef<SimulationState | null>(null);
  const [state, setState] = useState<SimulationState | null>(null);
  const [status, setStatus] = useState("Loading vessel state…");

  useEffect(() => {
    const controller = new AbortController();
    let stream: EventSource | undefined;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    let received = false;
    const staleTimer = window.setInterval(() => {
      const reports =
        latestState.current?.ships.map((ship) =>
          Date.parse(ship.positionObservedAt ?? ""),
        ) ?? [];
      if (
        received &&
        reports.length &&
        Date.now() - Math.max(...reports) > 120_000
      )
        setStatus("AIS reports stale · showing last positions");
      const current = latestState.current;
      if (
        current?.ships.some(
          (ship) =>
            ship.positionSource === "live" &&
            Date.now() - Date.parse(ship.positionObservedAt ?? "") > 120_000,
        )
      ) {
        const ships = current.ships.map((ship) =>
          ship.positionSource === "live" &&
          Date.now() - Date.parse(ship.positionObservedAt ?? "") > 120_000
            ? { ...ship, positionSource: "cached" as const }
            : ship,
        );
        const sources = new Set(ships.map((ship) => ship.positionSource));
        const next = {
          ...current,
          ships,
          provenance: {
            ...current.provenance,
            shipPositions:
              sources.size > 1 ? ("mixed" as const) : ships[0].positionSource,
          },
        };
        latestState.current = next;
        setState(next);
      }
    }, 15_000);
    async function connect() {
      try {
        const response = await fetch("/api/scenario", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Scenario unavailable");
        const initial: SimulationState = await response.json();
        if (controller.signal.aborted) return;
        latestState.current = initial;
        setState(initial);
        setStatus(
          "Connecting to AIS · synthetic fallback until reports arrive",
        );
        stream = new EventSource("/api/ships");
        stream.addEventListener("vessel", (event) => {
          if (controller.signal.aborted || !latestState.current) return;
          try {
            const previous = latestState.current;
            const next = ingestVesselReport(
              previous,
              JSON.parse((event as MessageEvent).data),
            );
            if (next === previous) return;
            latestState.current = next;
            received = true;
            setStatus("Live AIS positions · synthetic cargo and modeled ETAs");
            // Batch rendering while keeping the snapshot ref current for Run.
            publishTimer ??= setTimeout(() => {
              publishTimer = undefined;
              if (!controller.signal.aborted) setState(latestState.current);
            }, 500);
          } catch {
            /* Ignore malformed provider messages. */
          }
        });
        const unavailable = () => {
          if (!controller.signal.aborted)
            setStatus(
              received
                ? "AIS reconnecting · showing last positions"
                : "AIS unavailable · synthetic fallback",
            );
        };
        stream.addEventListener("provider-error", unavailable);
        stream.onerror = unavailable;
      } catch {
        if (!controller.signal.aborted)
          setStatus("Vessel state unavailable · retry by reloading");
      }
    }
    void connect();
    return () => {
      controller.abort();
      stream?.close();
      clearTimeout(publishTimer);
      window.clearInterval(staleTimer);
    };
  }, []);

  return { state, latestState, status };
}
