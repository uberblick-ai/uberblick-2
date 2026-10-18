import { format } from "node:util";

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

/** Keep library output inside the hub's one-JSON-event-per-line log. */
export function hocuspocusLogger(
  logger: HubLogger,
): Pick<Console, "warn" | "error"> {
  return {
    warn: (...args: unknown[]) =>
      logger({ event: "hub.hocuspocus.warning", message: format(...args) }),
    error: (...args: unknown[]) =>
      logger({ event: "hub.hocuspocus.error", message: format(...args) }),
  };
}

/** For tests and embedders that do their own logging. */
export const silentLogger: HubLogger = () => {};
