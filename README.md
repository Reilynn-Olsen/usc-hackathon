This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## HarborMind decision harness

The server-side harness compares feasible port recovery strategies with a deterministic arrival-order baseline. It simulates each strategy with reproducible weather, capacity, arrival-delay, unloading-time, and equipment variation, then asks Jev to select from the already simulated candidate set. Jev only returns typed decisions; ship positions, cargo, and outcomes come from the supplied state and simulator.

Install [`@typesafe-ai/sdk`](https://docs.typesafe.ai/go/js-sdk) (already listed in `package.json`) and set `TYPESAFE_API_KEY` in `.env.local`. Keep it server-side. The project and SDK require Node.js 22 or newer. Jev is called through the official [`TypeSafeClient.systemOne()` API](https://github.com/typesafe-ai/typesafe-sdk-js).

### Endpoints

- `GET /api/scenario` returns a synthetic Port of Los Angeles storm example: modeled unloading capacity is reduced by 60%, with medical supplies, perishable food, industrial components, and consumer goods.
- `POST /api/strategies` takes `{ "state": <SimulationState>, "options": <optional SimulationOptions> }` and returns only feasible strategies.
- `POST /api/simulate` takes the same state/options plus `strategyId`; it returns that strategy's Monte Carlo results and the baseline comparison.
- `POST /api/recommendation` runs the complete decision loop and returns the selected actions, outcomes, baseline comparison, Jev confidence/probabilities, simulation likelihoods, risk indicators, provenance, and warnings.

The choice set includes at most 20 feasible reroute candidates per request, selected in ship and alternative-port order.

Example:

```js
const state = await fetch("/api/scenario").then((response) => response.json());
const result = await fetch("/api/recommendation", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ state, options: { runs: 40, seed: 42 } }),
}).then((response) => response.json());

console.log(result.recommendation.selectedStrategyId);
console.log(result.recommendation.baselineComparison);
```

`SimulationOptions` accepts `runs` (1–500), `seed`, `horizonHours` (1–720), `criticalCargoOnTimeTargetPercent`, `maxArrivalDelayHours`, `weatherSeverityVariation`, `capacityReductionVariation`, `unloadingTimeVariation`, and `equipmentFailureProbability`. The default target is 80% of essential cargo containers delivered by their deadlines. `probabilityOfMeetingTarget` is the share of simulation runs meeting that target; it is separate from Jev's decision confidence and answer probabilities. Average cargo delay is container-weighted delay after each cargo deadline. Utilization uses modeled current capacity over the horizon. `estimatedDelayCost` is returned only when every cargo item has a delay-cost input.

The simulator treats each vessel's full manifest as one unloading job; all cargo aboard completes when that vessel finishes unloading. Forecast weather and sampled capacity reductions adjust the supplied current capacity, so callers should avoid including the same future weather impact twice. These assumptions are returned as warnings with recommendations.

Jev's cargo-urgency Score uses four ordered levels: no essential cargo or its nearest deadline is over 72 hours away; nearest deadline 48–72 hours away; nearest deadline 24–48 hours away or significant delay cost; and deadline within 24 hours or very high delay cost. Operational-risk Score levels are low at 80% or more of normal capacity without severe disruption, moderate at 60–79% or a manageable queue, high at 40–59% or essential cargo at risk, and severe below 40%, with no unloading capacity, or with low simulated odds of meeting the target. Choice candidates contain only strategies generated and simulated by the harness; Jev cannot add operations or outcomes.

If Jev is not configured, times out, fails, or selects an invalid strategy ID, the route returns a warning and selects the deterministic arrival-order baseline. Set `JEV_MOCK=true` in local development or tests to use a deterministic, clearly marked mock selection without API credits; production ignores this flag. Recommendations always have `humanApprovalRequired: true`; the harness never controls actual port operations.

### Live data and provenance

The demo state marks all data synthetic. `applyOpenMeteoForecast` adapts the existing `/api/weather` response into forecast points and marks severe weather alerts unavailable because that endpoint does not provide them. `applyAisPositionReport` updates only a matching vessel's position, heading, and speed from `/api/ships` position events. Arrival times, destinations, manifests, deadlines, capacities, and disruption impacts remain whatever the caller supplied. The recommendation includes `dataProvenance` and warnings so mixed live and synthetic inputs remain visible.

Run the harness checks with:

```sh
npm run test:api
```

## Port data APIs

- `GET /api/weather` returns a two-day hourly Open-Meteo weather and marine forecast for the Port of Los Angeles.
- `GET /api/ships` is a Server-Sent Events stream. Listen for `vessel` events with `EventSource`; each event contains an AISStream `PositionReport` message for the San Pedro Bay area.

Set `AISSTREAM_API_KEY` in `.env.local` (copy `.env.example`) before using the ships endpoint. Keep this key server-side; the route does not expose it to the browser. The ships route uses the server's built-in WebSocket, so run it on Node.js 22 or later. The API check script requires Node.js 22.6 or later. Open-Meteo does not require a key.

```js
const forecast = await fetch("/api/weather").then((response) => response.json());
const ships = new EventSource("/api/ships");
ships.addEventListener("vessel", (event) => {
  const aisMessage = JSON.parse(event.data);
  // Use aisMessage.MetaData and aisMessage.Message.PositionReport in the harness.
});
```

Run the API route checks with `npm run test:api`.

## Getting Started

### Docker (app only)

This setup builds and runs the Next.js UI and its API routes. Jev runs in your separately managed container. Docker Compose v2.24 or newer is required.

If you do not already have `.env`, copy `.env.example` to `.env`. Set `TYPESAFE_API_KEY` and `AISSTREAM_API_KEY` there. To use your Jev container, set `TYPESAFE_BASE_URL` to its API root using `http://host.docker.internal:<published-port>` (replace `<published-port>` with Jev's actual published host port). Compose supplies the host alias on Linux. `localhost` inside the app container refers to the app container itself. If `TYPESAFE_BASE_URL` is unset, the SDK uses the hosted TypeSafe API.

```sh
docker compose up --build -d app
docker compose logs -f app
```

Open [http://localhost:3000](http://localhost:3000). For a different app port, use `APP_PORT=8080 docker compose up --build -d app`.

The image uses Node.js 22, Next.js standalone output, and a non-root runtime user. Credentials are passed from `.env` at runtime; `.env.local` is not loaded by this setup. `JEV_MOCK` is ignored in production. Rebuild after source changes.

```sh
docker compose down
```

This Compose project is named `harbormind-app`; it defines only the app service and does not manage the Jev container.

### Local development

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
