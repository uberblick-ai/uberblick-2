/**
 * @uberblick/cli package entry.
 *
 * The process entry point is ./main.ts, reached through bin/ub.mjs. What is
 * exported here is what the next `ub` subcommand needs: the configuration
 * resolution, and the command dispatch it plugs into.
 */

export { HELP, runCli } from "./cli.js";
export {
  CREDENTIALS_FILE,
  DIRECTORY_FILE,
  USER_CONFIG_FILE,
  configHome,
  credentialsPath,
  resolveConfig,
  userConfigPath,
  writeCredentials,
} from "./config.js";
export type {
  Credentials,
  CredentialOrigin,
  Origin,
  ResolveOptions,
  ResolvedConfig,
} from "./config.js";
export type { Io } from "./io.js";
export { processIo } from "./io.js";
export { mcpCommand, serveCommand } from "./serve.js";
export { renderStatus, statusCommand, statusReport } from "./status.js";
export type { StatusReport } from "./status.js";
export { cliVersion } from "./version.js";
