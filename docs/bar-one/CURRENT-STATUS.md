# Bar One on the physical iPad

Verified September 6, 2026. **Standalone iPad POS installed. The POS engine, UI, database, sessions, and printing bridge run on the iPad. Live card acceptance and physical printing remain unverified.**

- Signed Release build **12**, `com.blacklabel.oneclub.pos`, is installed on iPad `00008120-000C085E3CE00032`.
- The app opens bundled `barone://register` resources and runs the existing POS business engine against native SQLite. The Mac server and relay launch agents are removed, and the former venue database, keys, backups and temporary transfer copies have been removed from the Mac after iPad verification. The old web address is no longer the app runtime.
- The actual venue menu now contains **80 items with 63 verified prices**. Nineteen previously missing prices were filled and thirty cocktail/nonalcoholic items were added from the signed-in GN Pro catalog. Existing priced items were preserved. Seventeen exact products or variants still lack a verified price.
- GN Pro's **Bar One** category establishes Chicken Tenders at **$13**. Its general catalog also contains an $8.50 item with the same name; that ambiguous row was not used. Brand variants and unidentified wines were not assigned guessed prices.
- Physical iPad acceptance passed for the breakfast menu, recipe search, returning to Service, and the imported cocktail prices. The main screen has Service, Bar & kitchen, Drink guide, Menu & stock, and Setup. Cash shift controls are inside Setup.
- **Add saves items to the selected bill**, or starts a saved Walk-in tab when no tab is open. Quantity, preparation notes, priced side upgrades, and optional drinks/extras save together. The iPad's Add button remains visible while the modifier choices scroll.
- **Name bill** saves each bill's guest/group name; the name appears on the check and tab list, is searchable, and is included in the receipt's order snapshot. Opening a tab also accepts an optional bill name.
- Draft items now save before tax setup and explicitly show **Pending setup / Before tax**. Sending, splitting, and payment stay disabled until the tax rate is configured. The live physical check saved a $14 burger, $2 onion-ring upgrade, and $1.50 water, then renamed the bill to **Michael verification**. Verification tabs were canceled without sending orders or payments.
- **Save & next** stays fixed at the bottom of the right-hand bill panel. It confirms the saved tab, leaves it open in the left-hand list, and clears the right-hand side for the next guest. That selection survives refresh/reload; the next item creates a separate tab. A failed confirmation keeps the current bill selected.
- The register now uses independent menu, tab, and bill scrolling, with fixed totals/actions. Saves no longer rebuild the screen while pending, unchanged polling preserves the existing controls, and changed data restores scroll positions. Native iPad overscroll bounce is disabled. Addition messages appear above the workspace and do not intercept taps.


## Standalone iPad transfer

Build 12 passed physical sign-in, menu, and application-restart checks. After unloading both Mac launchd services and verifying port 8480 was closed, a second physical test added an item, named the bill, saved for the next guest, restarted the app, recovered the saved bill, and canceled only that verification tab. The three original open tabs were preserved.

The original SQLite transfer contained 238 tables. Its SHA-256 matches the iPad import receipt, and a full SQL dump comparison proved the Mac database had not changed during transfer. The retired host, earlier backups, app sources, and configuration were packed into an AES-GCM recovery archive, transferred to the iPad private app container, downloaded for verification, and authenticated/decrypted to the exact original archive.

The portable engine also passed browser acceptance with network access disabled: add, bill naming, Save & next, database reopen, session recovery, and back-office API reads made zero network API requests. SHA-256, HMAC, PIN scrypt and AES-GCM were checked against Node's implementations, including tamper rejection. Native-runtime TypeScript checking and 54 targeted regression tests passed.

A third physical test created and verified an encrypted backup through Settings with the Mac services off. Independent decryption of that iPad-created backup passed SQLite integrity and foreign-key checks; all 89 original venue documents matched exactly, the 80-item menu and three original open tabs remained, and orders/tenders were still zero. The verification copy was then removed from the Mac. [Transfer verification](ipad-transfer-verification.json), [Mac retirement](mac-retirement.json), and [recovery archive](ipad-recovery-archive.json) record the completed transfer. Development source remains in the shared checkout.

Evidence: [standalone build](ipad-standalone-build.json), `.storage/bar-one-native-menu12.xcresult`, `.storage/bar-one-native-mac-off12.xcresult`. Prior build 10 results below are historical.

## Printer and payment terminal

The photographed receipt printer is **Star TSP143IIILAN**, an Ethernet model. GN Pro has it assigned to Main Printer and Cold Station at **10.1.10.71**, showing **Disconnected**. Direct TCP checks found no responding host there, and the actual iPad's Star SDK returned **Device not found**. Bar One's guest/bar/kitchen role controls and direct-IP connection path passed physical UI checks. No paper receipt has been sent.

The photographed **Ingenico Lane/3600 CL Ethernet** is at **10.1.10.248**; its ARP MAC matches the hardware label. This establishes network presence. The merchant processor and supported integration remain unconfigured. GN Pro is separately set to **Moby 5500 Bluetooth** and reports **Terminal Error**. No real charge or refund has been submitted.

## Software verification

The complete disposable service walkthrough passed food/drink routing, split checks, partial card plus cash, change, refund, receipt reprint, cash reconciliation, stock deduction, and recovery after a lost response without duplicate business action. Those payments and printers were simulated. Closing a tab now selects another open tab instead of leaving the closed check active.

Printing uses the official Star SDK and raster receipts for this graphics-only TSP100III model. A durable journal preserves acknowledgements and uncertain outcomes across restarts, separates station assignments, and prevents automatic retry of uncertain sends. Receipts include quantities, totals, cash/change, and original transaction IDs.

The earlier full suite passed 1,608 tests. Subsequent printing/service-worker checks passed 10 tests; native raster/journal checks passed 5 tests. The final physical menu and printer-control checks passed. These checks do not establish a successful physical print or live card payment.

The Add/upsell/named-bill changes passed 28 targeted tests and TypeScript checking. Browser acceptance verified automatic first-item tab creation, quantities and modifiers, persisted names after reload, tab search, and cancellation. Physical iPad acceptance and independent venue-database checks verified the exact item prices and saved bill name. The final browser service walkthrough also passed with simulated payments and printers. Evidence and deployed source hashes are recorded in [add-upsells-bills-2026-09-06.json](add-upsells-bills-2026-09-06.json).

Build 10 passed physical iPad Save & next acceptance: the button remained hittable, the menu stayed in place after adding, and the named tab reopened with its items. Browser frame sampling measured **0 px menu movement and 0 px footer movement** during a delayed save; scroll and unchanged polling remained stable. Save & next passed reload, separate-next-tab, failed-confirmation, landscape, and portrait checks. The service walkthrough passed again with simulated payments/printing. The two user-opened venue tabs were preserved; only the exact verification tabs were canceled. Current evidence is [save-next-stability-2026-09-06.json](save-next-stability-2026-09-06.json).

## Remaining venue inputs

1. Restore the Star printer's Ethernet link or obtain its current network-test address.
2. Identify and enable the retained merchant processor's integration for the photographed Lane/3600.
3. Confirm the food/drink tax rate. Tax is unset, so the live register currently disables payment tenders.
4. Confirm seventeen remaining exact item prices and staff accounts, house pours/stock mappings, and off-device backup arrangements. Hosting is now on the iPad.

The venue database was backed up after the menu import and its integrity verified. Evidence, source hashes, physical test bundles, menu provenance, and remaining prices are recorded in [current-acceptance-2026-09-06.json](current-acceptance-2026-09-06.json).
