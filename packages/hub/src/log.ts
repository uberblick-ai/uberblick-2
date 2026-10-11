export interface HubLogRecord {
  /** Dotted event name, e.g. `hub.listen`. */
  event: string;
  [key: string]: unknown;
}

export type HubLogger = (record: HubLogRecord) => void;

export const stderrLogger: HubLogger = (record) => {
  // One JSON event per stderr line leaves stdout available for transports.
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/** For tests and embedders that do their own logging. */
export const silentLogger: HubLogger = () => {};
