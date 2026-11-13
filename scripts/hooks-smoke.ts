import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { createHookRuntime, type ServerActions } from "../src/hooks.ts";
import { lastAssistantText } from "../src/protocol.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3ls-hooks-"));
const out = NodePath.join(dir, "events.txt");
const hooksFile = NodePath.join(dir, "hooks.json");

const command = `printf '%s|%s|%s|%s\\n' "$T3_EVENT" "$T3_INPUT_KIND" "$T3_THREAD_TITLE" "$T3_CWD" >> "${out}"`;
const subagentCommand = `printf 'subagent|%s|%s|%s|%s\\n' "$T3_EVENT" "$T3_PARENT_THREAD_ID" "$T3_THREAD_RELATIONSHIP" "$T3_CWD" >> "${out}"`;
NodeFS.writeFileSync(
  hooksFile,
  JSON.stringify(
    {
      version: 1,
      hooks: [
        { event: "input.requested", command },
        { event: "turn.completed", command, match: { subagent: false } },
        { event: "turn.completed", command: subagentCommand, match: { subagent: true } },
        { event: "turn.failed", command },
        { event: "turn.cancelled", command },
      ],
      silent: { messagePattern: "\\[silent\\]\\s*$" },
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
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t1" },
  ...overrides,
});

const subagentThread = (overrides: Record<string, unknown>) =>
  thread({
    id: "t2",
    title: "Subagent",
    creationSource: "provider",
    worktreePath: "/worktrees/t2",
    lineage: { parentThreadId: "t1", relationshipToParent: "subagent", rootThreadId: "t1" },
    ...overrides,
  });

const snapshot = {
  kind: "snapshot",
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [{ id: "p1", title: "Demo project", workspaceRoot: "/repo" }],
    threads: [thread({}), subagentThread({})],
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
  // A subagent finishing only reaches the `subagent: true` hook.
  {
    kind: "thread.updated",
    sequence: 11,
    location: "active",
    thread: subagentThread({ status: "completed" }),
  },
  // A reply ending in [silent] is marked read instead of firing turn.completed hooks.
  {
    kind: "thread.updated",
    sequence: 12,
    location: "active",
    thread: thread({ id: "t3", title: "Scheduled check" }),
  },
  {
    kind: "thread.updated",
    sequence: 13,
    location: "active",
    thread: thread({ id: "t3", title: "Scheduled check", status: "completed" }),
  },
];

const runtime = createHookRuntime(hooksFile);
const markedRead: Array<string> = [];
const replies: Record<string, string> = {
  t1: "Fixed it. [silent] would only count at the end.",
  t3: "Nothing new found.\n\n[silent]\n",
};
const server: ServerActions = {
  lastAssistantMessage: (threadId) => Effect.succeed(replies[threadId]),
  markRead: (threadId) => Effect.sync(() => void markedRead.push(threadId)),
};

const program = Effect.gen(function* () {
  for (const item of items) {
    yield* runtime.handleItem(item, server);
  }
  // Hooks are detached so the stream is never blocked; give them a moment to land.
  yield* Effect.sleep("1 second");
});

await Effect.runPromise(program);

const lines = NodeFS.readFileSync(out, "utf8").trim().split("\n");
const expected = [
  "input.requested|user_input|Demo thread|/repo",
  "turn.completed||Demo thread|/repo",
  "turn.failed||Demo thread|/repo",
  "turn.cancelled||Demo thread|/repo",
  "subagent|turn.completed|t1|subagent|/worktrees/t2",
];

console.log(lines.join("\n"));
if (JSON.stringify(lines) !== JSON.stringify(expected)) {
  console.error("HOOKS_SMOKE_FAIL");
  console.error("expected:", JSON.stringify(expected));
  process.exit(1);
}
if (JSON.stringify(markedRead) !== JSON.stringify(["t3"])) {
  console.error("HOOKS_SMOKE_FAIL");
  console.error("marked read:", JSON.stringify(markedRead), "expected: [\"t3\"]");
  process.exit(1);
}
const projection = {
  messages: [
    { role: "assistant", streaming: false, createdAt: "2026-11-13T10:00:02.000Z", text: "latest" },
    { role: "assistant", streaming: false, createdAt: "2026-11-13T10:00:01.000Z", text: "older" },
    { role: "user", streaming: false, createdAt: "2026-11-13T10:00:03.000Z", text: "user" },
    { role: "assistant", streaming: true, createdAt: "2026-11-13T10:00:04.000Z", text: "partial" },
  ],
};
if (lastAssistantText(projection) !== "latest") {
  console.error("HOOKS_SMOKE_FAIL");
  console.error("lastAssistantText:", lastAssistantText(projection), "expected: latest");
  process.exit(1);
}
console.log("HOOKS_SMOKE_OK");
