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
- Generate a bounded set of parameterized operational plans, evaluate measured outcomes, send Pareto-filtered alternatives to the server-side Jev harness, and compare custom plans using matching seeds and horizons.
- Label deterministic fallbacks and local mocks separately from Jev responses.
- Responsive layout for desktop, tablet and phone.

## Server-side decision and simulation APIs

- `GET /api/scenario` supplies the current synthetic port, vessel, cargo, and weather state.
- `GET /api/weather` adapts a live Open-Meteo forecast when available.
- `POST /api/strategies` lists feasible plans tagged with the selected objective and target; it accepts the same `decision` object as the recommendation route.
- `POST /api/recommendation` generates at most 40 feasible parameterized plans, evaluates them under the same seeded conditions, Pareto-filters the measured outcomes, then sends up to 16 alternatives to the TypeSafe Jev SDK. Its optional `decision` object accepts `objective` (`critical-delivery`, `minimize-delay`, `minimize-cost`, or `balanced`) and `maximumDisruptionCost`; `options.criticalCargoOnTimeTargetPercent` is the minimum delivery target. Set `TYPESAFE_API_KEY` in the server environment for real Jev decisions.
- `POST /api/simulate` accepts either a server-generated `strategyId` or a `RecoveryPlan`: scheduling policy; per-vessel staging windows; per-batch priorities; critical berth and time-windowed throughput reservations; vessel-to-port assignments; objective; minimum critical-cargo delivery target; and optional modeled-cost ceiling. Its optional `adaptive` object (`atHour`, `severity`, `durationHours`, `description`, and optional `portId`) injects a later capacity disruption, checkpoints the current run, asks Jev to select among plans simulated from that checkpoint, and returns `adaptive` outcomes, replay, and decision history alongside the compatible original fields. `options.timeStepHours` can select an integer step from 1 to 24 hours.
- `JEV_MOCK=true` enables the existing local mock only outside production; the UI labels it explicitly. Missing credentials or Jev failures produce a labeled deterministic fallback.

## Important

The included port, vessel, and cargo state is synthetic. An alternate port may set `rerouteCostPerContainer` to model its per-container diversion charge; total disruption cost is unavailable if cargo delay costs or required reroute costs are missing. Weather is labeled by provenance. Simulation snapshots model berth queues, partial cargo-batch unloading, vessel operational states, deadlines, and hourly active disruptions. Overlapping disruption losses combine as remaining-capacity multipliers (for example, two 50% events leave 25% capacity). The Scenario Lab can scrub and switch between baseline, initial recovery, and adaptive recovery replays; vessel tracks remain illustrative because the simulator does not supply geographic positions. The simulator returns seeded estimates and a probability of meeting its critical-cargo target; it does not calculate vessel-delay, congestion-overflow, or cost-threshold likelihoods. No result is an operational forecast or instruction.
