# HarborMind — App Router drop-in

This entire starter is contained in `app/`. It includes a responsive operations dashboard, a Three.js 3D harbor, a scenario lab, and an about page. No changes to `package.json`, `next.config.*`, `public/`, or other directories are required.

## Install in your existing Next.js project

1. Back up your existing `app/` directory if it contains work.
2. Copy the contents of this `app/` folder over your project's `app/` folder.
3. Run `npm run dev` from your existing Next.js project and open `http://localhost:3000`.

No additional npm dependencies are required by this demo. Three.js v0.180.0 loads from jsDelivr (with an unpkg fallback) at runtime. The browser must have internet access and WebGL support. The relevant loader is in `app/components/PortMap3D.tsx`. When you are ready to bundle Three.js locally, install `three` and change `getThree()` to `return import("three")` (that optional path changes `package.json`, so it is deliberately not used here).

## What works now

- 3D port geometry, select/focus ships, dotted shipping paths, camera pan/zoom/orbit and weather footprints.
- Command center with synthetic fleet and terminal readings.
- Configure four disruptions with a selected active duration within a 36-hour simulation horizon.
- Run the server-side Monte Carlo simulator against the scenario state and optional Open-Meteo forecast.
- Send feasible candidates to the server-side Jev harness, select a recommended or alternative strategy, and compare custom action combinations using matching seeds and horizons.
- Label deterministic fallbacks and local mocks separately from Jev responses.
- Responsive layout for desktop, tablet and phone.

## Server-side decision and simulation APIs

- `GET /api/scenario` supplies the current synthetic port, vessel, cargo, and weather state.
- `GET /api/weather` adapts a live Open-Meteo forecast when available.
- `POST /api/recommendation` runs feasible strategies and calls the TypeSafe Jev SDK. Set `TYPESAFE_API_KEY` in the server environment for real Jev decisions.
- `POST /api/simulate` accepts either a server-generated `strategyId` or a four-boolean `plan` (`prioritizeCriticalCargo`, `staggerLowerPriorityVessels`, `reserveCapacityForCriticalCargo`, `divertStandardShipment`). The server validates feasibility and returns plan and baseline outcomes and matching seeded replays; `options.timeStepHours` can select an integer step from 1 to 24 hours.
- `JEV_MOCK=true` enables the existing local mock only outside production; the UI labels it explicitly. Missing credentials or Jev failures produce a labeled deterministic fallback.

## Important

The included port, vessel, and cargo state is synthetic. Weather is labeled by provenance. Simulation snapshots model berth queues, partial cargo-batch unloading, vessel operational states, deadlines, and hourly active disruptions. Overlapping disruption losses combine as remaining-capacity multipliers (for example, two 50% events leave 25% capacity). The Scenario Lab can scrub and switch between baseline and recovery replays; vessel tracks remain illustrative because the simulator does not supply geographic positions. The simulator returns seeded estimates and a probability of meeting its critical-cargo target; it does not calculate vessel-delay, congestion-overflow, or cost-threshold likelihoods. No result is an operational forecast or instruction.
