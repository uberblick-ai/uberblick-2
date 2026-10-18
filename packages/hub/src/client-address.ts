import type { IncomingMessage } from "node:http";
import { isIP, SocketAddress } from "node:net";

function clientBucket(address: string | undefined): string | undefined {
  const host = address?.split("%", 1)[0];
  if (host === undefined || !isIP(host)) return undefined;
  const parsed = SocketAddress.parse(host.includes(":") ? `[${host}]:0` : `${host}:0`);
  if (parsed === undefined) return undefined;
  if (parsed.family === "ipv4") return parsed.address;
  if (parsed.address.startsWith("::ffff:")) return parsed.address.slice(7);

  // URL serialization also writes embedded IPv4 as hextets before /64 grouping.
  const canonical = new URL(`http://[${parsed.address}]`).hostname.slice(1, -1);
  const [first = "", last] = canonical.split("::");
  const head = first.split(":").filter(Boolean);
  const tail = last?.split(":").filter(Boolean) ?? [];
  const groups = last === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** The release proxy appends its observed client; every other deployment uses the TCP peer. */
export function requestClient(request: IncomingMessage, behindReleaseProxy = false): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (behindReleaseProxy && typeof forwarded === "string") {
    const observed = forwarded.slice(forwarded.lastIndexOf(",") + 1).trim();
    const bucket = clientBucket(observed);
    if (bucket !== undefined) return bucket;
  }
  return clientBucket(request.socket.remoteAddress) ?? "unknown";
}
