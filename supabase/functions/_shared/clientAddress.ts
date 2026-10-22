// The caller's network address, for the login throttle and for Auth's own per-address limits (Sb-Forwarded-For).
//
// Hosted Supabase puts Cloudflare in front of the functions. CF-Connecting-IP carries the client's address (Cloudflare
// rejects requests that bring their own), the gateway strips a client-sent X-Real-IP and rebuilds X-Forwarded-For as
// "<client>, <client>, <internal hop>" (probed on a hosted project, 2026-10-08). The order is therefore
// CF-Connecting-IP, then X-Real-IP (set by the gateway of a local stack), then the leftmost X-Forwarded-For entry. The
// rightmost entry is an internal hop there and would put every caller under one throttle key.
//
// IPv6 callers are grouped by their /64 network (one customer site): otherwise a single host could rotate through 2^64
// addresses and never meet the per-address limit.

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
/** The longest textual IPv6 address (eight groups, or six and an IPv4 tail) has 45 characters. */
const MAX_ADDRESS_LENGTH = 45;

export interface ClientAddress {
  /** The address as received, in lower case (an IPv4-mapped IPv6 address as plain IPv4); forwarded to Auth. */
  ip: string;
  /** Throttle identity: the IPv4 address, or the /64 network of an IPv6 address ("2001:db8:0:1::/64"). */
  network: string;
}

/** The first usable address among CF-Connecting-IP, X-Real-IP and the leftmost X-Forwarded-For entry; null if none. */
export function clientAddress(headers: Headers): ClientAddress | null {
  const candidates = [
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for")?.split(",")[0],
  ];
  for (const candidate of candidates) {
    const address = parseAddress(candidate);
    if (address !== null) return address;
  }
  return null;
}

/** An IPv4 or IPv6 address without port or zone; null for anything else, so junk never becomes a throttle key. */
export function parseAddress(value: string | null | undefined): ClientAddress | null {
  const text = value?.trim().toLowerCase() ?? "";
  if (text === "" || text.length > MAX_ADDRESS_LENGTH) return null;
  if (IPV4.test(text)) return { ip: text, network: text };
  const groups = parseIpv6(text);
  if (groups === null) return null;
  if (isIpv4Mapped(groups)) {
    const ipv4 = ipv4FromGroups(groups);
    return { ip: ipv4, network: ipv4 };
  }
  return { ip: text, network: `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64` };
}

/** The eight 16-bit groups of an IPv6 address ("::" compression and an IPv4 tail allowed); null when invalid. */
export function parseIpv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const head = parseGroups(halves[0] ?? "", !compressed);
  const tail = compressed ? parseGroups(halves[1] ?? "", true) : [];
  if (head === null || tail === null) return null;
  if (!compressed) return head.length === 8 ? head : null;
  // "::" stands for at least one group of zeros
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

function parseGroups(text: string, ipv4TailAllowed: boolean): number[] | null {
  if (text === "") return [];
  const parts = text.split(":");
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (HEX_GROUP.test(part)) {
      groups.push(Number.parseInt(part, 16));
    } else if (ipv4TailAllowed && index === parts.length - 1 && IPV4.test(part)) {
      const [a = 0, b = 0, c = 0, d = 0] = part.split(".").map(Number);
      groups.push(a * 256 + b, c * 256 + d);
    } else {
      return null;
    }
  }
  return groups;
}

function isIpv4Mapped(groups: readonly number[]): boolean {
  return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
}

function ipv4FromGroups(groups: readonly number[]): string {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
