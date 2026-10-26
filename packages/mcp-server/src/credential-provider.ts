import {
  ensureDeviceLogin,
  readDeviceLogin,
  type DeviceLoginOptions,
  type DeviceLoginResult,
} from "./device-login.js";

export type CredentialEnsureOptions = Omit<DeviceLoginOptions, "env">;

/** One grant's credential authority, including renewal coordination and outcomes. */
export interface CredentialProvider {
  read(): DeviceLoginResult;
  ensure(options?: CredentialEnsureOptions): Promise<DeviceLoginResult>;
}

/** Keep local callers on the existing per-origin login store and renewal files. */
export function createLocalCredentialProvider(
  endpoint: string,
  workspace: string,
  env?: NodeJS.ProcessEnv,
): CredentialProvider {
  return {
    read: () => readDeviceLogin(endpoint, workspace, env),
    ensure: (options = {}) => ensureDeviceLogin(endpoint, workspace, {
      ...options,
      ...(env === undefined ? {} : { env }),
    }),
  };
}
