/**
 * pi-tokendance
 *
 * TokenDance provider for pi.
 *
 * - Registers a "tokendance" provider that talks to the TokenDance gateway over
 *   the OpenAI Responses protocol (`https://tokendance.space/gateway/v1`).
 * - Authenticates with TokenDance's OAuth authorization-code flow
 *   (PKCE / S256), so the gateway issues a fresh API key for this app.
 * - Falls back to the `TOKENDANCE_API_KEY` environment variable (or a manually
 *   entered API key) when OAuth is not used.
 * - Discovers the available models from the public gateway catalog and keeps
 *   only those that speak `openai:responses`.
 *
 * No custom streaming implementation is needed: the built-in
 * `openai-responses` API in pi-ai is reused as-is.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// --- TokenDance endpoints (see https://tokendance.space/docs/api-key-oauth.md) ---

const PROVIDER_ID = "tokendance";
const BASE_URL = "https://tokendance.space/gateway/v1";
const CATALOG_URL = `${BASE_URL}/models`;
const AUTHORIZE_URL = "https://tokendance.space/auth";
const EXCHANGE_URL = "https://tokendance.space/portal/api/v1/auth/keys";
const RESPONSES_PROTOCOL = "openai:responses";

const DEFAULT_APP_URL = "app://pi-tokendance";
const DEFAULT_KEY_NAME = "pi-tokendance";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

// TokenDance API keys are long-lived and have no refresh token; treat them as
// valid far into the future so pi never tries to refresh them.
const FAR_FUTURE = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;

// --- Small helpers ---------------------------------------------------------

function readEnv(name: string): string | undefined {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const value = raw?.trim();
  return value ? value : undefined;
}

/** App URL used for TokenDance attribution (`X-App-URL` / OAuth `app_url`). */
function appUrl(): string {
  return readEnv("TOKENDANCE_APP_URL") ?? DEFAULT_APP_URL;
}

/** Name shown on the TokenDance authorization page. */
function keyName(): string {
  return readEnv("TOKENDANCE_KEY_NAME") ?? DEFAULT_KEY_NAME;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE verifier (43 chars) and its S256 challenge. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * Accept either a raw authorization code or a full callback URL
 * (`<callback>?code=<code>`) and return the code.
 */
export function extractCode(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (text.includes("?")) {
    const query = text.slice(text.indexOf("?") + 1);
    const code = new URLSearchParams(query).get("code");
    if (code) return code;
    return undefined;
  }
  return text;
}

// --- OAuth (authorization code + PKCE, headless) ---------------------------

const login = async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
  const { verifier, challenge } = await generatePkce();

  const params = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: "S256",
    app_url: appUrl(),
    key_name: keyName(),
  });

  callbacks.onAuth({
    url: `${AUTHORIZE_URL}?${params.toString()}`,
    instructions:
      "Sign in to TokenDance and confirm the API key. The page then shows a one-time " +
      "code (valid for 10 minutes) — copy it and paste it back here.",
  });

  const pasted = await callbacks.onPrompt({
    message: "Paste the TokenDance authorization code:",
    placeholder: "one-time code shown on the authorization page",
  });
  const code = extractCode(pasted);
  if (!code) {
    throw new Error("TokenDance login: no authorization code provided.");
  }

  const response = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    signal: callbacks.signal,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`TokenDance login failed (${response.status}): ${body || response.statusText}`);
  }

  let key: unknown;
  try {
    key = (JSON.parse(body) as { key?: unknown }).key;
  } catch {
    // fall through to the length check below
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("TokenDance login: the authorization response did not contain an API key.");
  }

  return { refresh: "", access: key, expires: FAR_FUTURE };
};

const refreshToken = async (
  credentials: OAuthCredentials,
  _signal: AbortSignal,
): Promise<OAuthCredentials> => {
  if (typeof credentials.access === "string" && credentials.access.length > 0) {
    // TokenDance keys never expire unless the user configured an expiry; keep them.
    return { ...credentials, expires: FAR_FUTURE };
  }
  throw new Error(
    "TokenDance API keys cannot be refreshed. Run /login tokendance to authorize a new key.",
  );
};

// --- Model discovery -------------------------------------------------------

interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  supported_protocols?: string[];
}

const VISION_HINTS = ["视觉", "多模态", "图片", "图像", "视频", "vision", "multimodal"];

function supportsImage(entry: CatalogEntry): boolean {
  const haystack = `${entry.id} ${entry.name} ${entry.description ?? ""}`.toLowerCase();
  return VISION_HINTS.some((hint) => haystack.includes(hint));
}

function toModelConfig(entry: CatalogEntry): ProviderModelConfig {
  const contextWindow =
    typeof entry.context_length === "number" && entry.context_length > 0
      ? entry.context_length
      : DEFAULT_CONTEXT_WINDOW;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    reasoning: true,
    input: supportsImage(entry) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(DEFAULT_MAX_TOKENS, contextWindow),
  };
}

/**
 * Fallback list: a snapshot of the TokenDance catalog filtered to the models that
 * advertise `openai:responses`. Used before the live catalog is fetched and when
 * the network is unavailable. The `description` only feeds the vision heuristic.
 */
