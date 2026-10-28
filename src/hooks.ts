import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { asBoolean, asNumber, asRecord, asString, nested } from "./json.ts";

/**
 * Events this listener can raise. They are edge-triggered from `thread.updated`
 * transitions; the initial snapshot only seeds state and never fires hooks.
 *
 * `turn.completed` fires when the thread's latest run reaches `completed`, i.e. the
 * agent finished generating. It is not thread settlement (`settledAt`), which can lag
 * behind generation while background work drains. `turn.failed` and `turn.cancelled`
 * cover the other terminal run statuses.
 */
const HOOK_EVENTS = [
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "input.requested",
] as const;
type HookEventName = (typeof HOOK_EVENTS)[number];

/** Terminal run statuses that are not success or failure. */
const CANCELLED_STATUSES: ReadonlySet<string> = new Set([
  "interrupted",
  "cancelled",
  "rolled_back",
]);

const HookMatchSchema = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  /** Matches `input.requested` kinds, e.g. `user_input`, `permission`, `plan_review`. */
  kind: Schema.optional(Schema.String),
  /** Matches the thread's run status. */
  status: Schema.optional(Schema.String),
  /** JavaScript regular expression tested against the thread title. */
  titlePattern: Schema.optional(Schema.String),
  /** `true` fires only for subagent threads, `false` only for non-subagent threads. */
  subagent: Schema.optional(Schema.Boolean),
});

const HookDefinitionSchema = Schema.Struct({
  event: Schema.Literals([...HOOK_EVENTS, "*"]),
  command: Schema.NonEmptyString,
  match: Schema.optional(HookMatchSchema),
  timeoutMs: Schema.optional(Schema.Number),
});
type HookDefinition = Schema.Schema.Type<typeof HookDefinitionSchema>;

const HookConfigSchema = Schema.Struct({
  version: Schema.optional(Schema.Literal(1)),
  hooks: Schema.Array(HookDefinitionSchema),
});

interface ThreadState {
  readonly status: string;
  readonly settledAt: string | null;
  readonly pendingRequestId: string | null;
  readonly pendingKind: string | null;
  readonly actionablePlan: boolean;
}

interface HookPayload {
  readonly event: HookEventName;
  readonly sequence: number | undefined;
  readonly timestamp: string;
  readonly location: string;
  readonly project: { readonly id: string; readonly title: string } | undefined;
  readonly thread: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly settledAt: string | null;
    readonly parentThreadId: string | null;
    /** `lineage.relationshipToParent`: `subagent`, `fork`, or null for a top-level thread. */
    readonly relationship: string | null;
  };
  readonly input?: { readonly kind: string; readonly requestId: string | null };
}

/** Reads and validates the hooks file. Missing file means no hooks; invalid content is reported once. */
function loadHooks(file: string): ReadonlyArray<HookDefinition> {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`could not read hooks file ${file}: ${String(error)}`);
    }
    return [];
  }
  try {
    return Schema.decodeUnknownSync(HookConfigSchema)(JSON.parse(text)).hooks;
  } catch (error) {
    console.warn(`invalid hooks file ${file}: ${String(error)}`);
    return [];
  }
}

function threadState(thread: unknown): ThreadState {
  const pending = asRecord(nested(thread, "pendingRuntimeRequest"));
  return {
    status: asString(nested(thread, "status")) ?? "unknown",
    settledAt: asString(nested(thread, "settledAt")) ?? null,
    pendingRequestId: asString(pending?.id) ?? null,
    pendingKind: asString(pending?.kind) ?? null,
    actionablePlan: asBoolean(nested(thread, "hasActionableProposedPlan")) === true,
  };
}

interface DetectionContext {
  readonly sequence: number | undefined;
  readonly location: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly parentThreadId: string | null;
  readonly relationship: string | null;
  readonly project: { readonly id: string; readonly title: string } | undefined;
}

/** Computes hook events from a thread's previous and current shell state. */
function detectHookEvents(
  previous: ThreadState | undefined,
  current: ThreadState,
  context: DetectionContext,
): ReadonlyArray<HookPayload> {
  const events: Array<HookPayload> = [];
  const common = {
    sequence: context.sequence,
    timestamp: new Date().toISOString(),
    location: context.location,
    project: context.project,
    thread: {
      id: context.threadId,
      title: context.threadTitle,
      status: current.status,
      settledAt: current.settledAt,
      parentThreadId: context.parentThreadId,
      relationship: context.relationship,
    },
  } satisfies Omit<HookPayload, "event">;

  const requestAppeared =
    current.pendingRequestId !== null &&
    current.pendingRequestId !== previous?.pendingRequestId;
  if (requestAppeared) {
    events.push({
      ...common,
      event: "input.requested",
      input: { kind: current.pendingKind ?? "request", requestId: current.pendingRequestId },
    });
  }
  if (current.actionablePlan && previous?.actionablePlan !== true) {
    events.push({
      ...common,
      event: "input.requested",
      input: { kind: "plan_review", requestId: null },
    });
  }
  // The shell status is the latest run's status, so `completed` means the agent
  // finished generating. `settledAt` is thread settlement, which can lag behind
  // generation while background work drains.
  if (current.status === "completed" && previous?.status !== "completed") {
    events.push({ ...common, event: "turn.completed" });
  }
  if (current.status === "failed" && previous?.status !== "failed") {
    events.push({ ...common, event: "turn.failed" });
  }
  if (
    CANCELLED_STATUSES.has(current.status) &&
    !CANCELLED_STATUSES.has(previous?.status ?? "")
  ) {
    events.push({ ...common, event: "turn.cancelled" });
  }
  return events;
}

