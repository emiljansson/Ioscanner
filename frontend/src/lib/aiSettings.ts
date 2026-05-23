// Multi-provider AI settings: OpenAI, Google Gemini, Anthropic Claude.
// Keys live in SecureStore (iOS Keychain / Android EncryptedSharedPrefs).
// Each provider can independently be enabled as a "verifier" – when on, that
// provider's OCR is run in parallel and cross-checked against the primary's
// reading to boost the confidence score.

import { storage } from "@/src/utils/storage";

export type ProviderId = "openai" | "gemini" | "anthropic";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  model: string;
  hint: string;
  consoleUrl: string;
  keyPrefix: string;
};

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    model: "gpt-5.5",
    hint: "Best overall vision + structuring. Default choice.",
    consoleUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    model: "gemini-3.1-pro-preview",
    hint: "Strong at low-quality / handwritten scans.",
    consoleUrl: "https://aistudio.google.com/app/apikey",
    keyPrefix: "AIza",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    model: "claude-sonnet-4-5",
    hint: "Excellent at preserving document structure & nuance.",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
  },
];

export function providerById(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

const ACTIVE_KEY = "ai.activeProvider";
const KEY_OF = (id: ProviderId) => `ai.key.${id}`;
const VERIFIER_OF = (id: ProviderId) => `ai.verifier.${id}`;

export async function getActiveProvider(): Promise<ProviderId> {
  const v = await storage.getItem<string>(ACTIVE_KEY, "openai");
  if (v === "openai" || v === "gemini" || v === "anthropic") return v;
  return "openai";
}

export async function setActiveProvider(id: ProviderId): Promise<void> {
  await storage.setItem(ACTIVE_KEY, id);
}

export async function getApiKey(id: ProviderId): Promise<string> {
  const v = await storage.secureGet<string>(KEY_OF(id), "");
  return v ?? "";
}

export async function setApiKey(id: ProviderId, key: string): Promise<void> {
  const trimmed = (key || "").trim();
  if (!trimmed) {
    await storage.secureRemove(KEY_OF(id));
    return;
  }
  await storage.secureSet(KEY_OF(id), trimmed);
}

export async function getVerifier(id: ProviderId): Promise<boolean> {
  const v = await storage.getItem<boolean>(VERIFIER_OF(id), false);
  return !!v;
}

export async function setVerifier(id: ProviderId, on: boolean): Promise<void> {
  await storage.setItem(VERIFIER_OF(id), !!on);
}

/** Returns the list of providers that have a key AND verifier=on AND are
 * NOT the active/primary provider. */
export async function getActiveVerifiers(): Promise<ProviderId[]> {
  const active = await getActiveProvider();
  const out: ProviderId[] = [];
  for (const p of PROVIDERS) {
    if (p.id === active) continue;
    const [on, key] = await Promise.all([getVerifier(p.id), getApiKey(p.id)]);
    if (on && key) out.push(p.id);
  }
  return out;
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
