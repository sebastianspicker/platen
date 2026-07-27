# Frontend product and UX brief

This document describes the browser UI: structure, accessibility expectations,
and remaining manual QA. It is not a marketing brief.

## A. Product and repository understanding

Platen is a dependency-free, local-first PDF workbench. The browser is a
same-origin GUI; a token-authenticated loopback Node host runs bounded Poppler,
Tesseract, Ghostscript/ImageMagick, LibreOffice, and optional macOS PDFKit
adapters. The selected source remains immutable. Operations create validated
derived outputs. There is no remote document upload, telemetry, or AI runtime.

The frontend is a pure JavaScript application (`src/app.js`) with delegated
click, form-change, and form-input routers. State is created by the app-state
module and rendered by pure view functions in `src/ui/`. CSS is split by shell,
editor surfaces, controls, workflows, plugins, and responsive behavior. The
loopback API is accessed through `src/core/local-host-client.js` and route
families; UI controllers own asynchronous lifecycle, cancellation, and artifact
download behavior.

Product type: specialist document inspection and derived-output workbench, not
a consumer document editor or cloud collaboration suite. Current maturity is a
functional alpha. The capability catalog intentionally exposes unavailable
professional functions as planned instead of presenting non-working controls.

Operational constraints:

- local-only processing, immutable source, source- and artifact-bound evidence;
- bounded files, pages, queues, process time, memory, and output sizes;
- destructive or consequential work must create a derived copy and fail closed;
- browser support must include keyboard use, zoom/reflow, and a narrow review
  viewport; native PDF preview remains browser-owned;
- no production dependency additions without an explicit architecture decision.

## B. Audience and task model

| Audience | Goals and frequency | Needs and likely errors | Accessibility implications |
| --- | --- | --- | --- |
| Privacy-sensitive PDF operator (primary) | Open, inspect, search, navigate, export evidence; frequent desktop use | Fast scan of source status and page context; may confuse preview with a saved mutation | Keyboard-first, visible focus, explicit status, no color-only state |
| Prepress, accessibility, OCR, forms, AEC specialist | Run bounded specialist workflow; occasional to frequent | Needs domain vocabulary, limits, validation receipts; risk of assuming a planned capability is executable | Dense tables and grouped controls, clear disabled/unavailable reasons, screen-reader labels |
| Reviewer or support operator | Verify a derived result and recover from failure; intermittent | Needs provenance, source immutability, retry/cancel, and actionable errors | Persistent live status, focus return after rerender, error text adjacent to recovery |
| Novice or occasional collaborator | Open a PDF and understand what is safe | Needs a short path and plain task labels without hiding expert controls | Skip link, semantic landmarks, 390px-safe navigation, 200% zoom/reflow |

Primary journey: open a local PDF, wait for local analysis, scan the proof strip,
navigate pages/search, inspect evidence, then run one explicit derived operation
or download the unchanged source. Secondary journeys are workflow selection and
plugin/capability review. Every journey needs visible loading, empty, success,
failure, cancellation, and retry states.

## C. Current UI/UX audit

### Findings before redesign

- **Navigation and information architecture:** the original shell presented a
  broad tool rail and a toolbar whose labels competed at laptop widths. Mobile
  hid page/search controls and left the user without a stable route context.
- **Layout and hierarchy:** the empty editor used a page-shaped frame with a
  large blank area, pushing the useful first action below the fold. Workflow and
  plugin pages mixed catalog, selection, and execution responsibilities.
- **Typography and color:** labels were small and state meaning depended too
  heavily on low-contrast pills or icon recognition. The visual language did not
  distinguish source evidence from derived operations.
- **Forms, tables, and feedback:** controls were numerous and some unavailable
  operations looked like normal actions. Rerendering could lose focus; errors
  lacked a consistent recovery presentation. Dense data needs explicit labels,
  stable columns, and a status region rather than decorative cards.
- Accessibility: the app had a skip link and some icon labels, but mobile
  navigation and page controls were not consistently reachable; semantic tab and
  live-region relationships were incomplete. Focus and scroll continuity needed
  explicit handling.
- **Responsive behavior and performance:** the pure-render architecture is small
  and dependency-free, but full rerenders can disrupt focus and scroll. A narrow
  review mode must preserve navigation and status without turning the desktop
  inspector into an unusable overlay.
- **Content and consistency:** generic labels such as “submit” or broad feature
  groupings made the product feel like a dashboard template. The product needs
  task-first labels, explicit limits, and one consistent distinction between
  executable, unavailable, and planned capabilities.

### Implemented in this redesign batch

- a persistent application rail and semantic landmarks with a skip link;
- a local proof strip showing source immutability, analysis state, page position,
  and preview mode;
- a bound browser `fetch` default for the loopback client so strict-mode calls
  retain their browser context (`src/core/local-host-client.js`);
- a narrowly scoped `frame-src blob:` CSP allowance for the blob-backed native
  PDF preview (`index.html`), with remote frame origins still rejected;
