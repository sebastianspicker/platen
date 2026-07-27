# AI extension skeleton

This is a non-executable research-coverage contract; it has no `plugin.json` or
entrypoint. Its 15 cataloged commercial-tool records are listed in
[`docs/feature-gap-report.md`](../../../docs/feature-gap-report.md). AI is
intentionally excluded from the local-only implementation roadmap.

Permissions/dependencies: read and inspect only the supplied document plus a separately approved AI service; an AI provider is required. Risks: disclosure, prompt injection, hallucinated extraction, retention, cost, and non-deterministic output. Acceptance plan: request construction must be fixture-tested with explicit source bounds, policy-denied documents must never leave the process, citations must resolve to supplied pages, and mocked provider responses must yield stable structured outputs.
