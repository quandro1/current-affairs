// The MVP analysis provider: predefined templates + Flame On impact rules. No generation.
import { evaluate } from '../engine/conditions.js';

export class RuleBasedProvider {
  constructor(cfg) { this.cfg = cfg; this.name = 'rules'; }
  available() { return true; }

  flameOn(facts) {
    const out = [];
    for (const r of this.cfg.flameon.rules || []) {
      if (evaluate(r.when, facts)) out.push({ id: r.id, kind: r.kind, direct: !!r.direct, text: r.text });
    }
    return out;
  }

  why(facts) {
    const max = this.cfg.templates.maxPerStory || 2;
    const out = [];
    for (const t of this.cfg.templates.templates || []) {
      if (out.length >= max) break;
      if (evaluate(t.when, facts)) out.push({ id: t.id, text: t.text, basis: 'template' });
    }
    return out;
  }

  analyze(facts) {
    return { why: this.why(facts), flameOn: this.flameOn(facts), summary: null, provider: this.name };
  }
}
