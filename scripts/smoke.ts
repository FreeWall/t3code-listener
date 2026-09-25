import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";

import { ListenerRpcGroup, SUBSCRIBE_SHELL_TAG, sequenceOf } from "../src/protocol.ts";

const snapshot = {
  kind: "snapshot",
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: 10,
    projects: [{ id: "proj-1", title: "Demo" }],
    threads: [
      {
        id: "thread-1",
        projectId: "proj-1",
        title: "Fix the thing",
        status: "running",
        hasActionableProposedPlan: false,
        pendingRuntimeRequest: null,
        settledAt: null,
      },
    ],
    archivedThreads: [],
  },
};

const threadUpdate = {
  kind: "thread.updated",
  sequence: 11,
  location: "active",
  thread: {
    id: "thread-1",
    projectId: "proj-1",
    title: "Fix the thing",
    status: "waiting",
    hasActionableProposedPlan: false,
    pendingRuntimeRequest: { kind: "user_input", status: "pending" },
    settledAt: null,
  },
};

const handlers = ListenerRpcGroup.toLayer({
  [SUBSCRIBE_SHELL_TAG]: () => Stream.make(snapshot, threadUpdate, { kind: "synchronized" }),
});

const program = Effect.gen(function* () {
  const client = yield* RpcTest.makeClient(ListenerRpcGroup);
  const cursor = yield* Ref.make<number | undefined>(undefined);
  const seen = yield* Ref.make(0);
  yield* client[SUBSCRIBE_SHELL_TAG]({ requestCompletionMarker: true }).pipe(
    Stream.runForEach((item) =>
      Effect.gen(function* () {
        const sequence = sequenceOf(item);
        if (sequence !== undefined) {
          yield* Ref.update(cursor, (current) =>
            current === undefined ? sequence : Math.max(current, sequence),
          );
        }
        yield* Ref.update(seen, (count) => count + 1);
      }),
    ),
  );
  const finalCursor = yield* Ref.get(cursor);
  if (finalCursor !== 11) throw new Error(`expected cursor 11, got ${finalCursor}`);
  if ((yield* Ref.get(seen)) !== 3) throw new Error("expected 3 items");
  console.log("SMOKE_OK");
});

Effect.runPromise(program.pipe(Effect.provide(handlers), Effect.scoped)).catch((error) => {
  console.error("SMOKE_FAIL", error);
  process.exit(1);
});
