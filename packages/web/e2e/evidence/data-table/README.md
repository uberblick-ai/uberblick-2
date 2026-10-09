# Continuous data-table evidence

Synthetic generated and ordinary tables in the same document, under an author's
Changelog heading: [light](light.png), [dark](dark.png). The browser proof compares
computed cell borders, padding, font size/weight, text color and header background;
it also checks footnote contrast, native naming, secondary source/copy actions,
keyboard and no-hover access, source editing, locks and horizontal containment.

Regenerate the screenshots and timing attachments with:

```sh
env UB_CHART_TIMING_BUDGETS=1 mise run e2e -- data-table.spec.ts --project=chromium --workers=1
```

The existing Chromium probe runs at 2× CPU throttling. Each table contains all
4,035 observation records and ten columns; the area contains another 365 chart
summary records (2,698,654 canonical bytes). The mixed document mounts ten tables
and ten charts. The attached [single](single.json) and [mixed](mixed.json) samples
record ten single-record updates each:

| Workload | First DOM completion | Median update | Maximum update |
| --- | ---: | ---: | ---: |
| One table | 256.6 ms | 135.9 ms | 161.6 ms |
| Ten tables + ten charts | 1,248.4 ms | 243.8 ms | 803.0 ms |

Every measured update reads the complete data area once; the renderer makes no
local Yjs update. The original 500 ms first-render budget for one table and
250/500 ms median update budgets remain enforced. First DOM completion is the
existing probe's interval from data availability until every view's DOM shows
the expected values; it does not measure first paint. Mixed initial browser
availability exceeded the old 20-second locator wait, so its initial wait is
60 seconds. That later delay has not been traced to a particular browser phase.

Full native rendering costs time and memory proportional to rows × columns.
Collections with tens of thousands of records render slowly. There is no cap,
pager or row windowing; these measurements do not promise bounded initial paint
or maximum update latency. Final-head validation is recorded in the PR.
