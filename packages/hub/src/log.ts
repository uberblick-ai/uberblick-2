/**
 * Hub logging.
 *
 * One line of JSON per event on stderr. Structured because the interesting
 * readers are agents and log pipelines, not humans watching a terminal; stderr
 * because stdout belongs to whatever transport a sibling process is speaking
 * (the MCP server's stdout is JSON-RPC) and copying that discipline everywhere
 * keeps it cheap to hold.
 */

export interface HubLogRecord {
  /** Dotted event name, e.g. `hub.listen`. */
  event: string;
  [key: string]: unknown;
}

export type HubLogger = (record: HubLogRecord) => void;

export const stderrLogger: HubLogger = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/** For tests and embedders that do their own logging. */
export const silentLogger: HubLogger = () => {};
