import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { createHookRuntime } from "../src/hooks.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3ls-hooks-"));
const out = NodePath.join(dir, "events.txt");
const hooksFile = NodePath.join(dir, "hooks.json");

const command = `printf '%s|%s|%s\\n' "$T3_EVENT" "$T3_INPUT_KIND" "$T3_THREAD_TITLE" >> "${out}"`;
NodeFS.writeFileSync(
  hooksFile,
  JSON.stringify(
    {
      version: 1,
      hooks: [
        { event: "input.requested", command },
        { event: "turn.completed", command },
        { event: "turn.failed", command },
        { event: "turn.cancelled", command },
      ],
    },
    null,
    2,
  ),
);

const thread = (overrides: Record<string, unknown>) => ({
  id: "t1",
  projectId: "p1",
  title: "Demo thread",
  status: "running",
  settledAt: null,
  hasActionableProposedPlan: false,
  pendingRuntimeRequest: null,
  ...overrides,
});

const snapshot = {
  kind: "snapshot",
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [{ id: "p1", title: "Demo project" }],
    threads: [thread({})],
    archivedThreads: [],
  },
};

const items = [
  snapshot,
  { kind: "thread.updated", sequence: 2, location: "active", thread: thread({}) },
  {
    kind: "thread.updated",
    sequence: 3,
    location: "active",
    thread: thread({ status: "waiting", pendingRuntimeRequest: { id: "req1", kind: "user_input" } }),
  },
  {
    kind: "thread.updated",
    sequence: 4,
    location: "active",
    thread: thread({ status: "waiting", pendingRuntimeRequest: { id: "req1", kind: "user_input" } }),
  },
  // Settled while no run is completed must not fire turn.completed.
  {
    kind: "thread.updated",
    sequence: 5,
    location: "active",
    thread: thread({ status: "idle", settledAt: "2026-09-25T09:59:00.000Z" }),
  },
  // The agent finishing generation is what fires turn.completed.
  { kind: "thread.updated", sequence: 6, location: "active", thread: thread({ status: "completed" }) },
  { kind: "thread.updated", sequence: 7, location: "active", thread: thread({ status: "failed" }) },
  { kind: "thread.updated", sequence: 8, location: "active", thread: thread({ status: "interrupted" }) },
  // Another cancelled-category status is still the same terminal event.
  { kind: "thread.updated", sequence: 9, location: "active", thread: thread({ status: "cancelled" }) },
  // Repeating a terminal status must not re-fire.
  { kind: "thread.updated", sequence: 10, location: "active", thread: thread({ status: "cancelled" }) },
];

const runtime = createHookRuntime(hooksFile);

const program = Effect.gen(function* () {
  for (const item of items) {
    yield* runtime.handleItem(item);
  }
  // Hooks are detached so the stream is never blocked; give them a moment to land.
  yield* Effect.sleep("1 second");
});

await Effect.runPromise(program);

const lines = NodeFS.readFileSync(out, "utf8").trim().split("\n");
const expected = [
  "input.requested|user_input|Demo thread",
  "turn.completed||Demo thread",
  "turn.failed||Demo thread",
  "turn.cancelled||Demo thread",
];

console.log(lines.join("\n"));
if (JSON.stringify(lines) !== JSON.stringify(expected)) {
  console.error("HOOKS_SMOKE_FAIL");
  console.error("expected:", JSON.stringify(expected));
  process.exit(1);
}
console.log("HOOKS_SMOKE_OK");
