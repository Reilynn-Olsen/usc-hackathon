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
- Configure four disruptions with capacity reduction and duration controls.
- Run a deterministic *illustrative* impact simulation; choose recommendations or custom actions; evaluate, compare, undo and reset plans.
- About/project architecture and honest integration status.
- Responsive layout for desktop, tablet and phone.

## Hook up your real engine later

- `app/lib/data.ts`: replace example `SHIPS`/`SCENARIOS` and `estimateOutcome(...)` with backend responses. This file defines the baseline data contracts.
- `app/page.tsx`: replace `runScenario()` and `evaluatePlan()` with calls to your Next.js server's API routes, which can proxy to your Dockerized port simulator and Jev harness. Don't call private Jev endpoints from the browser.
- `app/components/PortMap3D.tsx`: map API positions/route geometry can be derived from real tracked coordinates once you have a coordinate transformation into the local map system.

## Important

This is a UI demonstrator. All port/ship/cargo data, the weather zone, the recommendations, probability-like outputs and estimates are generated examples, **not** real forecasts, operational instructions or responses from Jev. The browser-only scoring model does not simulate real operational constraints.
