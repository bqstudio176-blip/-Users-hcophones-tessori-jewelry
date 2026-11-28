# AI Architecture — Creative Intelligence Engine (Phase 3)

This document describes how Script Lab uses AI: the agents, the orchestrator, the provider abstraction, context retrieval, validation, billing and the defenses that keep model output honest and safe.

## 1. Principles

1. **AI recommends; people decide.** Agents never change saved content on their own. Edits come back as proposals the user must confirm, and quality reviews only make recommendations.
2. **No fabricated research.** Every recommendation is labelled *observed* (with a cited source id), *user* (citing the strategy field it came from) or *hypothesis*. Citations are checked against the ids the agent was actually given.
3. **No performance promises.** No agent has audience or performance data. Prompts forbid predicting virality, views or sales, and a forbidden-claim check rejects any output that does.
4. **Originality.** References are for analysis only. Generated scripts are compared against reference transcripts (8-gram overlap) and rejected above 15%.
5. **Credits are charged only for validated output.** Failed, refused or invalid runs are recorded but free.
6. **No silent learning.** Feedback is stored. Only *approved* preferences reach the agents, and no model is trained on workspace data.

## 2. Components

```
UI (server components + server actions, src/server/actions/creative.ts)
        │
        ▼
Creative Orchestrator (src/server/creative/orchestrator.ts)
  ├─ request validation (zod, in the server actions)
  ├─ context retrieval  (context.ts, workspace-scoped, relevance-ranked)
  ├─ rule selection     (selection.ts, deterministic, with reasons)
  ├─ agents             (prompts.ts + schemas.ts)
  │     Research · Strategy · Hook · Script (+ Script edit) · Quality
  ├─ output validation  (validators.ts, sanitize.ts, originality.ts, duration.ts)
  ├─ persistence        (db.ts → Supabase with the user's session → RLS)
  └─ usage + credits    (check_ai_usage / record_ai_agent_run RPCs)
        │
        ▼
Provider abstraction (src/server/analysis/ai/provider.ts → AnalysisModel)
  └─ ClaudeAnalysisModel (claude.ts): Claude, structured outputs, refusal fallbacks
```

The orchestrator depends only on two interfaces: `CreativeDb` (`rpc`, `select`, `insert`, `update`) and `AnalysisModel` (`generate`). In production these are `supabaseCreativeDb(createClient())`, which runs as the signed-in user so RLS applies, and `ClaudeAnalysisModel`. Tests use `pgCreativeDb` (real Postgres, `authenticated` role) and `MockCreativeModel`.

## 3. Agents

| Agent | Credits | Prompt version | Input | Output schema | Validation |
|---|---:|---|---|---|---|
| Research | 1 | `research@1` | Selected references (summaries plus 600-char transcript excerpts), history references | `ResearchBrief`: patterns with evidence citations, gaps, cautions | Every cited id exists in the input |
| Strategy | 2 | `strategy@1` | Strategy brief, research brief, selected rules, approved preferences | `StrategyRecommendations`: 9 kinds × 1–3, each with reasoning and provenance | All 9 kinds present; valid citations; `user` provenance names a real field; no forbidden claims |
| Hook | 2 | `hook@1` | Strategy, rules, preferences, requested categories | `HookBatch`: text, category, mechanism, visual opening, delivery, duration, rationale | Count, requested categories, length, rule refs, forbidden claims, overlap with references |
| Script | 4 | `script@1` | Strategy, optional hook, format, target duration, rules, references, preferences | `GeneratedScript`: title, 8 sections, scenes, rules applied, assumptions | First scene is the hook; 1–60 scenes; duration within target ± tolerance; speech density; originality ≤ 15%; rule refs; forbidden claims |
| Script edit | 1 | `script_edit@1` | Current scenes (locked ones marked), the operation and its scope | `ScriptEditProposal` | Locked scenes unchanged; only in-scope scenes change; shorten/expand go in the right direction; originality |
| Quality | 1 | `quality@1` | Script, strategy, deterministic checks (as facts) | `QualityAssessment`: 10 criteria (1–5), strengths, weaknesses, suggestions | All 10 criteria present once; scores 1–5; no performance-prediction phrasing; scene numbers exist |

The **Creative Orchestrator** is not a model. It is the code that sequences agents. For example, `generateStrategyRecommendations` runs Research only when references have analysis summaries, then Strategy. It also retrieves context, selects rules, validates and persists.

### Agent call lifecycle (`runAgent`)
1. `check_ai_usage(workspace, agent)` checks the credit balance, the per-user per-minute limit, and the workspace hourly and daily limits for its plan (free 5/20/60, creator 8/60/300, studio 12/150/1000 per minute/hour/day). If the request is not allowed, nothing is called and nothing is charged.
2. The model is called with the agent's system prompt, its content blocks and a Zod schema (structured output).
3. Validation runs. If it fails, a second attempt is made with the validation problems appended. Refusals and provider errors are not retried inline.
4. `record_ai_agent_run(...)` writes one `ai_agent_runs` row plus one `ai_invocations` row per model call. It charges `ai_agent_pricing.credits` **only if status = succeeded**. If the balance became insufficient between check and record, the RPC raises, and the output is discarded.
5. The result goes to the caller, which persists it (ideas, hooks, script and scenes, proposal, report).

