import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

import {
  AuthError,
  FatalAuthError,
  buildWebSocketUrl,
  decodeTokenExpiry,
  exchangePairingToken,
  issueWebSocketTicket,
} from "./auth.ts";
import { ConfigError, resolveConfig, usage } from "./config.ts";
import { describeItem, sequenceOf } from "./format.ts";
import { createHookRuntime, loadHooks, type HookRuntime } from "./hooks.ts";
import { ListenerRpcGroup, SUBSCRIBE_SHELL_TAG } from "./protocol.ts";
import {
  clearCachedToken,
  readCachedToken,
  writeCachedSession,
  writeCachedToken,
} from "./tokenStore.ts";

const RECONNECT_DELAY = "2 seconds";

let config: ReturnType<typeof resolveConfig>;
try {
  config = resolveConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exit(1);
  }
  throw error;
}

type BearerSource = "explicit" | "cache" | "pairing";

let bearer: string | undefined = config.bearerToken;
let bearerSource: BearerSource = config.bearerToken === undefined ? "pairing" : "explicit";

/**
 * Resolves a bearer token, preferring an explicit one, then a cached session, and
 * only falling back to exchanging the one-time pairing credential.
 */
async function acquireBearer(forcePair: boolean): Promise<string> {
  if (!forcePair) {
    if (config.bearerToken !== undefined) {
      cacheExplicitBearer();
      return config.bearerToken;
    }
    if (bearer !== undefined) return bearer;
    const cached = config.persistToken ? readCachedToken(config) : undefined;
    if (cached !== undefined) {
      bearer = cached.accessToken;
      bearerSource = "cache";
      console.log(
        `using cached session for ${config.httpBaseUrl} (expires ${new Date(
          cached.expiresAt,
        ).toISOString()})`,
      );
      return bearer;
    }
  }
  if (config.credential === undefined) {
    throw new FatalAuthError(
      `No cached session and no pairing credential. Start with --pairing-url or --token to pair ${config.httpBaseUrl}.`,
    );
  }
  const token = await exchangePairingToken(config);
  bearer = token.accessToken;
  bearerSource = "pairing";
  if (config.persistToken) writeCachedToken(config, token);
  console.log(`paired: scope="${token.scope}" expires_in=${token.expiresIn}s`);
  return bearer;
}

/**
 * Persists an explicit `--bearer` token (by its `exp` claim) so later runs need only
 * the server URL. Opaque tokens without an `exp` are left uncached.
 */
function cacheExplicitBearer(): void {
  const token = config.bearerToken;
  if (token === undefined || !config.persistToken) return;
  const expiresAt = decodeTokenExpiry(token);
  if (expiresAt === undefined) return;
  const existing = readCachedToken(config);
  if (existing !== undefined && existing.accessToken === token) return;
  writeCachedSession(config, { accessToken: token, scope: "explicit", expiresAt });
}

/** Issues a WebSocket ticket, re-pairing once if a cached session was revoked. */
async function openTicket(): Promise<string> {
  const token = await acquireBearer(false);
  try {
    return await issueWebSocketTicket(config, token);
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) {
      if (bearerSource !== "explicit" && config.credential !== undefined) {
        console.warn("cached session was rejected; re-pairing");
        if (config.persistToken) clearCachedToken(config);
        const fresh = await acquireBearer(true);
        return issueWebSocketTicket(config, fresh);
      }
      throw new FatalAuthError(
        `Session for ${config.httpBaseUrl} expired or was revoked. Re-pair with --pairing-url or --token.`,
      );
    }
    throw error;
  }
}

/**
 * Opens one authenticated WebSocket, subscribes to the shell stream, and prints
 * events until the connection or the stream ends. The caller reconnects with the
 * cursor advanced by this run.
 */
function runSubscription(cursor: Ref.Ref<number | undefined>, hooks: HookRuntime | undefined) {
  return Effect.gen(function* () {
    const ticket = yield* Effect.promise(() => openTicket());
    const socketUrl = buildWebSocketUrl(config.wsBaseUrl, ticket);
    const socket = Socket.layerWebSocket(socketUrl).pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socket),
      Layer.provide(RpcSerialization.layerJson),
    );
    const body = Effect.gen(function* () {
      const client = yield* RpcClient.make(ListenerRpcGroup);
      const afterSequence = yield* Ref.get(cursor);
      console.log(
        afterSequence === undefined
          ? "subscribed: requesting full shell snapshot"
          : `subscribed: resuming after sequence ${afterSequence}`,
      );
      yield* client[SUBSCRIBE_SHELL_TAG]({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        requestCompletionMarker: true,
      }).pipe(
        Stream.runForEach((item) =>
          Effect.gen(function* () {
            const sequence = sequenceOf(item);
            if (sequence !== undefined) {
              yield* Ref.update(cursor, (current) =>
                current === undefined ? sequence : Math.max(current, sequence),
              );
            }
            yield* Effect.sync(() => console.log(describeItem(item)));
            if (hooks !== undefined) yield* hooks.handleItem(item);
          }),
        ),
      );
    });
    yield* body.pipe(Effect.scoped, Effect.provide(protocol));
  });
}

/** A missing or expired session cannot be fixed by reconnecting. */
function findFatalAuthError(cause: Cause.Cause<unknown>): FatalAuthError | undefined {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail" && reason.error instanceof FatalAuthError) return reason.error;
    if (reason._tag === "Die" && reason.defect instanceof FatalAuthError) return reason.defect;
  }
  return undefined;
}

const program = Effect.gen(function* () {
  const cursor = yield* Ref.make<number | undefined>(undefined);
  const hookDefinitions = loadHooks(config.hooksFile);
  const hooks = hookDefinitions.length === 0 ? undefined : createHookRuntime(hookDefinitions);
  console.log(`listening: ${config.httpBaseUrl} -> ${config.wsBaseUrl}ws`);
  console.log(
    hookDefinitions.length === 0
      ? `hooks: none (${config.hooksFile})`
      : `hooks: ${hookDefinitions.length} from ${config.hooksFile}`,
  );
  if (!config.reconnect) {
    yield* runSubscription(cursor, hooks);
    return;
  }
  yield* Effect.forever(
    runSubscription(cursor, hooks).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause) || findFatalAuthError(cause) !== undefined) {
          return Effect.failCause(cause);
        }
        return Effect.sync(() =>
          console.warn(
            `disconnected (${Cause.pretty(cause).split("\n")[0]}); reconnecting in ${RECONNECT_DELAY}`,
          ),
        );
      }),
      Effect.delay(RECONNECT_DELAY),
    ),
  );
});

const main = program.pipe(
  Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void;
    const fatal = findFatalAuthError(cause);
    if (fatal !== undefined) {
      return Effect.sync(() => {
        console.error(fatal.message);
        process.exitCode = 1;
      });
    }
    return Effect.sync(() => {
      console.error(`listener failed:\n${Cause.pretty(cause)}`);
      process.exitCode = 1;
    });
  }),
);

const fiber = Effect.runFork(main);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Effect.runPromise(Fiber.interrupt(fiber)).finally(() => process.exit(0));
  });
}
