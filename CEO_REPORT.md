# TAS (Transmodal Anti-Spam) — CEO Report

## Current Status
- MVP is live (Rules → LLM) with low false positives and improved recall using LLM fallback.
- API simplified; deployment stable; demo connected.
- Evaluation on real dataset (stratified samples with LLM enabled):
  - Threshold 0.35 (decision): Accuracy ~83%, Precision ~94.6%, Recall ~70.0%, F1 ~80.5%, FPR ~4.0%.
  - Trade-off chosen for Telegram-grade safety (FPR < 5%) while significantly lifting recall.

## What Works
- Very low false positives (safe for production messaging).
- High precision: when flagged, messages are almost always spam.
- Modular pipeline (RRS/LUR/SIG/Rules/LLM) allows targeted improvements.

## Key Gaps/Risks
- Latency with LLM fallback (P95 can exceed 2s on cold calls).
- Coverage gaps in rules for: URL-only spam, crypto/scam, adult/NSFW, multilingual.
- LLM cost/latency pressure under load; need caching and short-circuiting.

## Guiding Product Principles
1) Safety-first: FPR < 5% (do not block legit traffic).  
2) Useful recall: target ≥ 75% on real data.  
3) P95 latency < 300ms for pure-rules path; < 700ms with LLM fallback (with cache).  
4) Operational efficiency: strong caching, batched calls, cost control.

## 30 / 60 / 90-Day Plan

### Next 30 Days (Reliability + Coverage)
- Add high-signal rules for URL-only, crypto scams, affiliate/referral spam, adult content, multilingual patterns (AR/FR/ES/ZH).
- Introduce fast URL risk heuristics (shorteners, suspicious TLDs) and blocklists.
- LLM guardrails: force JSON, reduce prompt length, early exit when rules are confident.
- Response caching (content signature) with TTL to cut LLM usage and latency.
- Ship decision threshold = 0.35 as default; document tuning guidance.

### 60 Days (Performance + Tooling)
- Warm-up and connection reuse for LLM; parallel-friendly micro-batching where applicable.
- Canary rule rollouts and shadow rules via ROL to safely expand coverage.
- Auto-evaluator: nightly stratified tests on fresh samples; dashboard of Precision/Recall/FPR/FNR/Latency.
- Add feedback hooks (human-in-the-loop) to collect false negatives/positives.

### 90 Days (Learning Loop + Integrations)
- Lightweight learning pipeline from moderation feedback to rules/signatures updates.
- RapidAPI listing + reference clients (Telegram bot middleware, webhook, Node/Python SDKs).
- Enterprise controls: per-tenant thresholds, allow/deny lists, audit logs, export.

## Engineering Workstreams (Prioritized)
1) Ruleset Expansion (High impact, low risk)
   - URL-only + risky TLDs + short domains
   - Crypto/web3 scams; wallet/bot spam; investment promises
   - Adult/NSFW lexical/emoji patterns
   - Multilingual lexicons (AR/FR/ES/ZH), transliteration tricks

2) Latency & Cost Control (High impact)
   - Content-hash cache for LLM results (LRU + TTL)
   - Short-circuit LLM when rules score is decisive
   - Strict JSON schema + max_tokens + temperature=0.0
   - Connection reuse and warm-up

3) Observability & QA (Sustained quality)
   - Nightly evaluation job on stratified samples; artifacts in repo
   - FP/FN sampler reports for human review
   - Canary/shadow rules with metrics before promotion

## Metrics Targets (Quarter)
- FPR ≤ 5%, Recall ≥ 75%, F1 ≥ 82%
- P95 latency: Rules-only ≤ 200ms; Rules+LLM ≤ 700ms (with cache)
- LLM hit-rate ≤ 15% of traffic (via rules + cache)

## Required Decisions
- Approve threshold 0.35 as default for “safe + useful” posture.
- Approve budget for LLM usage with caching (cost cap + alerts).
- Approve priority on rule coverage vs. immediate ML reintroduction (recommend: rules first).

## Go-To-Market Readiness
- Positioning: “Fast, safe, and smart commercial spam filter for messengers & marketplaces.”
- First channel: RapidAPI listing with working demo, concise docs, and SDKs.
- Pricing: tiered by volume; optional enterprise add-ons (multi-tenant controls, SLAs).