## 4. Provider abstraction and model configuration

`AnalysisModel` (shared with the Phase 2 analysis pipeline) exposes `provider`, `model` and `generate({purpose, promptVersion, system, content, schema})`. It returns `{data, servedModel, inputTokens, outputTokens, latencyMs, costUsd}` or throws `RefusalError`, `InvalidOutputError`, `RetryableError` or `PermanentError`.

`ClaudeAnalysisModel` calls `client.beta.messages.parse` with `betaZodOutputFormat(schema)`, `output_config.effort`, and server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). The default model is `claude-opus-5-5`.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. Without it, every AI action returns `not_configured` and nothing is charged. |
| `CREATIVE_MODEL` | `claude-opus-5-5` | Model for the Script Lab agents |
| `CREATIVE_EFFORT` | `medium` (`.env.example` sets `high`) | `output_config.effort`: `low`, `medium` or `high` |
| `ANTHROPIC_DISABLE_FALLBACKS` | unset | Set to `1` to disable server-side refusal fallbacks |

To add a provider, implement `AnalysisModel` and return it from `creativeModel()` in `src/server/actions/creative.ts`. Nothing else changes.

## 5. Context retrieval (`context.ts`)

- **Workspace-scoped:** every query filters on `workspace_id` and runs through RLS as the user. Cross-tenant references cannot enter context: a DB trigger checks `content_strategies.reference_ids` against the workspace.
- **Sources:** the references selected on the strategy (`R1…`); with `use_content_history`, up to 3 more workspace references ranked by term overlap with the strategy (`H1…`); previous scripts in the project (titles only); approved preferences.
- **Relevance filtering:** `rankByRelevance` scores candidates by overlap with the strategy's niche, topic, audience and manual topics, and drops those with zero overlap.
- **Bounded:** transcripts are cut to 600-character excerpts, and every field is truncated.
- **Performance insights:** this list is empty in Phase 3 because no real performance data exists. The UI says so rather than inventing any.

## 6. Billing and usage policy

| Situation | Recorded | Charged |
|---|---|---|
| Valid output (first or second attempt) | run `succeeded` + invocations | yes, the agent's price |
| Invalid twice | run `invalid_output` | no |
| Provider refusal | run `refused` | no |
| Network/auth/provider error | run `failed` | no |
| Blocked by credits or limits | nothing (pre-flight) | no |
| Balance insufficient at record time | run not charged; output discarded | no |

`ai_agent_runs` and `ai_invocations` are append-only, even for `service_role`. The **AI usage** page (`/script-lab/usage`) lists runs, tokens, provider cost, prompt versions and credits.

## 7. Prompt-injection and safety defenses

| Layer | Mechanism |
|---|---|
| Delimiting | Every user-supplied or third-party string goes in `untrustedBlock(kind, id, text, max)`, an `<untrusted_data>` element. The system prompt says its content is data, never instructions. |
| Neutralisation | `neutralize()` strips control characters and zero-width characters, and defangs forged `<untrusted_data>` / `</untrusted_data>` / system-like tags inside the data. |
| No tools | Agents have no tools, so injected text cannot trigger actions. The worst case is bad output, which validation catches. |
| Schema validation | Structured outputs plus Zod, then semantic validators. |
| Citation check | Only ids present in the input are accepted. |
| Claim check | `containsForbiddenClaim` rejects guarantees and predictions of virality, views, sales or results. |
| Originality | 8-gram overlap ≤ 0.15 against reference transcripts. |
| Monitoring | `detectInjection` flags suspicious strings in the request summary for auditing. It never blocks on heuristics alone. |
| Scope | The DB layer runs as the user: an agent can only read what the user can read. |

## 8. Editing safety

- AI edits are stored as `scripts.pending_proposal` with `base_version`. Nothing changes until the user clicks **Apply**.
- `replace_script_content(..., 'ai_edit_applied')` re-checks that locked scenes are unchanged and rejects stale proposals (`base_version ≠ current_version`). It saves a `before_ai_edit` version first.
- **Generate alternative** creates a separate script (`parent_script_id`) and never overwrites.
- Restore saves a `before_restore` version first. Manual saves create versions on demand.
- Approved scripts are not modified by AI without the same explicit confirmation.

## 9. Prompt versions

| Agent | Version |
|---|---|
| research | `research@1` |
| strategy | `strategy@1` |
| hook | `hook@1` |
| script | `script@1` |
| script_edit | `script_edit@1` |
| quality | `quality@1` |

Bump the version in `src/server/creative/prompts.ts` whenever a prompt changes. Versions are stored on every run and invocation.

## 10. Known limitations

- Live Claude calls have not been run in this environment: no API key is configured here. All agent flows are tested end to end with a deterministic mock model against real Postgres.
- Duration is an estimate (~2.5 spoken words per second, using the scene durations the AI proposed). Real duration is known only after recording.
- Rule selection is deterministic and keyword-based, not semantic. That is predictable and explainable, but it can miss synonyms.
- Quality scores are editorial heuristics from a model. They are not calibrated and are not predictions.
