import { asBoolean, asNumber, asRecord, asString, nested, type JsonRecord } from "./json.ts";

export function shortId(value: unknown): string {
  const text = asString(value);
  return text === undefined ? "?" : text.slice(0, 8);
}

/** Resume cursor for the shell stream: snapshot sequence or per-item event sequence. */
export function sequenceOf(item: unknown): number | undefined {
  const record = asRecord(item);
  if (record === undefined) return undefined;
  const direct = asNumber(record.sequence);
  if (direct !== undefined) return direct;
  return asNumber(nested(record, "snapshot", "snapshotSequence"));
}

/** Renders the status flags the notification-style consumers care about. */
export function threadFlags(thread: JsonRecord): string {
  const flags: string[] = [];
  if (asBoolean(thread.hasActionableProposedPlan) === true) flags.push("plan-review");
  const pendingKind = asString(nested(thread, "pendingRuntimeRequest", "kind"));
  if (pendingKind !== undefined) flags.push(`pending:${pendingKind}`);
  const status = asString(thread.status);
  if (status !== undefined && status !== "idle" && status !== "completed") flags.push(status);
  if (thread.settledAt !== null && thread.settledAt !== undefined) flags.push("settled");
  const error = asString(thread.lastError);
  if (error !== undefined) flags.push(`error:${error.slice(0, 60)}`);
  return flags.length === 0 ? "-" : flags.join(", ");
}

export function summarizeThread(value: unknown): string {
  const thread = asRecord(value);
  if (thread === undefined) return "(unknown thread)";
  const id = asString(thread.id) ?? "?";
  const title = asString(thread.title) ?? "(untitled)";
  return `${shortId(id)} "${title}" [${threadFlags(thread)}]`;
}

export function describeItem(item: unknown): string {
  const record = asRecord(item);
  const kind = asString(record?.kind) ?? "(unknown)";
  switch (kind) {
    case "synchronized":
      return "== synchronized (initial snapshot complete) ==";
    case "snapshot": {
      const threads = nested(record, "snapshot", "threads");
      const projects = nested(record, "snapshot", "projects");
      const archived = nested(record, "snapshot", "archivedThreads");
      const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
      return `snapshot seq=${sequenceOf(item) ?? "?"} projects=${count(projects)} threads=${count(
        threads,
      )} archived=${count(archived)}`;
    }
    case "project.updated":
      return `project.updated ${shortId(asString(nested(record, "project", "id")) ?? "?")} "${
        asString(nested(record, "project", "title")) ?? ""
      }"`;
    case "project.removed":
      return `project.removed ${shortId(asString(record?.projectId) ?? "?")}`;
    case "thread.updated":
      return `thread.updated [${asString(record?.location) ?? "?"}] ${summarizeThread(
        record?.thread,
      )}`;
    case "thread.removed":
      return `thread.removed [${asString(record?.location) ?? "?"}] ${shortId(
        asString(record?.threadId) ?? "?",
      )}`;
    default:
      return `${kind} ${JSON.stringify(item).slice(0, 400)}`;
  }
}
