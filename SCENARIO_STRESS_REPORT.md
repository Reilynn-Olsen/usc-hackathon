# HarborMind scenario stress report

**Run date:** 2026-10-17

**Result:** PASS with the limits below

**Automation:** `npm run test:api` with deterministic Jev callbacks or `JEV_MOCK=true`; separate full Chrome browser run against live Jev credentials. Credential values were not logged or exposed.

Metric notes: critical on-time is the share of essential containers unloaded by their deadlines. Average container delay is container weighted. Disruption cost is the modeled delay cost plus intervention cost. “At risk” follows the UI calculation: total containers minus rounded mean containers processed by the horizon. Target likelihood is the share of seeded runs meeting the configured critical-delivery target.

## Primary scenarios

### 1. No disruption and unnecessary intervention — PASS

- **Configuration:** T0 `2026-10-16T12:00Z`; 4 demo vessels, 285 containers; 2,400 containers/day; 4 berths and unloading resources; no disruptions or weather; 36h horizon; 1 run, seed 1; all simulation variations and arrival delay set to 0; balanced objective, 80% critical-delivery target.
- **Candidates sent to Jev:** Normal arrival order; a 2h T+0 staging proposal for `evergreen-1`; a 2h T+0 staging plan for `ocean-crown`.
- **Mock Jev choice:** Stage `evergreen-1` for 2h.
- **Final validated plan:** Normal arrival order. The staged proposal has the same cargo delivery, delay, cost, and throughput metrics but delays one extra vessel, so the safeguard retains the no-intervention baseline.
- **Final metrics:** critical on time **100%**; average container delay **0.00h**; disruption cost **$0**; containers at risk **0**; target likelihood **100%**. The rejected proposal had **1** delayed vessel; baseline had **0**.
- **Safeguard warning:** Jev’s proposal was no better across measured outcomes; the no-intervention baseline was retained.

### 2. Severe coastal storm — PASS

- **Configuration:** T0 `2026-10-16T12:00Z`; Port of Los Angeles at 240 containers/day, 2 berths/resources; 60% capacity loss from T+0 through T+17; 4 vessels and 285 containers; demo weather forecast and severe alert; 36h horizon; 40 runs, seed 42; critical-delivery objective and 80% target.
- **Candidates sent to Jev:** Normal arrival order; critical-first with `evergreen-1` staged 2h from T+16; critical-first with `evergreen-1` staged 2h from T+0 and a protected berth; critical-first with `ocean-crown` staged 2h from T+0.
- **Mock Jev choice / final plan:** `Stage evergreen-1 for 2h` (critical-first, staging window T+16–T+18); accepted without override.
- **Final metrics:** critical on time **98.46%**; average container delay **0.01h**; disruption cost **$1,430**; containers at risk **111**; target likelihood **95%**. Baseline: **3.54%**, **2.01h**, **$149,590**, **108 at risk**, **0%** target likelihood.
- **Warnings:** synthetic inputs and severe weather; the harness applies forecast effects and sampled capacity reductions on top of supplied current capacity, so confirm the input capacity does not already include those impacts. The chosen critical-first plan processes about 3.5 fewer containers on average than baseline, leaving more standard cargo unprocessed at the horizon.

### 3. Storm plus T+10 crane failure — PASS

- **Configuration:** T0 `2026-10-16T12:00Z`; 24 containers/day, 1 berth/resource; 60% storm reduction T+0–T+18; `vessel-a` has 10 standard retail containers and 2 critical medical containers (deadline T+20), `vessel-b` has 5 standard containers; 36h horizon; 3 runs, seed 42; no random arrival/capacity/equipment variation; additional 40% crane capacity loss T+10–T+22; 80% critical target.
- **Candidates at replanning:** Normal arrival order; continue current plan; critical cargo first.
- **Initial plan:** Normal arrival order. **Mock Jev choice / final plan:** Critical cargo first; accepted.
- **T+10 checkpoint:** Capacity **0.24 containers/hour** while storm and crane losses overlap; `vessel-a` retained its berth; `vessel-b` waited; retail was **4/10 unloaded** and medical was **0/2 unloaded**. Cargo progress and berth occupancy were preserved.
- **Checkpoint comparison (one seeded continuation):** current plan **0%** remaining critical on time, **17.06h** average container delay, **$580** cost; Jev plan **100%**, **17.41h**, **$592**. The plan trades a small increase in standard-container delay/cost for meeting the critical-delivery target.
- **Final 3-run metrics:** critical on time **100%**; average container delay **17.41h**; disruption cost **$592**; containers at risk **0**; target likelihood **100%**. Continuing the initial plan produced **0%** critical on time.
- **Warnings:** local Jev mock notice; no safeguard override. The checkpoint comparison is explicitly one seeded run per candidate, not a probability estimate.

### 4. Equivalent and dominated Jev proposals — PASS

