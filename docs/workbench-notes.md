# Workbench operations

Platen treats an opened PDF as an immutable source. Browser and CLI operations
create separate artifacts and publish them only after operation-specific
validation. An artifact is not a replacement for its source until the operator
has reviewed it independently.

The loopback host binds to `127.0.0.1` and requires its session token. It stages
private working files, invokes fixed local adapters without a shell, applies
time and size limits, and removes temporary state on success, failure, or
cancellation where the operation contract supports cleanup. Output publication
does not overwrite an existing path.

Optional engines are independent. Use `npm run cli -- engines` to inspect local
availability. Missing engines must return an explicit unavailable result; they
must not trigger downloads or a lower-assurance fallback presented as the
requested operation.

Third-party plugin installation and execution remain disabled. Plugin
manifests and skeletons are planning and diagnostics surfaces only.

For trust boundaries and residual risks, see [SECURITY](../SECURITY.md). For the
component graph and operation-specific validation boundaries, see
[Architecture](architecture.md).