- grouped editor controls, a compact no-document state, and visible previous/
  next page controls;
- progressive inspector groups for document, create, inspect, edit, review,
  OCR, and runtime concerns;
- workflow runner and capability catalog surfaces with explicit unavailable and
  planned states;
- a project-wide proof-desk shell shared by Workspace, Operations, Coverage,
  and the first-class Trust route;
- visible focus/caret styling, live status, focus restoration, and mobile
  navigation treatment.

### Outstanding or requiring follow-up proof

- manual 390px page-navigation focus now returns to the enabled opposite control;
  full keyboard traversal, screen-reader passes, and contrast measurement still
  need a release checklist run on supported browsers;
- current Platen visual evidence covers all four routes at 1440×1000 and
  390×844; a maintained fixture-only capture command remains a follow-up;
- real two-page mobile page navigation is verified; narrow zoom/reflow, touch,
  and screen-reader coverage remain follow-up checks;
- full app rerenders remain a maintenance risk for future incremental rendering;
- browser-native PDF rendering, clipboard, speech, fullscreen, and optional
  macOS helpers remain platform-dependent.

## D. Design goal and principles

**Design goal:** create a restrained local proof desk for expert, privacy-sensitive
PDF operators. Prioritize opening, inspecting, navigating, evidence review, and
derived-output safety. Preserve specialist depth through progressive disclosure,
make source and system state explicit, and support WCAG 2.2 AA keyboard workflows
at desktop density and a 390px review viewport. The interface should feel like a
calm prepress instrument, not a generic dashboard.

Principles:

1. Evidence and task clarity before decoration.
2. Preserve domain terminology and expert controls.
3. Make source immutability, processing, and output state visible.
4. Use native semantic controls and predictable focus order.
5. Dense where comparison helps; compact where an empty state needs a next step.
6. Interrupt only for consequential or irreversible actions.
7. Reuse small shared patterns; avoid a framework or runtime design-system layer.
8. No ornamental cards, gradients, glass, or motion without information value.

Visual direction: mineral background, paper work surfaces, graphite text, slate
secondary text, proof blue for navigation, registration orange for attention,
and verified green for positive evidence. System UI typography is paired with
monospace evidence labels. The signature element is a functional proof strip,
not a hero panel. Motion is limited to native focus and status changes; honor
`prefers-reduced-motion`.

Non-goals: Acrobat parity, mobile-first replacement of a specialist desktop
workflow, cloud storage/collaboration, AI features, a new component framework,
or hiding planned capabilities behind vague marketing copy.

## E. Prioritized remediation plan

| Priority | User problem and affected workflow | Proposed solution and files | Verification and acceptance |
| --- | --- | --- | --- |
| P0 | Blank shell on startup; viewer callback mismatch (open/inspect) | Align bootstrap viewer callback and add regression coverage in `src/bootstrap/application-bootstrap.js` and tests | App renders on load; bootstrap test and full suite pass |
| P0 | Strict browser calls can lose `this`; blob PDF preview is blocked by CSP | Bind the default browser fetch in `src/core/local-host-client.js`; allow only `blob:` frames in `index.html` | Local host bootstrap and CSP/renderer tests pass; remote frames remain disallowed |
| P0 | Keyboard and mobile users lose route/page access | Persistent semantic menu, skip link, visible focus, live status, page controls; `index.html`, `src/ui/shared.js`, shell/responsive CSS | Keyboard route traversal and 390px reachability pass; no hidden critical action |
| P1 | Empty editor consumes operational space | Compact no-document state and explicit open/drop action in `src/ui/editor-view.js` and editor surface CSS | First action visible above fold at desktop and 390px |
| P1 | Toolbar overload and ambiguous capability state | Group controls; keep executable actions visible, move specialist controls into inspector, label planned/unavailable states | No overlap at 1280/1440; labels and accessible names remain complete |
| P1 | Source, analysis, and preview state are implicit | Proof strip and persistent status bar | Open/loading/error/ready states announce actionable status |
| P2 | Workflows and plugin catalog mix selection with execution | Separate workflow runner and capability family/detail views | Selection is keyboard-reachable; unavailable operations explain why |
| P2 | Full rerenders disrupt focus/scroll | Capture stable focus and indexed scroll identity around renders | Input caret and multiple scroll containers restore to the same element |
| P2 | Documentation and visual evidence drift | Add this brief and screenshot manifest under `docs/` | Docs describe implemented vs planned; manifest records provenance |
| P3 | Future consistency and regression visibility | Add browser capture and contrast/keyboard checks without adding runtime deps | Repeatable local capture and release checklist are documented |

## F. Proposed target structure

Navigation remains shallow: `Workspace`, `Operations`, `Coverage`,
and `Trust`. Workspace is the default route and keeps document tabs,
the tool rail, page navigation, document stage, and inspector in a stable
landmark layout. Trust & Limits is a real read-only route for the processing
boundary, execution policy, source guarantees, and explicit alpha limits. On
narrow screens all four routes remain reachable; page navigation and search stay
in Workspace rather than being hidden behind a desktop-only rail.

