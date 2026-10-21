/**
 * Which reverse proxies the API trusts when it works out a client's address (req.ip), controlled by the TRUST_PROXY environment variable.
 *
 * The client address is what the per-IP limiters key on, so it must not be spoofable: X-Forwarded-For is only believed when the request
 * really came through a proxy the operator has named. Accepted values:
 *   (unset / empty / "false" / "0")  trust nothing - req.ip is the socket peer. Safe default, but behind a platform proxy that peer is the
 *                                    proxy itself, so every visitor would share one limiter bucket: the hosting owner MUST set this.
 *   a whole number N                 trust exactly N proxy hops in front of the app (e.g. 1 when exactly one platform proxy sits in front)
 *   a comma-separated list of IPs/CIDRs or Express keywords ("loopback", "linklocal", "uniquelocal")
 *   "true" and anything unrecognised are REFUSED (they would trust whatever header a client sends) and fall back to trusting nothing.
 * The number of hops is a property of the hosting set-up and is deliberately NOT guessed here.
 */
export type TrustProxySetting = false | number | string[];

const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);
const looksLikeAddress = (v: string) => /^[0-9a-f:.]+(\/\d{1,3})?$/i.test(v) && /[.:]/.test(v);

export function parseTrustProxy(raw: string | undefined): { setting: TrustProxySetting; problem?: string } {
  const value = (raw ?? "").trim();
  if (!value || value === "false" || value === "0") return { setting: false };
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops >= 1 && hops <= 10 ? { setting: hops } : { setting: false, problem: "TRUST_PROXY hop count must be between 1 and 10; trusting no proxy" };
  }
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0 && parts.every((p) => KEYWORDS.has(p.toLowerCase()) || looksLikeAddress(p))) return { setting: parts };
  return { setting: false, problem: "TRUST_PROXY is not a hop count or a list of proxy addresses; trusting no proxy" };
}
