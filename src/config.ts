import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export interface ListenerConfig {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  /** One-time pairing credential exchanged at /oauth/token. */
  readonly credential: string | undefined;
  /** Already-issued bearer access token; skips the pairing exchange. */
  readonly bearerToken: string | undefined;
  readonly clientLabel: string;
  readonly reconnect: boolean;
  /** Cache the exchanged bearer token so restarts do not need a new pairing link. */
  readonly persistToken: boolean;
  readonly tokenFile: string;
  /** External hook definitions; see src/hooks.ts. */
  readonly hooksFile: string;
}

export class ConfigError extends Error {}

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function configDir(): string {
  return NodePath.join(
    process.env.XDG_CONFIG_HOME ?? NodePath.join(NodeOS.homedir(), ".config"),
    "t3code-listener",
  );
}

/** Default token cache path: $XDG_CONFIG_HOME/t3code-listener/sessions.json. */
function defaultTokenFile(): string {
  return NodePath.join(configDir(), "sessions.json");
}

/** Default hooks path: $XDG_CONFIG_HOME/t3code-listener/hooks.json. */
function defaultHooksFile(): string {
  return NodePath.join(configDir(), "hooks.json");
}

function parseArgs(argv: ReadonlyArray<string>) {
  return NodeUtil.parseArgs({
    args: [...argv],
    options: {
      url: { type: "string" },
      "pairing-url": { type: "string" },
      token: { type: "string" },
      bearer: { type: "string" },
      "bearer-file": { type: "string" },
      label: { type: "string" },
      "token-file": { type: "string" },
      "hooks-file": { type: "string" },
      "no-persist": { type: "boolean", default: false },
      "no-reconnect": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
}

function normalizeBaseUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new ConfigError("A server URL is required.");
  }
  const withScheme = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConfigError(`Invalid server URL: ${raw}`);
  }
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new ConfigError(`Unsupported server URL protocol: ${url.protocol}`);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function toHttpBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") next.protocol = "http:";
  if (next.protocol === "wss:") next.protocol = "https:";
  return next.toString();
}

function toWsBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "http:") next.protocol = "ws:";
  if (next.protocol === "https:") next.protocol = "wss:";
  return next.toString();
}

function readHashParam(url: URL, key: string): string | undefined {
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const value = new URLSearchParams(hash).get(key)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function usage(): string {
  return [
    "t3code-listener - subscribe to T3 Code orchestration shell events",
    "",
    "Usage:",
    "  node src/index.ts --pairing-url <url> [options]",
    "  node src/index.ts --url <base> --token <pairing-token> [options]",
    "  node src/index.ts --url <base> --bearer <access-token> [options]",
    "",
    "Options:",
    "  --pairing-url <url>  Read-only pairing link (token in query or #hash).",
    "  --url <base>         T3 server base URL, e.g. http://localhost:3000",
    "  --token <token>      One-time pairing token (exchanged for a bearer).",
    "  --bearer <token>     Existing bearer access token (cached for later runs).",
    "  --bearer-file <path> Read the bearer token from a file.",
    "  --label <label>      Client label reported to the server.",
    "  --token-file <path>  Bearer token cache path.",
    "  --hooks-file <path>  External hook definitions (default ~/.config/t3code-listener/hooks.json).",
    "  --no-persist         Do not read or write the bearer token cache.",
    "  --no-reconnect       Exit on the first disconnect instead of retrying.",
    "  --help               Show this help.",
    "",
    "The exchanged bearer session lasts ~30 days and is cached, so the one-time",
    "pairing link (~5 min, single use) is only needed roughly once a month. A bearer",
    "issued with `t3 auth session issue --ttl 365d` is cached by its own expiry.",
    "",
    "Environment fallbacks: T3_PAIRING_URL, T3_URL, T3_PAIRING_TOKEN, T3_BEARER,",
    "T3_BEARER_FILE, T3_CLIENT_LABEL, T3_TOKEN_FILE, T3_HOOKS_FILE.",
  ].join("\n");
}

export function resolveConfig(argv: ReadonlyArray<string> = process.argv.slice(2)): ListenerConfig {
  const { values } = parseArgs(argv);
  if (values.help) {
    console.log(usage());
    process.exit(0);
  }

  const pairingUrl = values["pairing-url"] ?? process.env.T3_PAIRING_URL;
  const explicitUrl = values.url ?? process.env.T3_URL;
  const token = values.token ?? process.env.T3_PAIRING_TOKEN;
  const bearerFile = values["bearer-file"] ?? process.env.T3_BEARER_FILE;
  let bearer = values.bearer ?? process.env.T3_BEARER;
  if ((bearer === undefined || bearer === "") && bearerFile !== undefined && bearerFile !== "") {
    try {
      bearer = NodeFS.readFileSync(bearerFile, "utf8").trim();
    } catch (error) {
      throw new ConfigError(`Could not read bearer file ${bearerFile}: ${String(error)}`);
    }
  }
  const label = values.label ?? process.env.T3_CLIENT_LABEL ?? "t3code-listener";

  let baseUrlRaw: string | undefined = explicitUrl;
  let credential: string | undefined = token;

  if (pairingUrl !== undefined && pairingUrl.trim() !== "") {
    let parsed: URL;
    try {
      parsed = new URL(pairingUrl);
    } catch {
      throw new ConfigError(`Invalid pairing URL: ${pairingUrl}`);
    }
    const hostedHost = parsed.searchParams.get("host")?.trim();
    if (hostedHost !== undefined && hostedHost !== "") {
      baseUrlRaw = hostedHost;
    } else if (baseUrlRaw === undefined) {
      baseUrlRaw = parsed.toString();
    }
    const pairingToken = readHashParam(parsed, "token") ?? parsed.searchParams.get("token")?.trim();
    if (pairingToken !== undefined && pairingToken !== "") {
      credential = pairingToken;
    }
  }

  if (baseUrlRaw === undefined || baseUrlRaw.trim() === "") {
    throw new ConfigError(
      "No server URL. Pass --pairing-url, --url, or set T3_URL / T3_PAIRING_URL.",
    );
  }

  const base = normalizeBaseUrl(baseUrlRaw);
  return {
    httpBaseUrl: toHttpBaseUrl(base),
    wsBaseUrl: toWsBaseUrl(base),
    credential: credential === "" ? undefined : credential,
    bearerToken: bearer === "" ? undefined : bearer,
    clientLabel: label,
    reconnect: values["no-reconnect"] !== true,
    persistToken: values["no-persist"] !== true,
    tokenFile: values["token-file"] ?? process.env.T3_TOKEN_FILE ?? defaultTokenFile(),
    hooksFile: values["hooks-file"] ?? process.env.T3_HOOKS_FILE ?? defaultHooksFile(),
  };
}
