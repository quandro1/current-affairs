// AnalysisProvider abstraction. The application only talks to this interface, so an AI
// provider can be added later without touching ingestion, scoring or notifications.
//
//   AnalysisProvider
//     ├── RuleBasedProvider   (implemented — the MVP, no keys, no network)
//     ├── LocalAIProvider     (future: e.g. Ollama on another machine; stub)
//     └── CloudAIProvider     (future: any hosted API; stub)
//
// Contract: analyze(facts) -> { why: [{id, text, basis}], flameOn: [{id, kind, direct, text}], summary: string|null }
// 'basis' is always reported to the UI so rule-based context is never mistaken for analysis.
import { RuleBasedProvider } from './rulebased.js';

export class LocalAIProvider {
  constructor(opts) { this.name = 'local-ai'; this.opts = opts; }
  available() { return false; }
  analyze() { throw new Error('LocalAIProvider is not implemented in the MVP'); }
}

export class CloudAIProvider {
  constructor(opts) { this.name = 'cloud-ai'; this.opts = opts; }
  available() { return false; }
  analyze() { throw new Error('CloudAIProvider is not implemented in the MVP'); }
}

// Always returns a working provider. AI providers are only used when explicitly selected AND
// available; otherwise the rule-based provider is used, so missing API keys can never break a run.
export function getProvider(cfg, env = process.env) {
  const rule = new RuleBasedProvider(cfg);
  const want = (env.ANALYSIS_PROVIDER || 'rules').toLowerCase();
  let p = null;
  if (want === 'local') p = new LocalAIProvider({ url: env.LOCAL_AI_URL });
  if (want === 'cloud') p = new CloudAIProvider({});
  if (p && p.available()) return p;
  return rule;
}
