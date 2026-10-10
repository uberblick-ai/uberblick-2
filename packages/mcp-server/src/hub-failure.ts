export type HubFailureCause = "dns" | "refused" | "timeout" | "tls" | "http" | "closed";

const CODE = /^[A-Z][A-Z0-9_]*$/;
const TARGET = /^[a-zA-Z0-9_.:[\]-]+$/;
const NUMBER = /^\d+(?:\.\d+)?$/;
// Node's named certificate-verification errors, shared by observation and wording:
// https://nodejs.org/api/errors.html#openssl-error-codes
export const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED", "CERT_REJECTED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "INVALID_CA", "INVALID_PURPOSE", "PATH_LENGTH_EXCEEDED",
  "CRL_NOT_YET_VALID", "CRL_HAS_EXPIRED", "CERT_CHAIN_TOO_LONG", "UNABLE_TO_GET_CRL", "HOSTNAME_MISMATCH",
  "CRL_SIGNATURE_FAILURE", "ERROR_IN_CERT_NOT_BEFORE_FIELD", "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD", "ERROR_IN_CRL_NEXT_UPDATE_FIELD", "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE", "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
]);

/** Shared CLI wording for the safe, locally composed socket failure detail. */
export function formatHubFailure(reading: { cause?: HubFailureCause; detail?: string }): string | undefined {
  if (reading.cause === undefined || reading.detail === undefined) return undefined;
  const parts = reading.detail.split(" ");
  const [first, target, code] = parts;
  if (first === undefined) return undefined;
  switch (reading.cause) {
    case "dns":
    case "refused":
    case "tls": {
      if (parts.length !== 2 || !CODE.test(first) || target === undefined || !TARGET.test(target)) return undefined;
      if (reading.cause === "dns") return `DNS lookup failed for ${target} (${first})`;
      if (reading.cause === "refused") return `refused by ${target} (${first})`;
      const certificate = first.startsWith("ERR_TLS_CERT_") || CERTIFICATE_CODES.has(first);
      return `TLS ${certificate ? "certificate not valid" : "failed"} for ${target} (${first})`;
    }
    case "timeout":
      if ((parts.length !== 2 && parts.length !== 3) || !NUMBER.test(first) || target === undefined || !TARGET.test(target)
        || (code !== undefined && !CODE.test(code))) return undefined;
      return `timed out after ${first}s connecting to ${target}${code === undefined ? "" : ` (${code})`}`;
    case "http":
      if (parts.length !== 2 || !/^\d{3}$/.test(first) || target === undefined || !TARGET.test(target)) return undefined;
      return `HTTP ${first} from ${target} during WebSocket upgrade`;
    case "closed":
      if (parts.length !== 1 || !/^\d+$/.test(first)) return undefined;
      return `closed by the hub (code ${first})`;
  }
}
