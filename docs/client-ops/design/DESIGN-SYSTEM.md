# Black Label Client Operations design system

## Binding visual direction

The client operations product is black and gold. This rule applies to every route, viewport, empty state, dialog, drawer, table, card, form, and loading state.

- Canvas: `#020304`
- Primary panel: `#070a0c`
- Raised panel: `#0d1114`
- Selected panel: `#18170f`
- Border: `#4c3a12`
- Strong border: `#8b6818`
- Primary gold: `#e0b52f`
- Bright gold: `#f1ca46`
- Muted gold text: `#b99742`
- Dim gold text: `#7f6b3b`
- Primary button text: `#090701`
- Critical: `#ff4d4f`
- Warning: `#ff8a24`
- In progress: `#4797ff`

White, ivory, gray-white, and other light content surfaces are prohibited. Green and lime are prohibited, including success and healthy indicators. Healthy, ready, active, complete, verified, and connected states use gold. Red, orange, and blue are reserved for exceptional semantic states and never become brand colors.

## Typography and density

Use Inter when locally available, falling back to `ui-sans-serif`, `-apple-system`, `BlinkMacSystemFont`, and `Segoe UI`. Titles are 28–30 px and bold; section headings are 14–16 px; body and table text are 11–13 px. Gold text must meet contrast on black without shadows or glow.

The desktop shell uses a 216 px sidebar, a 56–64 px utility header, a fluid central workspace, and an optional 300–320 px detail drawer. The spacing rhythm is 8 px. Cards use 1 px borders, 2–4 px radii, and no light drop shadows.

## Component rules

- Navigation: black rail, gold icons and labels, darker charcoal selection with a strong gold left rule.
- Buttons: gold fill with black text for the primary action; black fill, gold border, and gold text for secondary actions.
- Tables: black/near-black header and rows, gold text, gold-brown dividers, and a dark-gold selected row.
- Inputs and selectors: black fill, gold label/value/border, and a bright-gold focus ring.
- Status: gold dot and gold text for normal states; red, orange, or blue only for blocked, at-risk, or in-progress states.
- Drawers and dialogs: near-black surfaces with gold dividers and typography.
- Charts and progress: gold series/fill on black; no white plot area and no green series.
- Artifacts and receipts: black preview frame, gold metadata, and an explicit verification state.

## Reference concepts

- `operator-command-center-concept.png` is the binding command-center composition.
- `service-catalog-concept.png` is the binding services, vertical-packs, engagement-models, and onboarding composition.

Both references use the same full-dark black-and-gold language. Implementation may reflow at smaller widths but must preserve the information hierarchy, visible controls, and exact product names.
