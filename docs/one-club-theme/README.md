# ONE Club POS theme — 2026-09-06

Implemented throughout the existing POS UI: ONE Club crest/wordmark, navy masthead and navigation, ivory surfaces, gold accents, serif display type, touch controls, sign-in/operator dialogs, guest/event terminology, receipt branding and card labels, PWA title/manifest, home-screen icon, diagnostics filename, and register as the default screen. Public static assets are self-hosted and cached for offline use; no external font or logo request is made by the app.

## Brand source

Official current homepage: https://oneclubgulfshores.com/

Unmodified crest downloaded from https://oneclubgulfshores.com/wp-content/uploads/2026/06/onc-club-logo.png

Live homepage CSS provides navy #181845, taupe #AF9A87, and sage #b3d2b2. The interface uses adapted ivory #f5f3ed and crest-inspired gold #cfad65 for readable operational surfaces. Display typography uses the local Georgia/Palatino/Iowan serif stack. The SVG app icon is a typeset ONE Club adaptation; the iPad touch icon uses the original crest.

## Verification

- 227 test files / 1,586 tests pass; TypeScript, JS syntax, and diff checks pass.
- Real connected Chrome: 1180×820 landscape and 820×1180 portrait; no horizontal overflow; crest loads successfully.
- Navigation, settings, operator switch/sign-in, and the split-payment dialog inspected visibly.
- Disposable demo sale: polo $65 + cap $32 + $8 sample tax = $105; two simulated cards $50 + $55. Saved order EdB3tM-NVi5MyzbhfpLck. The print-media receipt shows the crest, actual demo merchant name, items, both card amounts, and demonstration footer.
- No browser console errors in the observed preview session. Temporary browser viewport, print media, cache and service-worker bypass settings reset.
- Actual local application on port 8468 serves the new theme and is at the existing operator PIN sign-in. The demo on port 8469 is left signed in, with two sample items ready for checkout.

These are iPad-sized Chrome checks. Physical iPad Safari, installation of the home-screen icon, and physical receipt printing were not performed. The theme does not change merchant accounts, processor credentials, order identifiers, existing customers, or transaction history. Actual live-card activation remains the separately documented processor setup task.

## Preview

http://127.0.0.1:8469/#/register — this Mac only. Test PIN 246810. The in-memory demo uses explicitly labeled sample golf-shop inventory/prices and simulated payments; it resets on restart.

Artifacts: ipad-landscape.png, ipad-portrait.png, ipad-split-payment.png, navigation.png, settings.png, sign-in.png, receipt.png, simulated-sale.json, tests.log, typecheck.log, SHA256SUMS.txt.