- **Dominated proposal:** Scenario 1 above. A Jev-selected stage added a vessel delay without improving cargo outcomes; the no-intervention baseline was retained.
- **Equivalent proposal configuration:** zero containers/day, 1 berth, 0 unloading resources; no initial disruption; 4 demo vessels / 285 containers; 50% crane event T+10–T+16; 24h horizon; 2 runs, seed 42; critical target set to 0% to isolate equivalence.
- **Candidates:** Normal arrival order; continue current plan.
- **Mock Jev choice / final plan:** Normal arrival order / continue current plan. Safeguard status: `equivalent`.
- **Checkpoint comparison:** both plans processed **0** containers, left **285** at risk, had **0%** critical on time, **0.42h** average container delay, and **$48,000** modeled cost.
- **Note:** With a configured target of 0%, a 100% target likelihood is mathematically correct but operationally vacuous; use a meaningful positive target in a demo.

### 5. Multiple critical shipments sharing one berth — PASS

- **Configuration:** T0 `2026-10-16T12:00Z`; 24 containers/day; 1 berth/resource; no disruptions; three critical shipments of 3 containers each with deadlines T+4 (`critical-urgent`), T+8 (`critical-middle`), and T+12 (`critical-late`); 24h horizon; 1 run, seed 42; 80% target.
- **Candidates sent to Jev:** Normal arrival order; Critical cargo first.
- **Mock Jev choice / final plan:** Critical cargo first; schedule order urgent, middle, late.
- **Final metrics:** critical on time **100%**; average container delay **0.00h**; disruption cost **$0**; containers at risk **0**; target likelihood **100%**. Baseline delivered **66.67%** on time with **1.33h** average container delay and **$24** cost.
- **Constraints:** never more than 1 berth assigned or 1 container unloaded per hourly step.

### 6. Strict operating-cost ceiling — PASS WITH FLAG

- **Configuration:** T0 `2026-10-16T12:00Z`; 24 containers/day, 1 berth/resource; 50% throughput disruption T+0–T+18; two vessels / 17 containers (retail 10 at $100/container-hour, critical medical 2 at $0, consumer 5 at $100); 24h horizon; 1 run, seed 42; minimize-cost objective; **$0** cost ceiling; 0% critical target.
- **Candidates sent to Jev:** Normal arrival order; Critical cargo first.
- **Mock Jev choice / final plan:** Normal arrival order; no candidate meets the ceiling.
- **Final metrics:** critical on time **0%**; average container delay **7.88h**; disruption cost **$9,900**; containers at risk **2**; target likelihood **100%** because the target is 0%.
- **Constraint result:** selected plan has `meetsConstraints=false`; explanation explicitly reports that $9,900 exceeds the $0 ceiling. The API returns the least-violating selectable plan when no compliant plan exists and flags the violation.

## Additional stress checks

- **Zero capacity:** 0 containers/day, 0 berths/resources, 48h; **0 processed**, **285 at risk**, **0%** critical on time, **4.95h** average container delay, **$321,000** cost. No berth or throughput was invented.
- **Near-zero capacity:** 1 container/day, 1 berth/resource, 48h; **1 processed**, **284 at risk**; processing stayed within the 2-container 48h ceiling.
- **Overlapping disruptions:** 240 containers/day with two overlapping 50% losses; hourly capacity snapshots were **5, 2.5, 5, 10 containers/hour** across T+0 through T+3, confirming multiplicative overlap and exact event boundaries.
- **Occupied berth and partial cargo:** covered at T+10 in scenario 3; the berthed vessel kept its assignment, partially unloaded cargo remained at the same unloaded count, and the waiting vessel stayed queued.
- **Determinism:** repeated runs matched exactly for 8 runs / seed 1234 / 24h and for adaptive replay at 3 runs / seed 42 / 36h.
- **Operator objectives:** on the same two-vessel scenario, critical-delivery selected Critical cargo first (**50%** critical on time, **7.94h**, **$13,400**, 2 at risk); minimize-cost selected Normal arrival order (**0%**, **7.88h**, **$9,900**, 2 at risk). Trade-off is visible in the reported metrics.
- **Probability labels:** Jev choice and score distributions now require normalized probabilities; malformed distributions trigger deterministic fallback. Simulation target likelihood remains a seeded-run frequency, not a forecast confidence.
- **Metric label:** the displayed delay metric is now named **average container delay** because it is container weighted.

## Live Jev browser run — PASS

- **Configuration:** Default storm scenario; 40 runs, seed 42, 36h horizon, 80% critical-delivery target, balanced objective; 40% crane-capacity loss beginning T+10 for 18h.
- **Jev model:** `jev-1.13.0`.
- **Candidate and Jev-selected plan:** Jev selected `Stage evergreen-1 for 2h`.
- **Final validated plan:** `Stage evergreen-1 for 2h`; accepted without override.
- **Metrics:** critical on time **98.46%**; average container delay **0.02h**; disruption cost **$2,330**; containers at risk **131**; target likelihood **95%**.
- **T+10 checkpoint:** Jev proposed normal arrival order. The safeguard retained `Continue current recovery plan` because checkpoint outcomes were equivalent.
- **Browser result:** no UI error; the browser sent no credential headers.

## Submission checks

- API/harness regression: **35 passed, 0 failed**.
- Lint: **PASS** (`npm run lint`).
- Production build: **PASS** (`npm run build`, Next.js 16.4.2).
- Live browser test against Jev: **PASS** (details above).
