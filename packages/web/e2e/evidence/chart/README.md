# Chart browser evidence

Synthetic editor fixtures rendered through an isolated production `ub open`
and a separate `ub mcp serve` writer. The chart specification regenerates these
screenshots and measures drawing from the browser's full data availability.
Its observers inspect the existing Yjs document without a product test hook.

| Light | Dark |
| --- | --- |
| ![Light chart](light.png) | ![Dark chart](dark.png) |

The browser suite covers source insertion and keyboard/pointer access, live
data and mapping updates, canvas names/descriptions, appearance changes, reopen,
problem recovery and content locks. Timing fixtures contain a 2.7 MB area with
4,400 records and a 365-record/three-series chart, plus 5,001 stored records
limited to the latest 5,000/eight series. Chromium uses a 1366×768 viewport,
en-US locale and twofold CPU throttling; the PR records the measured values and
the host class. Unit suites defend value semantics, non-destructive invalid
merges, zero renderer writes, frame coalescing, observer release and old-client
preservation.

Run `mise run e2e -- chart.spec.ts --project=chromium` to regenerate the
screenshots and timing JSON attachments. The shared gate records timings and
asserts complete data availability, successive live redraws and zero renderer
writes; host-dependent wall-clock timings do not fail it. To enforce the
recorded budgets on a benchmark host, run
`env UB_CHART_TIMING_BUDGETS=1 mise run e2e -- chart.spec.ts --project=chromium --workers=1`.
That opt-in requires representative first draw within 500 ms and median redraw
within 250 ms, plus bounded first draw, median and every redraw within 1,000 ms.
