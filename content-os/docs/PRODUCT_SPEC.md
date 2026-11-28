# Product Spec — Content OS

> **Status: DRAFT, reconstructed from the Phase 1 implementation brief. Not yet approved.** No approved `PRODUCT_SPEC.md` existed in the repository. This captures only what the Phase 1 brief stated. Product owners should replace or confirm it.

## Vision

Content OS is a commercial, multi-tenant SaaS for producing short-form content. A team works in a **workspace** tied to **one Instagram account** and moves content through these stages: Discover → Analyze → Script Lab → Video Studio → Experiments → Publish → Analytics.

## Personas (inferred)

- **Owner.** Creates the workspace and is responsible for billing.
- **Admin.** Runs production, manages the team and the Instagram connection.
- **Member.** Contributes to production and has read access to configuration.
- **Platform admin.** Content OS staff who need read-only visibility across tenants.

## Phase plan

| Phase | Scope | Status |
|---|---|---|
| 1. Foundation | Auth, workspaces, roles, dashboard, settings, Instagram connection foundation, plans, credits ledger, admin panel | **Implemented** (see IMPLEMENTATION_STATUS.md) |
| 2+ | Discover, Analyze, Script Lab, Video Studio, Experiments, Publish, Analytics, billing, email delivery | Not started. These appear in the navigation marked "Coming soon". |

## Phase 1 functional requirements

The acceptance criteria are those in the Phase 1 brief. They are tracked one by one in IMPLEMENTATION_STATUS.md.

## Product rules

- One Instagram connection per workspace (enforced by a unique constraint in the database).
- Every metered feature consumes **credits** from a workspace balance. Every change is recorded in an append-only ledger.
- Future modules must be visibly marked "Coming soon". No fake functionality or fabricated metrics.
