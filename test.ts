/**
 * Tests for pi-tokendance.
 *
 * Run with a TypeScript-capable Node (>= 22.6) or Bun:
 *
 *   node test.ts        # Node 24 strips types natively
 *   bun run test.ts
 *
 * The live-catalog checks need network access and are informational by default:
 * set TD_REQUIRE_NETWORK=1 to make them fail the run.
 */

import mod, { extractCode, fetchTokenDanceModels, generatePkce, SEED_MODELS } from "./index.ts";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

const requireNetwork = process.env.TD_REQUIRE_NETWORK === "1";

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else if (requireNetwork) {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  warn ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`} (network check; set TD_REQUIRE_NETWORK=1 to enforce)`);
  }
}

// --- registration shape ----------------------------------------------------

console.log("provider registration");
let captured: { id: string; config: ProviderConfig } | undefined;
const fakePi = {
  registerProvider: (id: string, config: ProviderConfig) => {
    captured = { id, config };
  },
} as unknown as ExtensionAPI;
mod(fakePi);

check("provider id is tokendance", captured?.id === "tokendance");
check("base url", captured?.config.baseUrl === "https://tokendance.space/gateway/v1", captured?.config.baseUrl);
check("default protocol is openai-responses", captured?.config.api === "openai-responses", captured?.config.api);
check("env api key fallback", captured?.config.apiKey === "$TOKENDANCE_API_KEY");
check("X-App-URL attribution header", typeof captured?.config.headers?.["X-App-URL"] === "string");
check("no custom streamSimple", captured?.config.streamSimple === undefined);
check("oauth getApiKey returns the access field",
  captured?.config.oauth?.getApiKey({ refresh: "", access: "abc", expires: 0 }) === "abc");
check(`seed models present (${SEED_MODELS.length})`, SEED_MODELS.length > 0);

// --- PKCE ------------------------------------------------------------------

console.log("pkce");
const first = await generatePkce();
const second = await generatePkce();

check("verifier is 43-128 chars", first.verifier.length >= 43 && first.verifier.length <= 128, first.verifier.length);
check("verifier charset", /^[A-Za-z0-9\-._~]+$/.test(first.verifier));
check("verifier is random per call", first.verifier !== second.verifier);
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(first.verifier));
const expectedChallenge = Buffer.from(digest).toString("base64url");
check("challenge is S256(verifier)", expectedChallenge === first.challenge);

// --- code extraction -------------------------------------------------------

console.log("authorization code extraction");
check("raw code", extractCode("  abc123  ") === "abc123");
check("callback url", extractCode("http://127.0.0.1:51423/callback?code=xyz789&state=s") === "xyz789");
check("callback url without code", extractCode("http://127.0.0.1:51423/callback?state=s") === undefined);
check("blank input", extractCode("   ") === undefined);

// --- live catalog ----------------------------------------------------------

console.log("live catalog");
try {
  const models = await fetchTokenDanceModels(new AbortController().signal);
  const allResponses = models.every((model) => model.reasoning === true);
  check(`discovered ${models.length} openai:responses models`, models.length > 0);
  check("every discovered model has reasoning enabled", allResponses);
  check("discovered models expose an id and context window",
    models.every((model) => Boolean(model.id) && (model.contextWindow ?? 0) > 0));

  const fingerprint = (model: (typeof models)[number]) =>
    `${model.id}|${model.input.join(",")}|${model.contextWindow}`;
  const seedSet = new Set(SEED_MODELS.map(fingerprint));
  const liveSet = new Set(models.map(fingerprint));
  check("bundled snapshot matches the live catalog",
    seedSet.size === liveSet.size && [...liveSet].every((entry) => seedSet.has(entry)),
    { missing: [...liveSet].filter((entry) => !seedSet.has(entry)), extra: [...seedSet].filter((entry) => !liveSet.has(entry)) });
} catch (error) {
  check(`live catalog request -> ${String(error)}`, false);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
