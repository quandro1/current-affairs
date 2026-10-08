# Current Affairs: Personal Intelligence System

A mobile-first PWA that watches ~55 news feeds, filters out noise, groups reports about the same event into one story, scores every story with transparent rules, and notifies you only when something genuinely matters. It also flags developments relevant to Flame On.

**No AI API is used or required.** The system runs on RSS, deterministic rules, keyword and entity matching, source weighting, clustering, scheduling and Web Push. Recurring cost: **$0**.

```
 NEWS SOURCES (RSS/Atom + Google News search feeds)
        ↓  src/ingest/fetch.js      per-feed timeout, ETag, back-off: one dead feed never stops the run
 FEED COLLECTOR
        ↓  src/ingest/parse.js      RSS 2.0 / RSS 1.0 / Atom, tolerant of sloppy feeds
 ARTICLE NORMALIZER                 src/ingest/normalize.js  (metadata + ≤280-char excerpt, never full text)
        ↓
 DUPLICATE DETECTOR                 canonical URL + (publisher, normalized headline) hash
        ↓
 ENTITY / TOPIC / SIGNALS           src/engine/analyze.js    (config/entities.json, categories.json)
        ↓
 STORY CLUSTERING + TIMELINE        src/engine/cluster.js, stories.js  (TF-IDF cosine, headline overlap, shared entities, merge pass)
        ↓
 IMPORTANCE SCORING + RULES         src/engine/score.js      (config/scoring.json, rules.json)
        ↓
 ANALYSIS PROVIDER                  src/analysis/provider.js → RuleBasedProvider (templates.json, flameon.json)
        ↓                                                    → LocalAIProvider / CloudAIProvider (stubs, future)
 NOTIFICATION DECISION              src/notify/decide.js     (severity, topics, quiet hours, once-per-level, rate limits)
        ↓                    ↓
 WEB PUSH / TELEGRAM     BRIEFINGS + STATIC JSON   src/reports/briefings.js, src/publish.js
        ↓                    ↓
      PHONE  ←──────  PWA on GitHub Pages (app/)
```

## How it runs ($0)

| Piece | Where | Cost |
|---|---|---|
| Scheduler + backend | GitHub Actions cron, every 15 min (`.github/workflows/pipeline.yml`) | Free (public repo: unlimited minutes) |
| Database | SQLite (`node:sqlite`, built into Node 24) persisted gzip-compressed on the `data` branch, one force-pushed commit | Free |
| App hosting | GitHub Pages (HTTPS, needed for PWA install + push) | Free |
| Push delivery | Web Push via the browser vendor's service (FCM / Apple / Mozilla), VAPID-signed | Free |
| Telegram (optional) | Bot API | Free |
| AI | none | — |

Dependencies: `fast-xml-parser`, `web-push` (both pure JS). No paid news API, no vector DB, no SaaS.

**Free-tier caveats:** GitHub may delay scheduled runs under load (often 5–20 min). In a public repo, scheduled workflows can be auto-disabled after 60 days without repository activity. Settings changes from the app count as activity, and if it ever happens the app's "Updated … ago" line turns orange and one click on *Actions → pipeline → Enable* restores it.

## What you see

- **Today**: Breaking (critical), Top stories, then Pakistan, World, Geopolitics, Economy, Technology, Flame On and Watchlist. Each card shows level, headline, latest development, why it triggered, source, time, sections and score.
- **What changed?**: new stories, escalations, official confirmations and timeline developments since your last visit, the last briefing, or the last 24 h. Repeated coverage is not shown again.
- **Story page**: kept deliberately separate:
  - *Reported (fact, attributed)*: who reported it, with links to the originals.
  - *Why it was prioritised*: an itemised points table.
  - *Context*: a predefined template, labelled as general and not analysis of this story.
  - *Flame On impact*: a rule-based inference.
  - *Not known from these sources*.
  - Timeline and all sources with their reliability tier.
- **Briefings**: daily (08:00 PKT), evening recap (20:00), weekly (Sunday 09:00) and monthly (1st, 09:00). All times are configurable, and the monthly report is statistics only.
- **Watchlist + search**: 30 days of history. Follow a keyword, entity, topic or country.
- **More**: notification settings, sources (add, disable, re-tier, recategorise, test), rules (view and edit every JSON file with validation), system health, admin access, and how it works.

## Levels and scoring

Defaults (all in `config/scoring.json`, all editable):

| Factor | Points |
|---|---|
| Pakistan / major international / other | 30 / 15 / 5 |
| Best topic factor (e.g. Pakistan core economy 25, geopolitical conflict 25, food inputs 20, major tech 20) | up to 25 (+5 if several match) |
| Source tier 1 / 2 / 3 / 4 | 20 / 15 / 10 / 0 |
| Breaking / major update / routine | 25 / 15 / 5 |
| Casualties 5+ / 15+ / 50+, big % moves | 4 / 12 / 20, 3–6 |
| Flame On direct cost or regulation / indirect | 20 / 15 (only the larger applies) |
| Watchlist | 5 |
| Each extra reliable publisher (max 15); 8+ publishers; official confirmation | 3; 8; 5 |
| Opinion / sport-entertainment / live blog / no priority topic | −20 / −30 / −5 / −10 |

🔴 **Critical ≥ 105** · 🟠 **Important ≥ 90** · 🟡 **Notable ≥ 62** · ⚪ Background below.

