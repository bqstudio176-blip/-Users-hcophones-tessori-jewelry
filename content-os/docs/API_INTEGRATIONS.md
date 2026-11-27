# API Integrations — Content OS

_Status as of Phase 2 (2026-11-24). "Live-verified" means exercised against the real provider. Everything else was tested only against mocked HTTP or a stubbed SDK._

| Integration | Used for | Status | Configuration |
|---|---|---|---|
| Supabase (Auth, PostgREST, Storage) | Everything | Implemented; **not live-verified** (no project available) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (worker) |
| Anthropic Claude (Messages API, structured outputs) | Frame and content analysis | Implemented; stubbed-SDK tests only; **awaiting credentials** | `ANTHROPIC_API_KEY`, `ANALYSIS_MODEL` (default `claude-opus-5-5`), `ANTHROPIC_DISABLE_FALLBACKS` |
| OpenAI Whisper (`/v1/audio/transcriptions`) | Transcription | Implemented; mocked-HTTP tests only; **awaiting credentials** | `OPENAI_API_KEY` |
| YouTube Data API v3 | Discovery search, trending, metadata | Implemented; mocked-HTTP tests only; **awaiting credentials** | `YOUTUBE_API_KEY`, `DISCOVER_TRENDING_REGION` |
| YouTube oEmbed | URL accessibility and metadata for imported links | Implemented; mocked-HTTP tests only. Public endpoint, no key needed. | — |
| Instagram (Instagram API with Instagram Login) | Account connection (Phase 1); own-media discovery (Phase 2) | Implemented; **not live-verified**; needs a Meta app | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `OAUTH_STATE_SECRET`, `TOKEN_ENCRYPTION_KEY_V1` |
| Instagram public pages (HEAD request) | URL accessibility check only | Implemented; mocked-HTTP tests only | — |
| Instagram Hashtag Search | Discovery | **Not available.** Documented interface only. | Requires Facebook Login for Business plus Meta App Review |
| ffmpeg / ffprobe | Media processing | **Live-verified** (real binaries in tests and in the worker smoke test) | Installed on the worker host (`worker/Dockerfile`) |

---

## Anthropic Claude

