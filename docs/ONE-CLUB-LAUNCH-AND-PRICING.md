# ONE Club bar — launch, purchasing, and pricing

Prepared September 6, 2026. Decision packet for the meeting; no merchant agreement, hardware stock, final price, or production launch is confirmed.

**Superseded commercial direction:** Michael now selected retention of the existing processor/account and compatible hardware while replacing the POS supplier. Use [ONE-CLUB-EXISTING-PROCESSOR-CUTOVER.md](ONE-CLUB-EXISTING-PROCESSOR-CUTOVER.md). The new-acquirer purchasing sequence and wholesale examples below are historical alternatives, not current required steps.

## The arrangement

Black Label owns the POS software and charges its own disclosed software fee and agreed payment margin. Request a direct acquiring-provider ISV/agent agreement, with itemized interchange, card-network assessments, acquiring/authorization/gateway charges, and Black Label compensation. Eliminate avoidable reseller and POS-vendor markups. Do not promise that bank/network interchange is the entire cost: the acquiring provider's written quote must establish the remaining charges.

The venue is the merchant, receives its sales proceeds, and supplies its own banking and merchant verification. Black Label receives its agreed fees through the contracted billing/residual arrangement. Alcohol sales, sales tax, and staff tips are venue funds rather than Black Label revenue. A reader purchase alone establishes none of these commercial or settlement arrangements.

## What to obtain at the meeting

- Three recent merchant processing statements, including fee pages, transaction counts, debit/credit mix, refunds, and chargebacks; the separate POS/software/equipment invoices; the current contract and any termination or equipment balance.
- The actual iPad model and iPadOS version, reader/printer model numbers, internet arrangement, number of stations, and who controls the existing merchant account.
- Drink menu and prices; sizes, spirit upgrades, ice/mixer choices; happy-hour rules; applicable tax settings; tipping, comps, voids, and refund policies.
- Manager contact and operating requirements: open card authorizations versus name-only tabs, splitting by seat/item/equal amounts, paper receipts versus digital receipts, tip closeout, printer stations, and outage procedures.
- The venue's authorized representative for merchant onboarding and bank verification. Sensitive details go through the acquiring provider's verified onboarding process.

## Exact acquisition sequence

1. **Black Label + acquiring partner:** request an ISV/agent agreement and a fully itemized wholesale quote. Specify that this is our own iPad web POS, not a request to resell another POS application. Get the fee/residual formula, who controls pricing, residual reporting, portfolio portability, minimums, contract/termination terms, reserves, settlement timing, refund and dispute costs, and treatment of tips in writing.
2. **Partner integration team:** obtain sandbox access, production certification requirements, exact supported reader SKUs/firmware, server/API integration documentation, merchant onboarding path, and confirmation of bar tabs, preauthorizations, incremental authorizations, final tips, splits, reversals, and refunds. Ask which features are supported by that exact API/reader combination.
3. **Hardware:** buy one certified reader from the acquiring partner or its authorized supplier after the API/model is confirmed. Reuse the existing iPad if supported; obtain a stand/power supply and a verified compatible receipt printer/cash drawer only if needed. Confirm purchase price, provisioning/key injection, return terms, and actual local stock. A generic Square/Clover reader is not automatically usable by our app.
4. **ONE Club + partner:** complete merchant underwriting, legal entity/beneficial-owner verification, bank verification, and reader/location assignment. Black Label separately completes the partner agreement. Use their actual approved merchant identity.
5. **Black Label:** finish and test the bar workflows; connect the selected provider adapter; deploy behind HTTPS and strict authentication; configure venue/staff/PINs, durable storage, backups and recovery, tax, menu, recipes, devices, and receipts. Install from Safari using Add to Home Screen, or use a native integration if the selected reader SDK requires it.
6. **Joint on-site pilot:** use the actual iPad/reader/printer. Verify successful and declined card payments, duplicate-tap and timeout recovery, partial cards plus cash, check splits, tips, tab authorization where supported, void/reversal, full/partial refunds, receipt delivery, drawer close, reconnect behavior, and settlement to the venue. Reconcile Black Label's fee separately.
7. **Cutover:** preserve/export history and verify outstanding tabs, gift cards, deposits, and equipment obligations. Train the bartenders, sign off the pilot, schedule a supported shift, then retire the prior setup when all balances and fallback arrangements are resolved.

## How to save them money and retain margin

Compare the same month's card volume and transaction mix under both arrangements.