Safety caps: Critical needs 2+ reliable publishers or an official source. Personal points alone cannot make a story Critical. Tier-4-only stories stay at Notable or below and are never pushed. Opinion pieces are never pushed. Routine fuel and tariff revisions are capped at Important. These thresholds were calibrated on a real day of news (8 Oct 2026, ~1,200 articles), which gave 1 critical (the IMF staff-level agreement), ~16 important and ~95 notable.

## Rule language

Used by scoring factors, rules, templates, Flame On rules and watchlist items:

```json
{ "all": [ { "field": "countries", "op": "has", "value": "PK" },
           { "field": "topics", "op": "hasAny", "value": ["imf", "interest-rates"] },
           { "field": "baseScore", "op": "gte", "value": 105 } ] }
```

- Fields: `countries topics entities sections tier sourceCount reliableCount urgency direction pct casualties score baseScore level text title flameOn watch opinion noise majorCountry ageHours tier1`
- Ops: `has hasAny hasAll hasNone eq ne in gt gte lt lte matches exists`, combinable with `all` / `any` / `not`.
- Rule actions (`config/rules.json`): `addScore`, `minLevel`, `maxLevel`, `mute`, `flag`, `label`.

## Setup (once)

1. **Create the repo and push.** Run `gh repo create quandro1/current-affairs --public --source . --push`, then in the repo go to *Settings → Pages → Source: GitHub Actions*.
2. **Web Push keys.** Run `npm run vapid`. Put `publicKey` into `config/push.json → vapidPublicKey` and the private key into the repo secret `VAPID_PRIVATE_KEY`.
3. **Optional Telegram.** Message @BotFather → `/newbot` → add the token as secret `TELEGRAM_BOT_TOKEN`. Send your bot any message, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and add `chat.id` as secret `TELEGRAM_CHAT_ID`.
4. **Phone.**
   - Open the site, then *Add to Home Screen* or *Install*.
   - Go to *More → Admin access* and paste a fine-grained token. Scope it to this repo only, with *Contents: read/write* and *Actions: read/write*.
   - Go to *More → Notifications → Enable notifications here*.
   - Use *Server test* to confirm delivery end to end.

### Platform notes for Web Push
- **Android (Chrome, Edge, Samsung Internet, Firefox)**: works in the browser or the installed app.
- **iPhone/iPad**: iOS/iPadOS 16.4+ only, and only from the app **added to the Home Screen** and opened from its icon. Safari tabs cannot receive push.
- **Desktop Chrome, Edge, Firefox**: works. **macOS Safari 16+**: works.
- A device that is off or offline gets the message when it reconnects (TTL 6–12 h). Critical alerts use high urgency.

## Local use

```bash
npm install
npm run validate          # check every config file
npm run run               # one full pipeline run against the live feeds → public/data
npm run serve             # preview the app at http://localhost:8787
npm test                  # 18 automated tests
npm run test-feed -- <url>
```

## Tests (`test/`)

| Area | What is checked |
|---|---|
| Ingestion | RSS 2.0, RSS 1.0/RDF and Atom parsing |
| Malformed input | broken XML and HTML instead of a feed |
| Dates and staleness | missing, broken and future dates; stale items; TV-bulletin roll-ups |
| Google News | publisher crediting and tiering |
| Deduplication | 8 publishers plus a duplicate become ONE story with 8 sources |
| Scoring | a critical IMF story beats minor news; tier-4 cap; opinion penalty; corroboration rule; itemised totals |
| Notifications | a critical story alerts exactly once; low-priority stories never alert; more coverage does not re-alert |
| Quiet hours | an alert is held, then released at 07:30 PKT; critical bypass works; switched-off topics are respected |
| Briefings | due exactly at 08:00 PKT, generated once, right stories; evening recap excludes morning stories |
| Story updates | a later development joins the story timeline instead of creating a new story |
| Feed failures | one dead feed and one HTML page leave the rest working, with errors recorded per feed |
| Flame On | fires on "ghee prices raised", not on cricket |

## Security and privacy

- Secrets (`VAPID_PRIVATE_KEY`, Telegram token) live only in GitHub Secrets and are never written to config or published.
- The admin token stays in your phone's localStorage and is only sent to `api.github.com`. Remove it in *More → Admin access*.
- All edits are validated in the app, again by the pipeline (`validate-config.js`) before every run, and invalid config never runs.
- Published data includes news metadata and config. **Push subscriptions are not published** to the site. They do sit in `config/subscriptions.json` in the public repo, but they are useless without the private VAPID key.
- No analytics, no ads, no third-party scripts. `noindex` is set.

## Limitations (honest)

- **Latency.** The schedule runs every 15 min plus GitHub delay, and RSS publication itself lags. Expect alerts 15–45 min after publication.
- **Keyword rules misfire sometimes.** Every story shows exactly which rules fired, so fixes are a config edit.
- **Clustering is deterministic, not semantic.** Two reports of the same event with completely different vocabulary can stay separate. Tune `THRESHOLDS` in `src/engine/cluster.js` and `MERGE` in `stories.js`.
- **No full article text.** "Why it matters" lines are general templates, not story-specific analysis.
- **Some feeds block or reset requests from some networks** (Al Jazeera, DW and The Hindu from a Pakistani ISP). They are retried with back-off and visible in System health.

## Future AI (optional, not required)

`src/analysis/provider.js` defines the `AnalysisProvider` contract. Setting `ANALYSIS_PROVIDER=local` with a working `LocalAIProvider` (e.g. Ollama on another machine) would add summaries. Until a provider reports `available()`, the rule-based provider is used, so missing keys can never break a run.
