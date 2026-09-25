import type { ListenerConfig } from "./config.ts";

const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE =
  "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Must match the server's orchestration protocol version. The /ws upgrade is
 * rejected with HTTP 426 when the `orchestrationProtocol` query param differs.
 */
export const ORCHESTRATION_PROTOCOL_VERSION = 2;

export class AuthError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** An auth failure that retrying cannot fix (bad/expired session, no credential to re-pair). */
export class FatalAuthError extends AuthError {}

export interface AccessToken {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly scope: string;
}

function describeFailure(status: number, body: string): string {
  const trimmed = body.trim();
  return trimmed === "" ? `HTTP ${status}` : `HTTP ${status}: ${trimmed.slice(0, 500)}`;
}

/**
 * Exchanges a one-time pairing credential for a bearer access token
 * (RFC 8693 token exchange). Omitting `scope` makes the server use the scopes
 * granted to the pairing link, which for a read-only link is `orchestration:read`.
 */
export async function exchangePairingToken(config: ListenerConfig): Promise<AccessToken> {
  if (config.credential === undefined) {
    throw new AuthError("No pairing credential to exchange.");
  }
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: config.credential,
    subject_token_type: ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    client_label: config.clientLabel,
    client_device_type: "unknown",
  });
  const response = await fetch(`${config.httpBaseUrl}oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AuthError(
      `Pairing exchange failed: ${describeFailure(response.status, text)}`,
      response.status,
    );
  }
  const parsed = JSON.parse(text) as {
    access_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new AuthError("Pairing exchange response is missing access_token.");
  }
  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : 0,
    scope: typeof parsed.scope === "string" ? parsed.scope : "",
  };
}

/** Issues a short-lived, single-use ticket accepted by the /ws upgrade. */
export async function issueWebSocketTicket(
  config: ListenerConfig,
  bearerToken: string,
): Promise<string> {
  const response = await fetch(`${config.httpBaseUrl}api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AuthError(
      `WebSocket ticket request failed: ${describeFailure(response.status, text)}`,
      response.status,
    );
  }
  const parsed = JSON.parse(text) as { ticket?: unknown };
  if (typeof parsed.ticket !== "string" || parsed.ticket === "") {
    throw new AuthError("WebSocket ticket response is missing ticket.");
  }
  return parsed.ticket;
}

/** Builds the authenticated `/ws` URL for the RPC client. */
export function buildWebSocketUrl(wsBaseUrl: string, ticket: string): string {
  const url = new URL(wsBaseUrl);
  url.pathname = "/ws";
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

/**
 * Reads the `exp` claim (epoch milliseconds) from a T3 session token.
 *
 * The token is `<base64url(claims)>.<hmac>`, so this is an unverified peek used only
 * to decide when to stop reusing a cached token. Returns `undefined` for opaque tokens.
 */
export function decodeTokenExpiry(token: string): number | undefined {
  const encodedPayload = token.split(".")[0];
  if (encodedPayload === undefined || encodedPayload === "") return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}
