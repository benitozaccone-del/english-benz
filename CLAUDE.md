# CLAUDE.md

# English Benz

## Purpose

English Benz is a personal English-learning application designed to
evolve over time. The goal of this document is **not** to constrain
development, but to help future contributors (human or AI) understand
the project's intent, architecture, and design philosophy.

Whenever requirements conflict with this document, **follow the user's
request** and update this document accordingly.

------------------------------------------------------------------------

# Vision

English Benz should feel like a premium learning experience:

-   fast
-   focused
-   enjoyable
-   highly personalized
-   inexpensive to run

Every new feature should improve learning value while keeping the
experience simple.

------------------------------------------------------------------------

# Current Architecture

This section documents the current implementation.

It is descriptive rather than prescriptive and may change over time.

Current major modules:

-   Home
-   Phrasal Verbs
-   Translation
-   Audio
-   Statistics

New modules can be added whenever they improve the product.

## Backend (added after the Artifacts phase)

The app moved from a claude.ai Artifact to a self-contained page backed by
**Supabase** (free Postgres + Auth):

-   `index.html` — the whole app, one standalone HTML file. Signs users
    in with email/password (`EB_CONFIG` holds the Supabase URL + anon key).
-   `db/schema.sql` — tables and row-level security. `exercises` is the shared
    content repository; `phrasal_verbs` + `phrasal_verb_examples` hold the phrasal
    verb game; `source_documents` keeps the raw text everything was generated from;
    `presentations` tracks per-user "times seen" per exercise; `kv` backs the
    score/activity/queue blobs so existing game logic syncs with no change.
    RPCs: `next_exercises` (least-seen-first), `record_presentation`,
    `next_phrasal_verbs` (pool for one game mode, examples inlined).
-   `scripts/generate-content.mjs` — local pipeline; searches the news, stores what
    it found, then generates translation, listening and phrasal-verb content. Holds
    an API key.
-   `scripts/migrate-phrasal-verbs.mjs` — one-off; moved the original hard-coded
    verbs out of `index.html` into the database.
-   `supabase/functions/generate-exercises/` — admin-only Edge Function behind the
    in-app Admin panel. Modes: `document` (PDF text), `url`, `news`, `reuse`, `list`.

The browser app never calls the Claude API — it reads from the database and falls
back to built-in offline packs when offline or signed out. With `EB_CONFIG` blank
(or no connection) it runs fully offline on `localStorage`.

### Design decisions worth keeping

-   **Two tables for phrasal verbs, not one.** A verb's meaning and CEFR level are
    written once; usage examples accumulate every time the news pipeline finds that
    verb in a real sentence. Splitting them lets news enrich a known verb without
    touching it.
-   **`categories` is a `text[]`, and the tiers overlap on purpose.** The top-200
    list is a superset of the top-100 one, so a core verb carries both tags. A
    category filter is then a single array containment test rather than a union.
-   **Raw material is stored before anything is generated from it.** Every
    generated row carries a `source_document_id`, so a PDF uploaded once can be
    mined again months later without re-uploading, and any exercise can be traced
    back to the text it came from.
-   **`source_documents` has RLS on and no read policy.** Ingested text can be
    private, so only the service role (pipeline, Edge Function) can read it. The
    admin panel lists documents through the Edge Function, never directly.
-   **The news search is guarded against fabrication.** Search output is accepted
    only as `<outlet> | <topic> | <sentence>` lines; if none come back the run
    fails loudly. An earlier version passed the model's apology prose to the
    formatting stage, which then invented quotes and attributed them to real
    outlets. Search by *topic*, never by outlet name — searching "stories by BBC
    News" returns pages about the BBC, not article text.

------------------------------------------------------------------------

# Engineering Principles

When making implementation decisions, prefer solutions that are:

1.  Easy to understand.
2.  Easy to extend.
3.  Easy to debug.
4.  Efficient to run.
5.  Compatible with Claude Artifacts unless the project intentionally
    moves elsewhere.

When multiple solutions satisfy the requirements, prefer the simpler
one.

------------------------------------------------------------------------

# API Philosophy

The application currently relies on Claude for some exercise generation.

General principles:

-   Batch work whenever practical.
-   Reuse generated content when possible.
-   Avoid duplicate requests.
-   Keep prompts concise.
-   Treat API calls as valuable resources.

These are optimization goals---not rigid rules.

------------------------------------------------------------------------

# User Experience

Prioritize:

-   responsiveness
-   clarity
-   low waiting time
-   consistency

Do not redesign the interface unless the requested feature naturally
requires UI changes.

------------------------------------------------------------------------

# Storage

User progress is important.

Before modifying persistence:

-   understand the existing storage model
-   preserve user data whenever practical
-   document migrations if a breaking change becomes necessary

------------------------------------------------------------------------

# Extending the Application

New sections are encouraged.

Examples:

-   vocabulary trainer
-   writing practice
-   pronunciation coach
-   listening challenges
-   grammar
-   reading comprehension

When adding a feature:

-   integrate naturally with existing navigation
-   reuse existing utilities where appropriate
-   avoid duplicating logic without a good reason

------------------------------------------------------------------------

# Refactoring

Refactoring is welcome when it clearly improves:

-   readability
-   maintainability
-   performance

Avoid large rewrites unless they provide substantial long-term value or
are explicitly requested.

------------------------------------------------------------------------

# Documentation

When architecture changes significantly:

-   update this file
-   explain important design decisions
-   document non-obvious trade-offs

Treat this file as a living engineering guide.

------------------------------------------------------------------------

# Validation

Before considering code complete:

-   verify JavaScript syntax (`node --check`)
-   think about regressions
-   explain any trade-offs introduced

------------------------------------------------------------------------

# Decision Framework

When uncertain, optimize for:

1.  Better learning outcomes.
2.  Better maintainability.
3.  Lower operational cost.
4.  Simplicity.
5.  Future extensibility.

If these priorities change, update this document rather than forcing
future work to fit outdated assumptions.
