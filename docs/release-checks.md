# Release checks

Run candidate checks from a clean, trusted checkout with the intended Node and
native toolchain versions available:

```sh
npm test
npm run verify
npm run check:professional-clones
npm run report
npm run release:validate
```

`npm run verify` checks required files, JSON catalogs, the dependency-free
package contract, production-module reachability, native Swift builds on macOS,
and the complete Node test inventory. `npm run report` must agree with the
checked-in generated feature-gap report. The clone check rejects repeated
professional handlers above its configured threshold.

`npm run release:validate` produces a digest inventory and local validation
receipt. A passing receipt is not distribution approval. Signing, notarization,
repository security settings, cross-platform validation, and publication
authority remain separate evidence.

See [Releasing](RELEASING.md) and [RELEASE_STATUS](../RELEASE_STATUS.md) before
creating a tag or distribution artifact.
