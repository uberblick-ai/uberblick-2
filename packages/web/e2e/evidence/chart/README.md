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
