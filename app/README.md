# HarborMind — App Router UI

The application UI is contained in `app/`. It includes a responsive operations dashboard, a Three.js 3D harbor, a scenario lab, and an about page. Three.js is installed as an npm dependency and bundled by Next.js.

## Run locally

1. Run `npm install` from the repository root to install the dependencies declared in `package.json`, including Three.js and its TypeScript types.
2. Run `npm run dev` and open `http://localhost:3000`.

Three.js v0.180.0 is loaded asynchronously from the application's bundled assets using `import("three")` in `app/components/PortMap3D.tsx`. The browser must support WebGL; no external Three.js CDN connection is required.

## What works now

- 3D port geometry, select/focus ships, dotted shipping paths, camera pan/zoom/orbit and weather footprints.
- Command center and scenario preview share AISStream vessel positions (synthetic fallback until AIS arrives), with modeled cargo and port capacity.
- Running a scenario freezes that same fleet for recommendations and simulation; subsequent AIS updates do not change an existing run.
- Configure four disruptions with a selected active duration within a 36-hour simulation horizon.
- Run the server-side Monte Carlo simulator against the scenario state and optional Open-Meteo forecast.
- Generate a bounded set of parameterized operational plans, evaluate measured outcomes, send Pareto-filtered alternatives to the server-side Jev harness, and compare custom plans using matching seeds and horizons.
- Label deterministic fallbacks and local mocks separately from Jev responses.
- Responsive layout for desktop, tablet and phone.

## Server-side decision and simulation APIs

- `GET /api/scenario` supplies the current synthetic port, vessel, cargo, and weather state.
- `GET /api/ships` streams AIS position reports from the server using `AISSTREAM_API_KEY`. Positions are labeled live or cached; AIS does not supply the demo cargo manifest or modeled ETAs.
- `GET /api/weather` adapts a live Open-Meteo forecast when available.
- `POST /api/strategies` lists feasible plans tagged with the selected objective and target; it accepts the same `decision` object as the recommendation route.
- `POST /api/recommendation` generates at most 40 feasible parameterized plans, evaluates them under the same seeded conditions, Pareto-filters the measured outcomes, then sends up to 16 alternatives to the TypeSafe Jev SDK. Its optional `decision` object accepts `objective` (`critical-delivery`, `minimize-delay`, `minimize-cost`, or `balanced`) and `maximumDisruptionCost`; `options.criticalCargoOnTimeTargetPercent` is the minimum delivery target. Set `TYPESAFE_API_KEY` in the server environment for real Jev decisions.
- `POST /api/simulate` accepts either a server-generated `strategyId` or a `RecoveryPlan`: scheduling policy; per-vessel staging windows; per-batch priorities; critical berth and time-windowed throughput reservations; vessel-to-port assignments; objective; minimum critical-cargo delivery target; and optional modeled-cost ceiling. Its optional `adaptive` object (`atHour`, `severity`, `durationHours`, `description`, and optional `portId`) injects a later capacity disruption, checkpoints the current run, asks Jev to select among plans simulated from that checkpoint, and returns `adaptive` outcomes, replay, and decision history alongside the compatible original fields. `options.timeStepHours` can select an integer step from 1 to 24 hours.
- `JEV_MOCK=true` enables the existing local mock only outside production; the UI labels it explicitly. Missing credentials or Jev failures produce a labeled deterministic fallback.

## Important

The initial fallback fleet, port, and cargo state is synthetic; AIS positions replace the fallback fleet when reports arrive. An alternate port may set `rerouteCostPerContainer` to model its per-container diversion charge; total disruption cost is unavailable if cargo delay costs or required reroute costs are missing. Weather is labeled by provenance. Simulation snapshots model berth queues, partial cargo-batch unloading, vessel operational states, deadlines, and hourly active disruptions. Overlapping disruption losses combine as remaining-capacity multipliers (for example, two 50% events leave 25% capacity). The Scenario Lab can scrub and switch between baseline, initial recovery, and adaptive recovery replays; vessels start at the captured geographic positions and then follow operational replay states on a schematic terminal layout. The simulator returns seeded estimates and a probability of meeting its critical-cargo target; it does not calculate vessel-delay, congestion-overflow, or cost-threshold likelihoods. No result is an operational forecast or instruction.
