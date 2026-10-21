#!/usr/bin/env node
// Spike probe 2: does a hub-owned, hour-aligned window give stable bucket ids,
// and how big is a FACET TIMESERIES once pivoted to one field per facet?
// Same env as newrelic-probe.mjs. Prints only sizes, ids and counts.
const key = process.env.NEW_RELIC_USER_KEY;
const account = Number(process.env.NEW_RELIC_ACCOUNT_ID);
if (!key || !Number.isSafeInteger(account)) { console.error("Set NEW_RELIC_USER_KEY and NEW_RELIC_ACCOUNT_ID."); process.exit(2); }
const endpoint = process.env.NEW_RELIC_REGION === "eu" ? "https://api.eu.newrelic.com/graphql" : "https://api.newrelic.com/graphql";
const QUERY = `query($id: Int!, $nrql: Nrql!) { actor { account(id: $id) { nrql(query: $nrql, timeout: 30) { results } } } }`;
async function run(nrql) {
  const started = Date.now();
  const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(35_000),
    headers: { "Content-Type": "application/json", "API-Key": key },
    body: JSON.stringify({ query: QUERY, variables: { id: account, nrql } }) });
  const json = await response.json();
  return { ms: Date.now() - started, errors: (json.errors ?? []).map((e) => e.message), results: json.data?.actor?.account?.nrql?.results ?? [] };
}
const HOUR = 3_600_000;
/** The hub owns the window: whole buckets, ending at the current bucket's end. */
function window(hours) {
  const end = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
  return `SINCE ${end - hours * HOUR} UNTIL ${end} TIMESERIES 1 hour`;
}
/** Long rows (facet, bucket) become one record per bucket with one field per facet. */
function pivot(rows, valueField) {
  const byTime = new Map();
  for (const row of rows) {
    const time = new Date(row.beginTimeSeconds * 1000).toISOString();
    const record = byTime.get(time) ?? { time };
    const raw = row[valueField];
    record[String(row.facet)] = raw !== null && typeof raw === "object" ? Object.values(raw)[0] : raw;
    byTime.set(time, record);
  }
  return [...byTime.entries()].map(([id, value]) => ({ id, value }));
}
const ids = (rows) => rows.map((r) => r.beginTimeSeconds);

const plain = `SELECT percentile(duration, 95) AS p95, count(*) AS throughput FROM Transaction ${window(168)}`;
const first = await run(plain);
await new Promise((r) => setTimeout(r, 65_000));
const second = await run(plain);
const a = ids(first.results);
const b = new Set(ids(second.results));
const stable = a.filter((t) => b.has(t)).length;
const alignedToHour = a.every((t) => (t * 1000) % HOUR === 0);
let changed = 0;
for (const row of second.results) {
  const before = first.results.find((r) => r.beginTimeSeconds === row.beginTimeSeconds);
  if (JSON.stringify(before) !== JSON.stringify(row)) changed++;
}

const facet = await run(`SELECT percentile(duration, 95) AS p95 FROM Transaction WHERE appName = 'Campfire API (Production)' FACET name LIMIT 5 ${window(168)}`);
const pivoted = pivot(facet.results, "p95");

console.log(JSON.stringify({
  endpoint,
  aligned: { ms: [first.ms, second.ms], errors: [...first.errors, ...second.errors], rows: [first.results.length, second.results.length],
    alignedToHour, idsShared: stable, rowsChangedAfter65s: changed, firstBucket: a[0] ? new Date(a[0] * 1000).toISOString() : null,
    lastBucket: a.at(-1) ? new Date(a.at(-1) * 1000).toISOString() : null },
  facetPivot: { ms: facet.ms, errors: facet.errors, longRows: facet.results.length, longBytes: JSON.stringify(facet.results).length,
    records: pivoted.length, recordBytes: JSON.stringify(pivoted).length, fieldsPerRecord: Object.keys(pivoted[0]?.value ?? {}).length,
    longestFieldName: Math.max(0, ...Object.keys(pivoted[0]?.value ?? {}).map((k) => k.length)) },
}, null, 1));
