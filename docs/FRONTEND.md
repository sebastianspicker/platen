# Frontend

Platen’s browser UI is a dependency-free, same-origin interface for local PDF
inspection and derived-output workflows. It is a browser adapter, not a host
layer: `src/browser/main.js` bootstraps browser state, controllers, views, and
styles, then calls loopback HTTP clients. It never imports host implementations.

## Current boundaries

- The host binds to loopback and uses a session token. Browser requests reach
  `src/host/transport/http/`, which owns HTTP-specific validation and routing.
- Sources remain immutable. The UI presents separate derived artifacts and
  their validation/provenance rather than treating outputs as source updates.
- The browser owns rendering, keyboard interaction, cancellation presentation,
  status, and artifact-download interaction. Application behavior belongs to
  the host’s `application/` layer.
- Capability and workflow views must distinguish executable, unavailable, and
  planned states. Catalog metadata is not an executable marketplace.

## Interaction requirements

- Keep a keyboard-reachable skip link, landmarks, visible focus, live status,
  and explicit error/retry or cancellation states.
- Preserve page navigation and document context at narrow widths and at 200%
  zoom. Browser-native PDF preview remains browser-dependent.
- Use semantic controls, persistent form labels, adjacent validation, and text
  in addition to color for state.
- Keep the dependency-free JavaScript and CSS structure. Do not add a component
  framework, remote client, telemetry, or runtime design-system dependency
  without an explicit project decision.

## Local checks

```sh
npm run dev
npm test
npm run verify
```

Manual browser QA remains necessary for keyboard traversal, screen readers,
contrast, narrow layouts, zoom/reflow, browser-native preview, and platform
specific capabilities.
