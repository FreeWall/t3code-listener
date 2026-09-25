import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

import { asNumber, asRecord, nested } from "./json.ts";

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

export const ListenerRpcGroup = RpcGroup.make(SubscribeShellRpc);

export const SUBSCRIBE_SHELL_TAG = "orchestration.subscribeShell" as const;

/** Resume cursor for the shell stream: snapshot sequence or per-item event sequence. */
export function sequenceOf(item: unknown): number | undefined {
  const record = asRecord(item);
  if (record === undefined) return undefined;
  const direct = asNumber(record.sequence);
  if (direct !== undefined) return direct;
  return asNumber(nested(record, "snapshot", "snapshotSequence"));
}
