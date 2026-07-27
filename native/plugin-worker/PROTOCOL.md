# Native plugin-worker protocol v1

`PDFPluginSupervisor` uses two ordered stdin phases. Phase 1 is a canonical
UTF-8 preparation header, one newline, and exactly `sourceBytes` raw
classic-script bytes. The header has exactly these fields:

```json
{"packageHash":"<sha256>","pluginId":"org.example.plugin","sourceBytes":42,"sourceSha256":"<sha256>","version":"1.0.0"}
```

The supervisor spawns the adjacent worker but does not release source bytes.
It first validates inherited anonymous RPC descriptors 3 and 4, receives the
worker's quota evidence, validates static and live signing identity, and emits
one bounded four-byte-big-endian framed canonical `ready` attestation on
stdout. A host must reject that attestation unless it matches its separately
signed release policy and all hard-control fields are `true`.

Only after that host check does phase 2 send the canonical header
`{"controlBytes":527}`, one newline, and exactly that many unframed canonical
worker-control bytes before closing stdin. The invocation is the existing
`plugin-worker-control` `invoke` envelope,
including `pluginId`, `version`, `packageHash`, `activationId`, `operationId`,
`nonce`, `capability`, `documentHandle`, and JSON-only `input`. It is never
weakened or duplicated by the native boundary. The raw source is therefore
identified only by its pre-verified package hash and arrives only as bytes;
there is no source/package/document path in stdin JSON, argv, or environment.

Before the supervisor releases source/control bytes, it verifies the spawned
worker's static designated requirement, exact App Sandbox entitlement policy,
and live PID guest identity. An unsigned SwiftPM worker always fails this
normal path. The only development route is `--self-test-worker`, which invokes
the worker's `--self-test` process path and still applies its hard rlimits.

The ready frame has exactly these fields: `schema` (`pdf-plugin-native-attestation-v1`), `protocol`, `type`, `pluginId`, `pluginVersion`, `packageHash`, `sourceSha256`, `supervisorPid`, `workerPid`, `teamIdentifier`, `supervisorCdHash`, `workerCdHash`, `designatedRequirementSha256`, `staticCodeIdentity`, `liveCodeIdentity`, `appSandbox`, `noNetwork`, `cpuQuota`, `hardMemoryQuota`, `processQuota`, `outputQuota`, `privateIpc`, and `sourceBytesOnly`. `designatedRequirementSha256` is the SHA-256 of the exact team-pinned supervisor and worker requirement texts. A `false` hard-control flag is a denial of execution authority. In particular, this macOS host reports `hardMemoryQuota: false` because `RLIMIT_AS` returns `EINVAL`; the supervisor can attest the limitation but must not imply it is execution-ready.

The supervisor owns private source/control/result pipes and invokes the worker
with descriptor-number arguments only. After the ready frame, stdout carries
exactly one bounded four-byte-big-endian framed canonical `completion` or
`failure` control envelope and then closes. It never creates or accepts a named
connection.

Host-supplied inherited descriptors 3 (worker-to-host) and 4 (host-to-worker)
carry only the existing bounded `plugin-rpc-contract` frames. The worker exposes
one synchronous API to classic scripts:

```js
platenHost.call("document.getMetadata", {})
platenHost.call("document.readRange", { offset: 0, length: 1024 })
```

The bridge injects the invocation's opaque `documentHandle`, preserves the RPC
session binding, and allows only those two brokered methods. It provides no
filesystem, network, process, Node, browser, WebAssembly, `eval`, or `Function`
API. It also rejects ESM `import`/`export` syntax and requires exactly one
`registerPlugin({ invoke: arrowFunction })` registration.

## Packaging

Both executables must be embedded in an App Sandbox application with the exact
entitlements in `Entitlements/`; do not add network, temporary-exception,
user-selected-file, or inherited-file-read entitlements. Release packaging
must enable the hardened runtime, sign both nested executables and validate
their designated requirement using the release Team ID. SwiftPM builds are
development artifacts, not production-signed binaries.