- **Calls:** `client.beta.messages.parse` with `output_config.format = betaZodOutputFormat(schema)` and `effort: "medium"` (`@anthropic-ai/sdk` 1.13). Every response is checked again against the same Zod schema, plus a domain check that timestamps fall inside the video and scene indices exist, before anything is stored.
- **Separate prompts** (versioned in `src/server/analysis/ai/prompts.ts`): `visual@1`, `hook@1`, `narrative@1` (storytelling, retention and CTA), `editing@1`, `summary@1`, `creative@1`.
- **Data sent:** representative JPEG frames, 640px wide, one per detected scene and at most 24 per video, sent only to the visual step. Everything else gets text: the timestamped transcript, the scene list and measured editing facts. No video bytes and no audio are ever sent.
- **Refusal fallbacks:** on by default (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`). If the model declines on safety grounds, the API reruns the request on a fallback model. A final `refusal` stops the analysis permanently, and its credits are refunded.
- **Error handling:** 429, 5xx and connection errors are retried by the job queue with backoff. 400, 401, 403 and 404 fail permanently. Invalid output is re-asked once inline, then the job is retried.
- **Recorded per call** (`ai_invocations`): provider, served model, prompt version, status, input and output tokens, latency, and estimated cost (built-in price table: `claude-opus-5-5` at $4 / $20 per million tokens).
- **Expected cost:** roughly 6 to 7 calls per analysis. A 60-second video with about 12 frames comes to an estimated ~$0.05–0.15 at `claude-opus-5-5` prices. Not measured live.
- **Not verified:** no live call was made. Anthropic keys can't be stored as network secrets in this cloud environment; the only route is an environment variable added in the environment settings.

## OpenAI Whisper

- `POST https://api.openai.com/v1/audio/transcriptions` with `model=whisper-1`, `response_format=verbose_json`, `timestamp_granularities[]=segment`.
- **Input:** mono 16 kHz 64 kbps MP3 extracted by ffmpeg (about 0.5 MB per minute; the provider limit is 25 MB).
- **Output stored:** full text, language, and segments with original millisecond timestamps.
  - Speakers: `null`, because Whisper does not diarize.
  - Confidence: derived as `exp(avg_logprob)` and labelled as derived.
- **When unavailable:** with no key, analyses still complete without a transcript, and the report says so. Provider 429/5xx errors are retried; other errors mark the transcript `failed`.
- **Cost:** OpenAI's per-minute pricing applies. Not measured live.

## YouTube Data API v3

- **Search:** `GET /youtube/v3/search?part=snippet&type=video&q=…&videoDuration=short|medium|long`, then `GET /youtube/v3/videos?part=contentDetails,statistics&id=…` for duration and public counts.
- **Trending:** `GET /youtube/v3/videos?chart=mostPopular&regionCode=…`.
- **Quota:** the default is 10,000 units per day. Search costs 100 units and videos.list costs 1, so one Content OS search costs ~101 units (about 99 searches per day per project). Trending costs 1 unit per Discover page view.
- **Restrictions:** metadata only. Videos are never downloaded. The YouTube API Services Terms apply, including obligations to refresh or delete stored API data.
- **Metrics:** only counts YouTube actually returns are stored. Hidden counts stay absent and are never estimated.

## Instagram

- **Own media:** `GET https://graph.instagram.com/v21.0/me/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,timestamp,like_count,comments_count`, using the workspace's encrypted token, which is decrypted server-side only after a membership check.
- **URL checks:** a `HEAD` request to the canonical `https://www.instagram.com/reel/{code}/` without following redirects. Outcomes are `reachable` (200), `login_required` (redirect to login), `not_found` (404), or `unverifiable` (anything else, including network failure).
- **No video retrieval.** Instagram does not allow downloading other accounts' videos. Users upload files they have the right to use.
- **Hashtag search** needs Facebook Login for Business, a Page linked to the account, and the Instagram Public Content Access feature through App Review. It has a limit of 30 unique hashtags per 7 days. It is documented in the provider registry and shown as unavailable.

## Adding a discovery provider

Implement `DiscoveryProvider` (`src/server/discovery/types.ts`):

- `availability()`
- `search()`
- optional `trending()`
- a `docs` block: capabilities, authentication, rate limits, metadata, restrictions, costs

Then add it to `DISCOVERY_PROVIDERS` in `registry.ts` and insert a `discovery_sources` row in a new migration. The UI, search persistence and failure isolation need no changes.

## Anthropic Claude (Script Lab agents, Phase 3)

- **Used by:** the Research, Strategy, Hook, Script, Script edit and Quality agents (`src/server/creative/orchestrator.ts`), through the shared `AnalysisModel` abstraction (`src/server/analysis/ai/claude.ts`).
- **Endpoint:** Messages API via `@anthropic-ai/sdk` `client.beta.messages.parse`, with Zod structured outputs (`betaZodOutputFormat`), `output_config.effort`, and server-side refusal fallbacks (beta `server-side-fallback-2026-07-01`).
- **Configuration:** `ANTHROPIC_API_KEY` (required), `CREATIVE_MODEL` (default `claude-opus-5-5`), `CREATIVE_EFFORT` (default `high`), `ANTHROPIC_DISABLE_FALLBACKS`.
- **Calls run from:** server actions (the web process). The Script Lab route segment sets `maxDuration = 300`.
- **Data sent:** the strategy brief, selected rules, approved preferences, reference summaries and transcript excerpts (≤ 600 characters each), and script scenes for edit and quality runs. All user and third-party text is wrapped as untrusted data. No credentials or personal account data are sent.
- **Costs:** tokens are reported by the API, and cost is estimated from the model price table. Workspace credits per run: research 1, strategy 2, hook 2, script 4, edit 1, quality 1, charged only on validated success.
- **Limits:** per-plan per-minute, hourly and daily limits (`ai_usage_limits`) are enforced before every call.
- **Failure handling:** an invalid output gets one corrective retry. Refusals and provider errors are recorded and not charged.
- **Status in this build:** not exercised live; no key is available in the build environment. Covered by the mock-model end-to-end tests.
