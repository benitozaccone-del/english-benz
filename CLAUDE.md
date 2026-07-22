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

-   `english-benz_v2.html` — the whole app, one standalone HTML file. Signs users
    in with email/password (`EB_CONFIG` holds the Supabase URL + anon key).
-   `db/schema.sql` — tables and row-level security. `exercises` is the shared
    content repository; `presentations` tracks per-user "times seen" per exercise;
    `kv` backs the score/activity/queue blobs so existing game logic syncs with no
    change. RPCs: `next_exercises` (least-seen-first) and `record_presentation`.
-   `scripts/generate-content.mjs` — local pipeline; generates exercises via the
    Claude API (Sonnet 5 + web search) and inserts them. The **only** component
    that holds an API key. The browser app never calls the Claude API — it reads
    exercises from the database and falls back to built-in offline packs when
    offline or signed out.

The app degrades gracefully: with `EB_CONFIG` blank (or no connection) it runs
fully offline on `localStorage`.

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