Page patterns:

- editor: proof strip, preview surface, page controls, status bar, inspector;
- workflows: capability family list plus a narrow selected-operation runner;
- capability ledger: declarative catalog with family, support state, limits,
  and detail, never an executable marketplace;
- trust and limits: current local status, immutable-source guarantees,
  processing boundaries, execution policy, and known alpha limits;
- errors: focused banner with recovery action and live status;
- loading/empty: concise task-first message with one clear next action.

Shared patterns are limited to navigation, rail, toolbar groups, proof items,
status actions, inspector disclosure groups, field labels/help, and capability
state badges. Tables remain tables when row/column comparison is useful. Forms
must use persistent labels, adjacent validation, explicit required state, and
cancel/retry behavior. Destructive operations must say what is derived and what
remains unchanged.

## G. Design-system proposal

Keep the existing dependency-free CSS architecture. Standardize only:

- color, spacing, border, focus, radius, and surface tokens in `styles/foundation.css`;
- system UI and monospace evidence typography;
- 36px minimum controls, visible focus, status semantics, and reduced motion;
- button, icon-button, field, status, disclosure, proof-strip, and table patterns.

Keep specialist inspector sections and workflow forms local to their domain.
Refactor only where behavior or accessibility recurs. Do not add a component
library, CSS-in-JS runtime, icon package, animation package, or generic Box/Stack
abstraction. Existing SVG icons stay inline and must retain accessible names.

## H. Implementation batches

## H. Implementation batches

1. **Shell and accessibility foundation** - startup render fix, landmarks,
   navigation, focus/scroll continuity, status/error primitives. Tests cover
   bootstrap, shell semantics, reachability, and restoration.
2. **Editor proof desk** - toolbar grouping, proof strip, compact empty state,
   page controls, inspector disclosure, responsive editor layout. Tests cover
   editor rendering, controls, and no-document behavior.
3. **Workflow, capability, and trust surfaces** - task-first workflow runner,
   declarative capability ledger, and first-class Trust & Limits route. Tests
   cover routing, selection, unavailable states, and preserved operation actions.
4. **Evidence publication** - the manifest and eight Platen captures cover
   every route at 1440px and 390px, use only a generated fixture or the
   no-document state, and record browser, viewport, route, source, and
   timestamp.
5. **Release QA follow-up** - keyboard/screen-reader, contrast, reduced-motion,
   real multi-page fixture, and performance checks. No framework or backend
   migration is included.

## I. Validation checklist

- [x] primary open, two-page local analysis, route changes, and native blob PDF
  preview verified; search, export, and every derived workflow remain broader
  follow-up coverage;
- [x] focused focus/scroll restoration tests pass, including route and shell
  reachability checks; manual 390px next/previous page focus is verified without
  BODY focus or console/page errors; full keyboard and screen-reader passes remain;
- [ ] WCAG 2.2 AA contrast and non-color state cues measured;
- [x] desktop 1440px and 390px layouts render without horizontal overflow;
  real two-page mobile open, analysis, page 1 to 2 controls, and native preview
  width are verified; zoom/reflow and touch remain unchecked;
- [x] empty and no-document route states verified;
  [ ] backend error, permission denial, cancellation, retry, and recovery states
  still need manual coverage;
- [ ] destructive/derived actions state consequence and source preservation;
- [x] browser-native preview was verified and clipboard, speech, fullscreen, and
  optional native-helper limitations are documented;
- [ ] Confirm `npm test`, `npm run verify`, and `npm run release:validate` on
  the candidate commit. Distribution remains not ready until signing,
  notarization, and SBOM evidence are supplied;
- [x] screenshot manifest matches the checked-in images and fixture provenance;
- [x] this document and screenshot README are updated with the final release
  evidence.

## Local development and testing

```sh
npm run dev       # serve the browser GUI on the local loopback host
npm test          # Node test suite
npm run verify    # tests, source reachability, catalogs, zero dependencies
npm run release:validate
```

No npm dependencies are declared. Browser-rendered QA may use a locally
installed Chromium/Playwright harness; it is not a runtime requirement. The
former screenshot set was retired because it displayed the previous product
name. The replacement set was captured on 2026-07-24 with Google Chrome
150.0.7871.182, the real local application composition, and an in-process
request harness that required no listening server. It covers desktop and 390px
routes, the generated two-page fixture, the no-document states, horizontal
overflow, and browser console output. Reproducible fixture capture automation
remains a follow-up release-QA task.

## Known limitations

The alpha does not claim general PDF editing, sanitization, signature legality,
PDF/UA or WCAG document conformance, arbitrary mobile parity, remote
collaboration, or third-party plugin execution. Browser-native PDF behavior and
optional macOS PDFKit behavior vary by platform. Full screen-reader and color
contrast evidence still requires the release QA pass noted above.
