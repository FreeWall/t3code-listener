import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

import { asNumber, asRecord, asString, nested } from "./json.ts";

/**
 * Mirrors the server's `orchestration.subscribeShell` method. Only the tag and the
 * payload shape have to match the wire; `success` is intentionally permissive so
 * this listener keeps working as the server adds shell fields.
 */
const SubscribeShellRpc = Rpc.make("orchestration.subscribeShell", {
  payload: Schema.Struct({
    afterSequence: Schema.optional(Schema.Number),
    requestCompletionMarker: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Unknown,
  error: Schema.Unknown,
  stream: true,
});

/**
 * Mirrors `orchestration.dispatchCommand`, narrowed to `thread.visit`: the command the
 * app sends to move a thread's read watermark. Needs the `orchestration:operate` scope.
 */
const DispatchCommandRpc = Rpc.make("orchestration.dispatchCommand", {
  payload: Schema.Struct({
    type: Schema.Literal("thread.visit"),
    commandId: Schema.String,
    threadId: Schema.String,
    visitedAt: Schema.String,
  }),
  success: Schema.Unknown,
  error: Schema.Unknown,
});

/** Mirrors `orchestration.getThreadProjection`: one thread's full state, messages included. */
const GetThreadProjectionRpc = Rpc.make("orchestration.getThreadProjection", {
  payload: Schema.Struct({ threadId: Schema.String }),
  success: Schema.Unknown,
  error: Schema.Unknown,
});

export const ListenerRpcGroup = RpcGroup.make(
  SubscribeShellRpc,
  DispatchCommandRpc,
  GetThreadProjectionRpc,
);

export const SUBSCRIBE_SHELL_TAG = "orchestration.subscribeShell" as const;
export const DISPATCH_COMMAND_TAG = "orchestration.dispatchCommand" as const;
export const GET_THREAD_PROJECTION_TAG = "orchestration.getThreadProjection" as const;

/** Text of the newest finished assistant message in a thread projection. */
export function lastAssistantText(projection: unknown): string | undefined {
  const messages = nested(projection, "messages");
  if (!Array.isArray(messages)) return undefined;
  let latest: { createdAt: string; text: string } | undefined;
  for (const message of messages) {
    if (nested(message, "role") !== "assistant" || nested(message, "streaming") === true) continue;
    const text = asString(nested(message, "text"));
    const createdAt = asString(nested(message, "createdAt")) ?? "";
    if (text !== undefined && (latest === undefined || createdAt >= latest.createdAt)) {
      latest = { createdAt, text };
    }
  }
  return latest?.text;
}

/** Resume cursor for the shell stream: snapshot sequence or per-item event sequence. */
export function sequenceOf(item: unknown): number | undefined {
  const record = asRecord(item);
  if (record === undefined) return undefined;
  const direct = asNumber(record.sequence);
  if (direct !== undefined) return direct;
  return asNumber(nested(record, "snapshot", "snapshotSequence"));
}
