# Continuous data-table evidence

Synthetic generated and ordinary tables in the same document, under an author's
Changelog heading: [light](light.png), [dark](dark.png). The browser proof compares
computed cell borders, padding, font size/weight, line height, text color and header background;
it also checks whole-word headers, footnote contrast, native naming, secondary
source/copy actions, keyboard and no-hover access, source editing and locks.
Revealed actions clear both table and footnote text, including at a 390px touch
viewport. The ten-column timing workload and a thirty-column table scroll
horizontally within their blocks.

Both tables use horizontal rules, unshaded headers slightly quieter than other
muted text, and compact body rows.
The touch proof covers [iPad light](ipad-light.png), [iPad dark](ipad-dark.png),
[narrow iPad light](ipad-narrow-light.png) and [narrow iPad dark](ipad-narrow-dark.png)
at 820px and 600px widths. It checks 44px Markdown cells and sort targets and
sorts through native touch input in both appearances. These captures show the
sort button's existing focus and hover feedback after a tap.

Regenerate appearance screenshots with:

```sh
mise run e2e -- data-table.spec.ts --project=chromium --project=webkit-ipad --workers=1 --grep 'all rows read|table rules and touch targets'
```

Copy the Chromium `data-table-light.png` and `data-table-dark.png` attachments
to `light.png` and `dark.png`. Copy WebKit's `table-rules-820-*.png` attachments
to `ipad-*.png` and its `table-rules-600-*.png` attachments to `ipad-narrow-*.png`.

Run the isolated workloads and regenerate timing attachments with:

```sh
mise run e2e -- data-table.spec.ts --project=chromium-workload --no-deps --workers=1
```

The existing Chromium probe runs at 2× CPU throttling. Each table contains all
4,035 observation records and ten columns; the area contains another 365 chart
summary records (2,698,654 canonical bytes). The mixed document mounts ten tables
and ten charts. The attached [single](single.json) and [mixed](mixed.json) samples
record ten single-record updates each:

| Workload | First DOM completion | Median update | Maximum update |
| --- | ---: | ---: | ---: |
| One table | 256.8 ms | 133.2 ms | 155.0 ms |
| Ten tables + ten charts | 1,361.6 ms | 292.4 ms | 603.3 ms |

These committed samples are host observations, not enforced CI guarantees.
The unchanged numeric budgets apply only under `UB_CHART_TIMING_BUDGETS=1`:
500 ms first DOM completion for one table, and 250/500 ms median updates for
single/mixed views. To opt in on a benchmark host, run:

```sh
env UB_CHART_TIMING_BUDGETS=1 mise run e2e -- data-table.spec.ts --project=chromium-workload --no-deps --workers=1
```

First DOM completion is the probe's interval from data availability until every
view's DOM shows the expected values; it does not measure first paint or the
whole readiness phase. The mixed scenario retains its 180-second readiness
wait and 360-second test allowance for required native layout of 403,500 cells
alongside ten real Chart.js charts. The single table uses the normal 60-second
test budget. Neither numeric benchmark budgets nor recorded timings are product
performance promises.

Each scenario is independent and retains ten live updates. The single view
exercises native ten-column table layout, horizontal overflow containment and
updates across 4,035 continuous rows. The mixed view exercises that same layout
across ten tables, with ten actual Chart.js drawings sharing the document.
Those browser costs are absent from the mocked Chart.js component tests.
`packages/web/test/chart.test.ts` owns the deterministic invariants retained in
these probes: “shares one full read and observer across mixed views, with no
reads for source, caret, prose or annotation” checks shared reads, one read per
update frame and no renderer writes; “mounts, redraws a burst once per frame,
follows remote mapping/data and adds no local update” and “coalesces data,
mapping, theme, appearance and font redraws through one binding without writes”
own coalescing and no writes.

New timing attachments include Node wall-clock `phases` in milliseconds:
`setup` covers session/document/data creation; `initialReadiness` covers
opening the browser page through draw, row-count and overflow assertions;
`liveUpdates` covers ten updates and the positive arrival/no-write check;
`cleanup` covers closing the browser context; `total` covers their sum.
Playwright's reported duration
also includes hooks and timing publication. These phase durations are diagnostic
CI evidence for the maintainer's scale/budget assessment, with no new thresholds.

Full native rendering costs time and memory proportional to rows × columns.
Collections with tens of thousands of records render slowly. There is no cap,
pager or row windowing; these measurements do not promise bounded initial paint
or maximum update latency. Final-head validation is recorded in the PR.