function matchesHook(hook: HookDefinition, payload: HookPayload): boolean {
  if (hook.event !== "*" && hook.event !== payload.event) return false;
  const match = hook.match;
  if (match === undefined) return true;
  if (match.projectId !== undefined && match.projectId !== (payload.project?.id ?? "")) return false;
  if (match.threadId !== undefined && match.threadId !== payload.thread.id) return false;
  if (match.kind !== undefined && match.kind !== (payload.input?.kind ?? "")) return false;
  if (match.status !== undefined && match.status !== payload.thread.status) return false;
  if (
    match.subagent !== undefined &&
    match.subagent !== (payload.thread.relationship === "subagent")
  ) {
    return false;
  }
  if (match.titlePattern !== undefined) {
    try {
      if (!new RegExp(match.titlePattern).test(payload.thread.title)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Runs one hook command with the payload on stdin and `T3_*` variables in the
 * environment. Commands run detached from the stream so a slow hook cannot stall it.
 */
function runHook(hook: HookDefinition, payload: HookPayload): Promise<void> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    T3_EVENT: payload.event,
    T3_THREAD_ID: payload.thread.id,
    T3_THREAD_TITLE: payload.thread.title,
    T3_PARENT_THREAD_ID: payload.thread.parentThreadId ?? "",
    T3_THREAD_RELATIONSHIP: payload.thread.relationship ?? "",
    T3_PROJECT_ID: payload.project?.id ?? "",
    T3_PROJECT_TITLE: payload.project?.title ?? "",
    T3_STATUS: payload.thread.status,
    T3_INPUT_KIND: payload.input?.kind ?? "",
    T3_SEQUENCE: payload.sequence === undefined ? "" : String(payload.sequence),
    T3_TIMESTAMP: payload.timestamp,
  };
  return new Promise((resolve) => {
    const child = spawn(hook.command, { shell: true, env, stdio: ["pipe", "inherit", "inherit"] });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      console.warn(`hook ${payload.event} timed out after ${timeoutMs}ms: ${hook.command}`);
      child.kill("SIGTERM");
      finish();
    }, timeoutMs);
    child.on("error", (error) => {
      console.warn(`hook ${payload.event} failed to start: ${String(error)}`);
      finish();
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`hook ${payload.event} exited ${code}: ${hook.command}`);
      }
      finish();
    });
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

export interface HookRuntime {
  /** Updates tracked state for one shell stream item and dispatches matching hooks. */
  handleItem(item: unknown): Effect.Effect<void>;
}

/**
 * Loads hooks and returns a runtime that tracks per-thread shell state, so hooks fire
 * on transitions rather than on every update. A snapshot seeds state without firing,
 * which keeps reconnects quiet.
 */
export function createHookRuntime(file: string): HookRuntime {
  const hooks = loadHooks(file);
  const threadStates = new Map<string, ThreadState>();
  const projects = new Map<string, { readonly id: string; readonly title: string }>();

  return {
    handleItem: (item) =>
      Effect.gen(function* () {
        if (hooks.length === 0) return;
        const record = asRecord(item);
        const kind = asString(record?.kind);

        if (kind === "snapshot") {
          seedSnapshot(asRecord(record?.snapshot), threadStates, projects);
          return;
        }
        if (kind === "project.updated") {
          const project = asRecord(record?.project);
          const id = asString(project?.id);
          if (id !== undefined) projects.set(id, { id, title: asString(project?.title) ?? "" });
          return;
        }
        if (kind === "project.removed") {
          const id = asString(record?.projectId);
          if (id !== undefined) projects.delete(id);
          return;
        }
        if (kind === "thread.removed") {
          const id = asString(record?.threadId);
          if (id !== undefined) threadStates.delete(id);
          return;
        }
        if (kind !== "thread.updated") return;

        const thread = asRecord(record?.thread);
        const threadId = asString(thread?.id);
        if (threadId === undefined) return;
        const previous = threadStates.get(threadId);
        const current = threadState(thread);
        threadStates.set(threadId, current);

        const projectId = asString(thread?.projectId);
        const payloads = detectHookEvents(previous, current, {
          sequence: asNumber(record?.sequence),
          location: asString(record?.location) ?? "active",
          threadId,
          threadTitle: asString(thread?.title) ?? "",
          parentThreadId: asString(nested(thread, "lineage", "parentThreadId")) ?? null,
          relationship: asString(nested(thread, "lineage", "relationshipToParent")) ?? null,
          project:
            projectId === undefined
              ? undefined
              : (projects.get(projectId) ?? { id: projectId, title: "" }),
        });

        for (const payload of payloads) {
          for (const hook of hooks) {
            if (!matchesHook(hook, payload)) continue;
            yield* Effect.forkDetach(Effect.promise(() => runHook(hook, payload)));
          }
        }
      }),
  };
}

function seedSnapshot(
  snapshot: Record<string, unknown> | undefined,
  threadStates: Map<string, ThreadState>,
  projects: Map<string, { readonly id: string; readonly title: string }>,
): void {
  for (const list of [snapshot?.threads, snapshot?.archivedThreads]) {
    if (!Array.isArray(list)) continue;
    for (const thread of list) {
      const id = asString(nested(thread, "id"));
      if (id !== undefined) threadStates.set(id, threadState(thread));
    }
  }
  if (!Array.isArray(snapshot?.projects)) return;
  for (const project of snapshot.projects) {
    const id = asString(nested(project, "id"));
    if (id !== undefined) projects.set(id, { id, title: asString(nested(project, "title")) ?? "" });
  }
}
