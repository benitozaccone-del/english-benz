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
