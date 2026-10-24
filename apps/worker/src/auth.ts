import { createMiddleware } from "hono/factory";
import type { Env } from "./env";

const encoder = new TextEncoder();

/**
 * Constant-time comparison that does not leak length: both values are hashed to 32 bytes with SHA-256
 * and every byte is compared with an accumulated XOR.
 */
export async function tokensEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

/** Requires `Authorization: Bearer <API_TOKEN>`; fails closed with 503 when no token is configured. */
export const requireApiToken = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const expected = c.env.API_TOKEN;
  if (!expected) return c.json({ error: "auth_not_configured" }, 503);

  const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "");
  const provided = match?.[1];
  if (!provided || !(await tokensEqual(provided, expected))) {
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
