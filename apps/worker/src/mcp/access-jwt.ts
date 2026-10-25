// Verifies the Cloudflare Access `Cf-Access-Jwt-Assertion` header (RS256, WebCrypto only).

type AccessJwk = JsonWebKey & { kid?: string };

const CERTS_TTL_MS = 10 * 60 * 1000;
const certsCache = new Map<string, { keys: AccessJwk[]; fetchedAt: number }>();

/** Test hook: forget cached Access signing keys. */
export function resetAccessCertsCache(): void {
  certsCache.clear();
}

export class AccessJwtError extends Error {}

/** `https://team.cloudflareaccess.com/` → `team.cloudflareaccess.com`. */
export function normalizeTeamDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccessJwtError("malformed");
  return value as Record<string, unknown>;
}

async function loadKeys(teamDomain: string, forceRefresh: boolean): Promise<AccessJwk[]> {
  const cached = certsCache.get(teamDomain);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < CERTS_TTL_MS) return cached.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessJwtError("certs_unavailable");
  const body = (await res.json()) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? (body.keys as AccessJwk[]) : [];
  certsCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * Returns the lowercase email of a valid Access JWT; throws AccessJwtError otherwise.
 * Checks RS256 signature against the team's certs, `iss`, `aud` ⊇ audience, `exp` and `nbf`.
 */
export async function verifyAccessJwt(token: string, teamDomainRaw: string, audience: string): Promise<string> {
  const teamDomain = normalizeTeamDomain(teamDomainRaw);
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessJwtError("malformed");
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    throw new AccessJwtError("malformed");
  }
  if (header.alg !== "RS256") throw new AccessJwtError("invalid_alg");
  const kid = typeof header.kid === "string" ? header.kid : undefined;

  let keys = await loadKeys(teamDomain, false);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    keys = await loadKeys(teamDomain, true);
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk || jwk.kty !== "RSA") throw new AccessJwtError("no_matching_key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(s);
  } catch {
    throw new AccessJwtError("malformed");
  }
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new AccessJwtError("signature_failed");

  if (payload.iss !== `https://${teamDomain}`) throw new AccessJwtError("iss_mismatch");
  const aud = payload.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.includes(audience)) throw new AccessJwtError("aud_mismatch");
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new AccessJwtError("expired");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now)) {
    throw new AccessJwtError("not_yet_valid");
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) throw new AccessJwtError("no_email");
  return email;
}