`Savings = current processing + current POS/software/equipment fees − new wholesale costs − Black Label fees − new fixed/hardware costs`

`Black Label contribution = retained payment margin + software/setup revenue − hosting − support − other costs borne by Black Label`

Use actual fee dollars divided by processed volume to calculate the current effective rate. A headline percentage alone misses authorization fees, monthly minimums, PCI/gateway charges, equipment leases, and bundled software. Include one-time switching costs in first-year savings.

### Illustrative example only — not ONE Club's actual volume or quoted rates

| Monthly item | Assumed amount |
| --- | ---: |
| Card sales | $60,000 |
| Current total processing cost, assumed 3.00% effective | $1,800 |
| New all-in wholesale cost, assumed 2.20% effective | $1,320 |
| Black Label retained payment margin, assumed 0.30% | $180 |
| Black Label POS subscription, proposed for this example | $99 |
| Venue's new monthly total | $1,599 |
| Venue's monthly savings | $201 |
| Black Label monthly revenue before its costs | $279 |

This example assumes no additional current software fee, no extra new fixed charge or hardware amortization, and 100% retention of the illustrated $180 payment margin. Any partner residual split reduces Black Label's retained revenue. Actual underwriting, card mix and fees may change the result. Do not quote 2.20% as an offered rate or $201 as proven savings.

Choose final pricing only after the statement comparison. Leave both a measurable venue saving and sufficient support/hosting margin; do not win the account with a loss-making promise.

## Local hardware contact and direct partner route

**Coastal Merchant Services** — 1240 Commerce Drive, Suite B, Gulf Shores, AL 36542. **(251) 255-2454**. Official site: https://cardreads.com/ and https://cardreads.com/pos-solutions/. Advertises card equipment and interchange-plus pricing. Exact reader/API compatibility, local stock, purchase price and Black Label compensation terms remain quote-required. This is a local sourcing contact, not a confirmed stocked retailer or an established Black Label partner.

**Elavon integrated partner program**, backed by U.S. Bank: https://www.elavon.com/partners/integrated-partners.html. Official page offers ISV solutions, direct certification, integrated and semi-integrated paths, developer documentation, and partner contact. Sales number shown: **1-404-775-8469**, Monday–Friday, 9 AM–7 PM Eastern. This is a verified partnership route; acceptance, price, margin and timeline have not been quoted. Elavon is a processing provider, so its costs must be included transparently rather than represented as card-network fees.

Suggested call wording:

> Black Label is building its own iPad bar POS for ONE Club in Gulf Shores. We want a direct ISV/agent arrangement, an itemized wholesale cost schedule, and our own disclosed merchant markup. Which certified reader and server API support open bar tabs, tips, split payments and refunds? Can you provision that reader locally, and what are the exact underwriting and integration approval steps? Quote every fixed and transaction charge and the residual ownership terms.

No supplier or venue message has been sent.

## Tomorrow and time to live

Tomorrow is **Monday, September 7, 2026, Labor Day**, a Federal Reserve holiday: https://www.federalreserve.gov/aboutthefed/k8.htm. This can affect bank-dependent approval and settlement schedules; it does not mean existing card acceptance stops. Ask each provider about staffing, approval and funding cutoffs.

- **Meeting/tomorrow target:** demonstrate the locally built workflow, obtain the real statement/menu/device facts, agree on a conditional savings proposal, and prepare the venue configuration and hardware order.
- **Live new card processing tomorrow:** only if the correct merchant account is already approved or the provider completes approval, the chosen API is available/approved, a compatible provisioned reader is available, the production service is deployed securely, and the actual payment/refund/device acceptance checks pass. Those prerequisites are not currently established.
- **Fastest interim pilot if the venue requires tomorrow:** run the new ordering workflow alongside the current approved payment setup, subject to an explicit pilot agreement and verified operation. Current payment fees remain during this interim stage; it does not deliver the new processing economics yet.
- **Full switch:** set the date after the partner confirms account approval, certification scope and hardware delivery. The earlier 4–8 week range was a planning allowance for a new partnership/integration, not a vendor quote or a universal waiting period. An already certified integration may be faster; new certification may take longer.

## Current implementation evidence

New shared bar documents/commands, menu/modifiers/recipes, rounds, stock consumption, exact check splits, version checks and payment-order binding have been added locally. The bartender view is being integrated. This is not a claim of a deployed production service or physical iPad/reader acceptance. No ONE Club live charge, refund, settlement, partner residual or hardware purchase is confirmed.
