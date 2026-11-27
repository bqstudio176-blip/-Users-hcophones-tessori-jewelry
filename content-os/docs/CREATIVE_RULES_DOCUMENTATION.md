# Creative Rules Documentation

The Creative Rules Engine is a library of original, documented guidelines for short-form video. The agents choose from it. Every rule is a piece of craft guidance with explicit conditions and an honest evidence label, not a formula. Rules **guide** creative work. They never guarantee results, and the engine never applies every rule at once.

## 1. Inventory

110 global rules in 10 categories, 11 per category. Source of truth: `src/server/creative/rules/library.ts`. They are seeded by the generated migration `supabase/migrations/20261126001100_seed_creative_rules.sql` (`npm run rules:seed`), with 231 tags.

| Category | Rules | Established principle | Practitioner heuristic | Experimental | Examples |
|---|---:|---:|---:|---:|---|
| Psychology of attention (`attention_psychology`) | 11 | 5 | 6 | 0 | Pattern interrupt in the first frame; Movement within the first second; Face and eye contact early |
| Hooks and openings (`hooks_openings`) | 11 | 1 | 10 | 0 | Promise the payoff; Start in the middle of the action; Call out the intended viewer |
| Storytelling (`storytelling`) | 11 | 4 | 7 | 0 | Set-up, conflict, resolution; Follow one protagonist; Make the stakes explicit |
| Audience retention (`audience_retention`) | 11 | 1 | 9 | 1 | Preview the structure; Deliver real value before the midpoint; Re-hook at the midpoint |
| Curiosity (`curiosity`) | 11 | 1 | 9 | 1 | Open an information gap; Withhold the key detail; Unexpected juxtaposition |
| Emotional connection (`emotional_connection`) | 11 | 2 | 9 | 0 | Name the feeling; Start from a relatable struggle; Empathy before solution |
| Authority and credibility (`authority_credibility`) | 11 | 4 | 7 | 0 | Demonstrate, don't claim, expertise; Cite sources; Numbers with context |
| Persuasion (`persuasion`) | 11 | 7 | 4 | 0 | Give value first; Contrast framing; Loss framing, responsibly |
| Conversion (`conversion`) | 11 | 3 | 8 | 0 | One goal per video; Make the next step easy; State the offer clearly |
| Calls to action (`calls_to_action`) | 11 | 1 | 9 | 1 | One clear CTA; CTA matches the objective; Give a reason to act |
| **Total** | **110** | **29** | **78** | **3** | |

