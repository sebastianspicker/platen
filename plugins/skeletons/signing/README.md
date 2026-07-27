# Signing extension skeleton

This is a non-executable local-only planning contract; it has no `plugin.json`
or entrypoint. Its 13 assigned records are listed in
[`docs/feature-gap-report.md`](../../../docs/feature-gap-report.md). Remote
routing, live timestamp authorities, online identity verification, and live
revocation fetching are research coverage only and stay outside the local-only
implementation roadmap.

The Workflows screen can record local electronic-signature intent, appearances,
ordered routing, and audit events as sidecars. It never handles a private key,
creates CMS signatures, signs, timestamps, fetches revocation evidence, or
establishes legal identity. Separately from this non-executable skeleton,
`sign.validate-certificate` retains Poppler's integrity/coverage inspection.
Only after Poppler reports valid integrity, a second fixed pass streams each CMS
through an exact pre-created FIFO inventory in a mode-`0500` private directory.
Host readers retain at most 1 MiB per signature and 8 MiB total, aborting on the
first excess byte while FIFO backpressure prevents regular-file growth. A
successful bounded receipt is promoted for mandatory postflight; descriptor-
reading each ByteRange-excluded direct PDF string remains defense in depth. The host digest-binds the result to
Poppler's range and subfilter. An optional digest-pinned
macOS Foundation/Security/CryptoKit helper accepts bounded DER or BER, verifies
that exact detached CMS against the signed byte ranges, and then evaluates Basic
X.509 (`SecPolicyCreateBasicX509`) for every record at one captured host-current
time against the current Mac trust configuration. It disables and verifies
disabled certificate fetching. Unsupported subfilters, malformed CMS/BER,
signature mismatches, and bounded-resource cases fail closed. It
keeps Poppler evidence explicitly scoped and makes the overall conclusion
indeterminate whenever the exact-CMS cross-check is unavailable or incomplete.
Negative records are displayed before positive ones and omitted counts are disclosed. It
does not mean offline/no-Keychain validation, a trusted signer, signer
identity, PDF-signing key usage, signing-time validity, revocation, OCSP/CRL/
LTV, trusted timestamps, DocMDP/certification permissions, legal effect, or
trust on another system. Native parsing is unsandboxed and remains a residual
risk.

Permissions/dependencies: supplied-document read/write, scoped identity use,
and a local platform-keystore signature provider. Risks: key custody, consent
evidence, timestamp trust, revocation handling, and routing replay. Acceptance
plan: deterministic fixtures must verify valid signatures, reject altered bytes
and expired certificates, record ordered local workflow events, and prove that
the plugin cannot access the network.
