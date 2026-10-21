#!/usr/bin/env node
// Spike probe: run real NerdGraph NRQL calls and save redacted responses.
// Reads NEW_RELIC_USER_KEY and NEW_RELIC_ACCOUNT_ID; optional NEW_RELIC_REGION=eu.
// Usage: node spike-live-data/newrelic-probe.mjs [out-dir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const key = process.env.NEW_RELIC_USER_KEY;
const account = Number(process.env.NEW_RELIC_ACCOUNT_ID);
if (!key || !Number.isSafeInteger(account)) {
  console.error("Set NEW_RELIC_USER_KEY and NEW_RELIC_ACCOUNT_ID.");
  process.exit(2);
}
const endpoint = process.env.NEW_RELIC_REGION === "eu" ? "https://api.eu.newrelic.com/graphql" : "https://api.newrelic.com/graphql";
const out = process.argv[2] ?? "spike-live-data/fixtures";
mkdirSync(out, { recursive: true });

const QUERY = `query($id: Int!, $nrql: Nrql!) { actor { account(id: $id) {
  nrql(query: $nrql, timeout: 30) { results metadata { facets eventTypes timeWindow { begin end } } } } } }`;

function redact(text) {
  return text.replaceAll(key, "NRAK-REDACTED").replaceAll(String(account), "ACCOUNT");
}

async function call(name, body, apiKey = key) {
  const started = Date.now();
  let status = 0;
  let headers = {};
  let text = "";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-Key": apiKey },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(35_000),
    });
    status = response.status;
    headers = Object.fromEntries([...response.headers].filter(([h]) => /rate|limit|retry|request-id|content-length/i.test(h)));
    text = await response.text();
  } catch (error) {
    text = JSON.stringify({ fetchError: String(error) });
  }
  const ms = Date.now() - started;
  writeFileSync(join(out, `${name}.json`), redact(JSON.stringify({ status, ms, headers, body: safeParse(text) }, null, 1)));
  return { name, status, ms, bytes: text.length, json: safeParse(text) };
}
function safeParse(text) { try { return JSON.parse(text); } catch { return text.slice(0, 2000); } }
const nrql = (q) => ({ query: QUERY, variables: { id: account, nrql: q } });

/** One record per bucket or facet; ids stay stable across refreshes. */
export function toRecords(results) {
  return results.map((row) => {
    const value = {};
    for (const [field, raw] of Object.entries(row)) {
      if (field === "beginTimeSeconds") value.time = new Date(raw * 1000).toISOString();
      else if (field === "endTimeSeconds") continue;
      else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        // percentile(x, 95) arrives as { "95": n }
        for (const [k, v] of Object.entries(raw)) value[`${field}.${k}`] = v;
      } else value[field] = raw;
    }
    const id = value.time ?? (Array.isArray(row.facet) ? row.facet.join(" · ") : row.facet) ?? JSON.stringify(row);
    return { id: String(id), value };
  });
}

const probes = [];
probes.push(await call("event-types", nrql("SHOW EVENT TYPES SINCE 1 week ago")));
const types = probes[0].json?.data?.actor?.account?.nrql?.results?.map((r) => r.eventType) ?? [];
const eventType = types.includes("Transaction") ? "Transaction" : (types[0] ?? "Transaction");
const fields = eventType === "Transaction" ? "count(*) AS throughput, percentile(duration, 95) AS p95" : "count(*) AS events";
probes.push(await call("timeseries-hourly-7d", nrql(`SELECT ${fields} FROM ${eventType} TIMESERIES 1 hour SINCE 7 days ago`)));
probes.push(await call("timeseries-daily-30d", nrql(`SELECT ${fields} FROM ${eventType} TIMESERIES 1 day SINCE 30 days ago`)));
probes.push(await call("facet-top10-1d", nrql(`SELECT count(*) FROM ${eventType} FACET appName SINCE 1 day ago LIMIT 10`)));
probes.push(await call("timeseries-facet", nrql(`SELECT count(*) FROM ${eventType} FACET appName TIMESERIES 1 hour SINCE 1 day ago LIMIT 5`)));
probes.push(await call("timeseries-max-buckets", nrql(`SELECT count(*) FROM ${eventType} TIMESERIES 5 minutes SINCE 7 days ago`)));
probes.push(await call("bad-syntax", nrql(`SELEC count(*) FROM ${eventType}`)));
probes.push(await call("injection-attempt", nrql(`SELECT count(*) FROM ${eventType}") { results } } } mutation { x`)));
probes.push(await call("wrong-account", { query: QUERY, variables: { id: 1, nrql: "SELECT count(*) FROM Transaction" } }));
probes.push(await call("bad-key", nrql("SELECT count(*) FROM Transaction"), "NRAK-INVALIDINVALIDINVALIDINVALID"));

const summary = probes.map(({ name, status, ms, bytes, json }) => {
  const results = json?.data?.actor?.account?.nrql?.results;
  const records = Array.isArray(results) ? toRecords(results) : [];
  return {
    name, status, ms, bytes,
    errors: (json?.errors ?? []).map((e) => redact(`${e.message ?? ""} ${JSON.stringify(e.extensions ?? {})}`).slice(0, 300)),
    rows: Array.isArray(results) ? results.length : null,
    recordBytes: JSON.stringify(records).length,
    sampleRecord: records[records.length - 1] ?? null,
  };
});
writeFileSync(join(out, "summary.json"), JSON.stringify({ endpoint, eventType, summary }, null, 1));
console.log(JSON.stringify({ endpoint, eventType, summary }, null, 1));
