# Accessibility remediation extension skeleton

This is a non-executable local-only planning contract; it has no `plugin.json`
or entrypoint. Its 15 assigned records are listed in
[`docs/feature-gap-report.md`](../../../docs/feature-gap-report.md).

The Workflows screen currently stores bounded checks, reports, reading-order,
tag, table, form, link, artifact, alternative-text, language/title, contrast,
Unicode, and permission proposals as local sidecars. No proposal is written to
the PDF or claimed as PDF/UA remediation.

Separately, the trusted host supplies an authenticated, document-bound fixed
`basic-local-review` for at most 200 pages. It reviews Poppler tag, title,
language, font ToUnicode, and empty-extracted-text evidence and exports
deterministic SHA-256-bound JSON. This built-in subset is non-authoritative,
performs no remediation, and is not PDF/UA validation. Alternative text,
reading order, form semantics, contrast, and screen-reader permissions remain
`not-checked`. The skeleton itself remains non-executable.

Permissions/dependencies: inspect and write only the supplied document; a tagging validator is required. Risks: incorrect reading order, destructive tag repair, inaccurate alternative text, and profile-specific validation differences. Acceptance plan: known tagged and untagged fixtures must yield stable findings, repaired fixtures must meet expected tag-tree assertions, and visual text extraction must retain the expected order.