export const SEED_MODELS: ProviderModelConfig[] = (
  [
    { id: "kimi-k3", name: "MoonshotAI: Kimi K3", context_length: 1_048_576, description: "视觉/多模态" },
    { id: "kimi-k3.1-pro", name: "MoonshotAI: Kimi K3.1 Pro", context_length: 1_000_000 },
    { id: "mimo-v2.5", name: "Xiaomi: MiMo-V2.5", context_length: 1_048_576, description: "视觉/多模态" },
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek: DeepSeek V4.1 Flash 1017", context_length: 1_000_000 },
    { id: "mimo-v2.5-pro", name: "Xiaomi: MiMo-V2.5-Pro", context_length: 1_048_576 },
    { id: "deepseek-flash-latest", name: "DeepSeek: DeepSeek Flash Latest", context_length: 1_000_000 },
    { id: "qwen3.7-plus", name: "Qwen: Qwen3.7 Plus", context_length: 1_000_000, description: "视觉/多模态" },
    { id: "qwen3.7-max", name: "Qwen: Qwen3.7 Max", context_length: 1_000_000 },
    { id: "step-3.7-flash", name: "StepFun: Step 3.7 Flash", context_length: 256_000, description: "视觉/多模态" },
    { id: "hy4", name: "Tencent: Hy4", context_length: 1_024_000, description: "视觉/多模态" },
    { id: "seed-2.1-turbo", name: "ByteDance Seed: Seed-2.1-Turbo", context_length: 256_000, description: "视觉/多模态" },
    { id: "minimax-m3", name: "MiniMax: MiniMax M3", context_length: 1_000_000, description: "视觉/多模态" },
    { id: "seed-2.1-pro", name: "ByteDance Seed: Seed-2.1-Pro", context_length: 256_000, description: "视觉/多模态" },
    { id: "qwen3.8-max", name: "Qwen: Qwen3.8 Max", context_length: 1_000_000, description: "视觉/多模态" },
    { id: "hy3", name: "Tencent: Hy3", context_length: 256_000 },
    { id: "deepseek-v4-flash-0731", name: "DeepSeek: DeepSeek V4 Flash 0731", context_length: 1_048_576 },
    { id: "seed-2.0-code", name: "ByteDance Seed: Seed-2.0-Code", context_length: 256_000 },
    { id: "hy4-preview", name: "Tencent: Hy4 preview", context_length: 1_024_000 },
    { id: "qwen3.8-max-0902", name: "Qwen: Qwen3.8-Max-0902", context_length: 1_000_000, description: "视觉/多模态" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek: DeepSeek V4.1 Flash", context_length: 1_000_000, description: "视觉/多模态" },
    { id: "step-5-preview", name: "StepFun: Step 5 Preview", context_length: 1_000_000, description: "视觉/多模态" },
    { id: "qwen4-max", name: "Qwen: Qwen4 Max", context_length: 1_000_000, description: "视觉/多模态" },
    { id: "mimo-v2.6-ultraspeed", name: "Xiaomi: MiMo-V2.6-Pro-UltraSpeed", context_length: 1_000_000 },
    { id: "qwen3.8-flash", name: "Qwen: Qwen3.8 Flash", context_length: 1_000_000, description: "视觉/多模态" },
    { id: "deepseek-v4-pro-0813", name: "DeepSeek: DeepSeek V4 Pro 0813", context_length: 1_000_000 },
    { id: "mimo-v2.6-flash", name: "Xiaomi: MiMo-V2.6-Flash", context_length: 1_000_000 },
    { id: "mimo-v2.6-pro", name: "Xiaomi: MiMo-V2.6-Pro", context_length: 1_000_000 },
  ] satisfies CatalogEntry[]
).map(toModelConfig);

export async function fetchTokenDanceModels(signal: AbortSignal): Promise<ProviderModelConfig[]> {
  const response = await fetch(CATALOG_URL, { signal });
  if (!response.ok) {
    throw new Error(`TokenDance model catalog request failed (${response.status}).`);
  }

  const payload = (await response.json()) as { data?: unknown };
  const entries = Array.isArray(payload?.data) ? (payload.data as CatalogEntry[]) : [];

  const models = entries
    .filter(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        (entry.supported_protocols ?? []).includes(RESPONSES_PROTOCOL),
    )
    .map(toModelConfig);

  return models.length > 0 ? models : SEED_MODELS;
}

// --- Extension entry point -------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "TokenDance",
    baseUrl: BASE_URL,
    api: "openai-responses",
    apiKey: "$TOKENDANCE_API_KEY",
    headers: { "X-App-URL": appUrl() },
    models: SEED_MODELS,
    async refreshModels(context) {
      if (!context.allowNetwork) return SEED_MODELS;
      try {
        return await fetchTokenDanceModels(context.signal);
      } catch {
        return SEED_MODELS;
      }
    },
    oauth: {
      name: "TokenDance",
      login,
      refreshToken,
      getApiKey: (credentials) => credentials.access,
    },
  });
}
