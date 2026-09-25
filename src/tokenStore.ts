import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { AccessToken } from "./auth.ts";
import type { ListenerConfig } from "./config.ts";

export interface StoredSession {
  readonly accessToken: string;
  readonly scope: string;
  readonly expiresAt: number;
}

interface StoreFile {
  readonly version: 1;
  readonly sessions: Record<string, StoredSession>;
}

/** Refresh the bearer a minute before it actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

function readStore(file: string): StoreFile {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Partial<StoreFile>;
    if (parsed.version === 1 && parsed.sessions !== null && typeof parsed.sessions === "object") {
      return { version: 1, sessions: parsed.sessions };
    }
  } catch {
    // Missing, unreadable, or malformed cache is treated as empty.
  }
  return { version: 1, sessions: {} };
}

function writeStore(file: string, store: StoreFile): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temp, file);
}

/** Returns a cached, unexpired session for this server, if one exists. */
export function readCachedToken(config: ListenerConfig): StoredSession | undefined {
  const session = readStore(config.tokenFile).sessions[config.httpBaseUrl];
  if (session === undefined) return undefined;
  if (typeof session.accessToken !== "string" || session.accessToken === "") return undefined;
  if (typeof session.expiresAt !== "number" || session.expiresAt - Date.now() <= EXPIRY_MARGIN_MS) {
    return undefined;
  }
  return session;
}

export function writeCachedToken(config: ListenerConfig, token: AccessToken): void {
  if (token.expiresIn <= 0) return;
  writeCachedSession(config, {
    accessToken: token.accessToken,
    scope: token.scope,
    expiresAt: Date.now() + token.expiresIn * 1000,
  });
}

export function writeCachedSession(config: ListenerConfig, session: StoredSession): void {
  const store = readStore(config.tokenFile);
  store.sessions[config.httpBaseUrl] = session;
  try {
    writeStore(config.tokenFile, store);
  } catch (error) {
    console.warn(`could not write token cache at ${config.tokenFile}: ${String(error)}`);
  }
}

export function clearCachedToken(config: ListenerConfig): void {
  const store = readStore(config.tokenFile);
  if (store.sessions[config.httpBaseUrl] === undefined) return;
  delete store.sessions[config.httpBaseUrl];
  try {
    writeStore(config.tokenFile, store);
  } catch {
    // Best effort; a stale entry is re-exchanged anyway.
  }
}
