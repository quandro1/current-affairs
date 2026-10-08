#!/usr/bin/env node
// Validate every config/*.json file (also run in CI before each pipeline run).
import { loadConfig } from '../src/config.js';
try {
  const cfg = loadConfig();
  console.log(`config OK: ${cfg.compiled.feeds.length} feeds, ${cfg.compiled.entities.length} entities, ${cfg.compiled.topics.length} topics, ${cfg.rules.rules.length} rules, ${cfg.templates.templates.length} templates, ${cfg.flameon.rules.length} Flame On rules, ${cfg.preferences.watchlist.length} watch items`);
} catch (e) { console.error(e.message); process.exit(1); }
