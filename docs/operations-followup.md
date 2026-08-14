# Operations follow-up

The following work cannot be closed by the local automated suite alone:

- exercise keyboard navigation, screen-reader output, zoom, touch, cancellation,
  and recovery scenarios recorded in [Frontend](FRONTEND.md);
- validate the candidate on another macOS system and on a supported non-macOS
  system with the available optional engines recorded;
- review fixture-only screenshots against their manifest and recapture any stale
  evidence;
- configure the target repository, private security reporting, protected release
  workflow, and release authority;
- provide signing and notarization evidence for any distributed macOS artifact.

Record each completed check with the candidate commit, platform and tool
versions, command or procedure, result, and retained evidence location. A local
inventory receipt remains insufficient for publication until the external and
manual release requirements in [RELEASE_STATUS](../RELEASE_STATUS.md) are
satisfied.

If an operation fails, preserve the typed error and relevant engine versions,
confirm that no output path was overwritten, and check that temporary or
one-shot artifacts were revoked. Do not weaken admission or postflight checks to
force an unsupported document through a writer.
