/** Settings → Models catalog metadata.
 *
 *  The provider API is the source of truth for which models a credential can use; `ModelPicker`
 *  loads that live list through `/api/models/catalog`. The entries here are only the OFFLINE
 *  fallback shown before a key is saved (or when the provider cannot be reached), so the field is
 *  never an empty box while the provider is unreachable. **Custom model…** covers every ID these
 *  short lists do not carry.
 *
 *  Thinking is managed automatically by the selected model and runner.
 */

export type ModelChoice = { id: string; label: string; supportsTools?: boolean };

const GEMINI_FALLBACK: ModelChoice[] = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
];

/** Fallback suggestions per provider mode. A missing key (or null) keeps the field as free text. */
export const MODEL_FALLBACKS: Record<string, ModelChoice[]> = {
  // Bedrock suggestions come from the selected region, not a universal model ID.
  bedrock: [],
  groq: [
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B" },
    { id: "qwen/qwen3.6-27b", label: "Qwen 3.6 27B" },
  ],
  deepseek: [
    { id: "deepseek-flash", label: "DeepSeek Flash" },
    { id: "deepseek-chat", label: "DeepSeek Chat" },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
  ],
  gemini: GEMINI_FALLBACK,
  antigravity: GEMINI_FALLBACK,
  "openai-api": [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "gpt-5-nano", label: "GPT-5 nano" },
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "o3", label: "o3" },
  ],
  subscription: [
    { id: "sonnet", label: "Claude Sonnet" },
    { id: "opus", label: "Claude Opus" },
    { id: "haiku", label: "Claude Haiku" },
  ],
};

/** Providers whose model list can be fetched with the user's key. The ChatGPT plan has its own
 *  account-bound catalogue (`ChatGPTModelInput`); Bedrock/custom depend on the endpoint/region and
 *  stay free text. */
const LIVE_MODES = new Set(["groq", "deepseek", "gemini", "antigravity", "openai-api", "bedrock"]);

export const BEDROCK_REGIONS = [
  { value: "us-east-1", label: "US East · N. Virginia" },
  { value: "us-east-2", label: "US East · Ohio" },
  { value: "us-west-2", label: "US West · Oregon" },
  { value: "eu-west-1", label: "Europe · Ireland" },
  { value: "eu-central-1", label: "Europe · Frankfurt" },
  { value: "eu-west-2", label: "Europe · London" },
  { value: "ap-northeast-1", label: "Asia Pacific · Tokyo" },
  { value: "ap-northeast-2", label: "Asia Pacific · Seoul" },
  { value: "ap-south-1", label: "Asia Pacific · Mumbai" },
  { value: "ap-southeast-1", label: "Asia Pacific · Singapore" },
  { value: "ap-southeast-2", label: "Asia Pacific · Sydney" },
];

export function hasLiveCatalog(mode: string | undefined | null): boolean {
  return !!mode && LIVE_MODES.has(mode);
}

/** The offline suggestions for a provider mode, or null when the field must stay free text
 *  (deployment default, custom endpoint, Bedrock). */
export function fallbackChoicesForMode(mode: string | undefined | null): ModelChoice[] | null {
  if (!mode) return null;
  return MODEL_FALLBACKS[mode] ?? null;
}