The full list is in the [appendix](#appendix-full-rule-list).

## 2. Evidence types

| Type | Meaning | Requirement |
|---|---|---|
| `established_principle` | Rests on a widely documented principle from psychology, rhetoric, persuasion or narrative theory, such as the information-gap theory of curiosity, reciprocity, the serial-position effect or the three-act structure. | An `evidence_note` naming the principle and its source is **required**. This is enforced in the server action and shown in the UI. |
| `practitioner_heuristic` | Common craft guidance used by editors, scriptwriters and creators. Useful, but not a measured effect. | Labelled as a heuristic in the UI. |
| `experimental` | An idea worth testing. Treat it as a hypothesis. | Scored slightly lower by the selection engine. |

No rule claims platform data, view counts or engagement lifts. Content OS has no such data, and the library does not pretend otherwise.

## 3. Rule structure

| Field | Description |
|---|---|
| `id` (uuid), `slug` | Stable identifiers. The slug is unique per scope. |
| `name`, `category` | Display name; one of the 10 categories |
| `description`, `objective` | What the rule is and what it is for |
| `application_conditions[]` | When to apply it (1–10) |
| `avoidance_conditions[]` | When not to use it (0–10) |
| `example` | A short, original example |
| `recommended_formats[]` | Script formats it suits (10 formats) |
| `objectives[]` | Content objectives it serves (empty means any) |
| `tones_excluded[]`, `min/max_duration_seconds` | Hard filters used by selection |
| `complexity_level` | basic / intermediate / advanced |
| `evidence_type`, `evidence_note` | See §2 |
| `version`, `status` | Versioned; draft → pending_approval → approved / disabled |
| tags (`creative_rule_tags`) | Keywords used by search and selection |

## 4. Library management

- **Global library** (`workspace_id IS NULL`): readable by everyone when approved or disabled. Only platform admins can edit it or change its status.
- **Workspace override:** owners and admins can disable or re-enable any global rule for their workspace (`set_creative_rule_override`).
- **Workspace rules:** any member can create a rule. It starts as a draft (or pending approval if submitted right away). Only owners and admins can approve or disable it (`set_creative_rule_status`). Only approved rules are used by the agents.
- **Versioning:** a DB trigger snapshots the previous content into `creative_rule_versions` on every content edit, bumps `version`, and sends edited workspace rules back to `pending_approval`. History is append-only.
- **Audit:** status changes are written to the audit log (`creative.rule_status`).
- **UI:** `/script-lab/rules` (search; filters by category, evidence, format, status, scope and tag), `/script-lab/rules/[id]` (detail, edit, status and override actions, version history), `/script-lab/rules/new`.

## 5. Selection engine (`src/server/creative/selection.ts`)

The engine is deterministic and explainable. For each agent run:

1. **Load enabled rules:** approved global rules, minus workspace overrides, plus approved workspace rules.
2. **Hard filters:** explicitly excluded rules, duration outside the rule's min/max, a tone in `tones_excluded`, or a tag matching an approved *avoid* preference.
3. **Score:**

| Signal | Points | Reason shown |
|---|---:|---|
| Serves the strategy objective | +3 (+1 if the rule is objective-agnostic) | "Serves the "educate" objective" |
| Recommended for the format | +2 (−2 if not) | "Recommended for talking head" |
| Tags match niche, audience or topic keywords | +1–2 | "Matches project keywords: …" |
| Tags echo patterns observed in analyzed references (hook type, narrative structure) | +2 | "Echoes a pattern observed in your analyzed references" |
| Fits an approved *prefer* preference | +2 | "Fits an approved workspace preference" |
| In a focus category (e.g. hooks for the Hook Agent) | +2 | "In a category you are working on" |
| Guardrail tag | +1 | "Guardrail that protects credibility" |
| Evidence | +0.5 established, −0.5 experimental | — |

4. **Diversity and cap:** at most 2 rules per category, 10–12 rules in total. Pinned rules always pass.
5. **Explanation:** each selected rule carries its reasons. They are stored on the strategy (`recommendations.rules[].reasons`) and shown in the UI. Scripts record which rules were applied and how (`sections.rules_applied`).

The agents receive the selected rules as numbered references (`RULE1…`). Outputs may only cite those references, and the validators reject unknown ones.

## 6. Adding or changing rules

**Global library (code):**
1. Edit `src/server/creative/rules/library.ts`. Keep the rule original, add conditions, an example, formats and tags. Use `established_principle` only with an `evidence_note` that names the principle.
2. **Before the seed migration has been applied anywhere**, run `npm run rules:seed` to regenerate `20261126001100_seed_creative_rules.sql`. **Once it has been applied**, never regenerate it. Add a new timestamped migration instead: inserts for new rules (`on conflict (slug) where workspace_id is null do nothing`, as the generator emits) and `update … where slug = … and workspace_id is null` for edits. The versioning trigger snapshots the previous content automatically.
3. Run `npm test`. `tests/unit/creative-engine.test.ts` checks library integrity: 110+ rules, every category covered, required fields present, evidence notes, unique slugs.

**Workspace rules (UI):** Script Lab → Creative rules → *New workspace rule*, then an owner or admin approves it.

## Appendix: full rule list

EP = established principle · PH = practitioner heuristic · EX = experimental

### Psychology of attention

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `pattern-interrupt-first-frame` | Pattern interrupt in the first frame | EP | basic |
| `motion-in-first-second` | Movement within the first second | PH | basic |
| `face-and-eye-contact-early` | Face and eye contact early | EP | basic |
| `salient-subject-contrast` | Make the subject visually salient | EP | intermediate |
| `legible-first-text` | First on-screen text readable in a glance | PH | basic |
| `sound-off-comprehension` | Understandable with sound off | PH | basic |
| `single-focal-point` | One focal point per shot | EP | intermediate |
| `visual-change-cadence` | Match visual change to pacing | PH | basic |
| `concrete-specifics-attract` | Concrete specifics over vague claims | EP | basic |
| `familiar-format-novel-twist` | Familiar format with a novel twist | PH | intermediate |
| `sensory-detail` | Engage the senses | PH | basic |

### Hooks and openings

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `promise-the-payoff` | Promise the payoff | PH | basic |
| `start-in-medias-res` | Start in the middle of the action | EP | intermediate |
| `call-out-the-viewer` | Call out the intended viewer | PH | basic |
| `bold-specific-claim` | Bold, defensible claim | PH | intermediate |
| `ask-their-existing-question` | Ask the question they already have | PH | basic |
| `show-result-first` | Show the result first | PH | basic |
| `mistake-warning-hook` | Common-mistake warning | PH | basic |
| `numbered-promise` | Numbered promise | PH | basic |
| `contrarian-opening` | Contrarian opening | PH | intermediate |
| `aligned-hook-channels` | Align voice, text and visual in the hook | PH | basic |
| `hook-within-three-seconds` | Land the hook within ~3 seconds | PH | basic |

### Storytelling

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `setup-conflict-resolution` | Set-up, conflict, resolution | EP | basic |
| `single-protagonist` | Follow one protagonist | EP | intermediate |
| `make-stakes-explicit` | Make the stakes explicit | EP | basic |
| `show-dont-tell` | Show, don't tell | EP | intermediate |
| `specific-moment` | Zoom into a specific moment | PH | basic |
| `midpoint-turn` | Turning point at the midpoint | PH | intermediate |
| `transformation-arc` | Before-and-after transformation | PH | basic |
| `honest-vulnerability` | Honest vulnerability | PH | intermediate |
| `dialogue-snippet` | Use a line of dialogue | PH | basic |
| `callback-ending` | Callback ending | PH | intermediate |
| `viewer-as-hero` | Viewer as the hero, creator as guide | PH | intermediate |

### Audience retention

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `preview-structure` | Preview the structure | PH | basic |
| `value-before-midpoint` | Deliver real value before the midpoint | PH | basic |
| `midpoint-rehook` | Re-hook at the midpoint | PH | intermediate |
| `cut-dead-air` | Cut dead air and filler | PH | basic |
| `one-idea-per-scene` | One idea per scene | PH | basic |
| `progressive-disclosure` | Progressive disclosure | EP | intermediate |
| `visual-marker-new-point` | Visual marker for each new point | PH | basic |
| `end-after-payoff` | End promptly after the payoff | PH | basic |
| `loopable-ending` | Loopable ending | EX | advanced |
| `progress-markers` | On-screen progress markers | PH | basic |
| `vary-the-rhythm` | Vary the rhythm | PH | intermediate |

### Curiosity

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `information-gap` | Open an information gap | EP | basic |
| `withhold-key-detail` | Withhold the key detail | PH | intermediate |
| `unexpected-juxtaposition` | Unexpected juxtaposition | PH | intermediate |
| `tease-a-specific-item` | Tease a specific item | PH | basic |
| `pause-after-question` | Pause after a question | EX | basic |
| `reveal-why-last` | Reveal the ‘why’ last | PH | basic |
| `mystery-object` | Introduce a mystery object | PH | basic |
| `counterintuitive-fact` | Counterintuitive fact | PH | intermediate |
| `partial-visual-reveal` | Partial visual reveal | PH | basic |
| `invite-a-guess` | Invite the viewer to guess | PH | basic |
| `pay-off-every-tease` | Pay off every tease | PH | basic |

### Emotional connection

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `name-the-feeling` | Name the feeling | EP | basic |
| `relatable-struggle` | Start from a relatable struggle | PH | basic |
| `empathy-before-solution` | Empathy before solution | PH | basic |
| `humor-relief` | Use humour for relief | PH | basic |
| `aspirational-vision` | Aspirational vision | PH | basic |
| `nostalgia-cue` | Nostalgia cue | PH | intermediate |
| `warm-delivery` | Warm delivery | PH | basic |
| `share-your-why` | Share your ‘why’ | PH | basic |
| `celebrate-small-wins` | Celebrate small wins | PH | basic |
| `people-like-us` | ‘People like us’ belonging | EP | intermediate |
| `no-manufactured-outrage` | Avoid manufactured outrage | PH | basic |

### Authority and credibility

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `demonstrate-expertise` | Demonstrate, don't claim, expertise | PH | basic |
| `cite-sources` | Cite sources | EP | basic |
| `numbers-with-context` | Numbers with context | PH | basic |
| `acknowledge-limitations` | Acknowledge limitations | EP | intermediate |
| `credential-in-one-line` | Credential in one line | PH | basic |
| `show-the-process` | Show the process | PH | basic |
| `genuine-social-proof` | Genuine social proof | EP | basic |
| `consistent-claims` | Keep claims consistent | PH | basic |
| `expert-collaboration` | Bring in an expert voice | PH | intermediate |
| `correct-a-misconception` | Correct a misconception | PH | basic |
| `transparent-sponsorship` | Transparent sponsorship | EP | basic |

### Persuasion

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `value-first-reciprocity` | Give value first | EP | basic |
| `contrast-framing` | Contrast framing | EP | intermediate |
| `loss-framing-responsibly` | Loss framing, responsibly | EP | advanced |
| `address-the-objection` | Address the main objection | PH | basic |
| `future-pacing` | Future pacing | PH | intermediate |
| `benefit-over-feature` | Benefits before features | PH | basic |
| `concrete-example` | Concrete example over abstraction | EP | basic |
| `honest-scarcity` | Scarcity only when true | EP | basic |
| `small-commitment-first` | Small commitment first | EP | intermediate |
| `rule-of-three` | Rule of three | EP | basic |
| `shared-enemy-problem` | Unite against the problem | PH | intermediate |

### Conversion

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `one-goal-per-video` | One goal per video | PH | basic |
| `reduce-next-step-friction` | Make the next step easy | EP | basic |
| `offer-clarity` | State the offer clearly | PH | basic |
| `risk-reversal` | Mention risk reversal | PH | basic |
| `proof-near-offer` | Place proof next to the offer | PH | intermediate |
| `match-funnel-stage` | Match the message to awareness stage | PH | advanced |
| `product-in-real-use` | Show the product in real use | PH | basic |
| `honest-price-anchor` | Honest price anchoring | EP | intermediate |
| `specific-testimonial` | Specific testimonial outcomes | PH | basic |
| `real-deadline-urgency` | Urgency tied to a real deadline | EP | basic |
| `lead-magnet-exchange` | Value-exchange lead magnet | PH | basic |

### Calls to action

| Slug | Name | Evidence | Complexity |
|---|---|---|---|
| `single-clear-cta` | One clear CTA | PH | basic |
| `cta-matches-objective` | CTA matches the objective | PH | basic |
| `give-a-reason` | Give a reason to act | EP | basic |
| `cta-after-payoff` | CTA after the payoff | PH | basic |
| `verbal-and-visual-cta` | Say it and show it | PH | basic |
| `low-effort-engagement-cta` | Low-effort engagement CTA | PH | basic |
| `save-for-later-cta` | Save-for-later CTA | PH | basic |
| `share-with-specific-person` | Share with a specific person | PH | basic |
| `soft-cta-trust-content` | Soft CTA for trust-building content | PH | basic |
| `repeat-cta-in-caption` | Repeat the CTA in the caption | PH | basic |
| `story-without-cta` | Let some stories end without a CTA | EX | intermediate |
