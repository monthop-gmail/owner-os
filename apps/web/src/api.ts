// Minimal API client. The token is typed in by the user and only kept in this browser's localStorage;
// it is never part of the bundle or of Vite env variables.

const TOKEN_KEY = "owner-os.token";
export const UNAUTHORIZED_EVENT = "owner-os:unauthorized";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable (private mode): the session just won't be remembered
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`API ${status}${code ? ` ${code}` : ""}`);
  }
}

/**
 * GET a JSON endpoint with the stored bearer token (or `token` when validating a new one).
 * On 401 the stored token is cleared and UNAUTHORIZED_EVENT is dispatched so the UI returns to the token screen.
 */
export async function apiGet<T>(path: string, token: string | null = getToken()): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, { headers });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    let code: string | undefined;
    try {
      code = ((await res.json()) as { error?: string }).error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}
