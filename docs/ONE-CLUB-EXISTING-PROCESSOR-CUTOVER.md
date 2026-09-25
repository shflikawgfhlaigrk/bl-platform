# ONE Club — replace the POS, retain the existing payments setup

Active direction: September 6, 2026. Michael selected reuse of the venue's existing iPad, payment processor/merchant account, and compatible reader and printer. Michael identifies Ingenico payment hardware and a Star printer, and confirms there is no physical cash drawer. Exact device models and processor remain unverified. Replace the departing supplier's POS application with Black Label's ONE Club bar application. No new acquiring-provider agreement or reader purchase is the default path.

**Clarification: complete software replacement on reused hardware.** Black Label supplies the register, back office, data storage, integrations and device configuration. Remove the departing vendor's apps, branding, accounts, service connections and remote access after export and acceptance. Hardware is the reusable foundation; the former vendor's software is not part of the resulting operational system. Retained merchant access is controlled by the venue and connects directly to the processor.

## Device conversion

- Export and verify the venue's business records and close pending payment work before resetting or removing software.
- Inventory the iPad, Ingenico terminals and Star printer. Record the current app/device-management ownership and how each device is provisioned. Physical drawer integration is not required because no drawer is present.
- Remove the old POS and its configuration. For devices enrolled in vendor management, use the authorized administrator's release/unenrollment path and confirm the old vendor no longer has access. Reprovision supported readers through the retained processor rather than treating a payment terminal as an ordinary app installation.
- Install and configure ONE Club's software and venue-controlled accounts. Remove old vendor branding, shortcuts, integrations, notification destinations and remote-support agents that belong to that system.
- Prove that normal service, payment recovery, refunds, reporting and printing work with the departing vendor's app/services disconnected. Keep only the venue's required operating system, hardware drivers/firmware and independently retained processor connection.
- These are on-site conversion steps; no ONE Club device has been reset, unenrolled, uninstalled or reconfigured from this workspace.

## What connects to what

ONE Club iPad → Black Label bar POS/backend → existing processor's approved API or terminal integration → existing provisioned reader → existing merchant settlement account.

The departing POS application is not a permanent dependency. Its APIs may be used for an authorized export/migration, but an integration that requires its continuing subscription does not establish independence after cancellation.

## Identify the three separate relationships

1. POS software supplier and any software subscription.
2. Processor/acquiring provider and the venue's merchant account.
3. Reseller/agent and hardware owner/lessor, if different from either above.

Leaving the POS supplier may or may not end the merchant account, terminal provisioning, hardware lease, or reseller residual arrangement. Confirm these boundaries from the actual agreements/provider before cancellation. No ownership, portability, fee reduction, or transferred residual is currently verified.

## Minimum evidence to collect at the meeting

- Current POS app name and version from the iPad.
- Card reader and printer manufacturer/model labels; hardware ownership/lease details.
- A recent merchant processing statement identifying the provider and fees; the separate POS/software invoice and cancellation terms.
- The manager/admin who controls the merchant account and can authorize integration access.

Previous public/local research did not identify the installed bar POS or processor. The existing Black Label Stripe adapter is not evidence of ONE Club's processor. See ONE-CLUB-CURRENT-POS-CHECK.md.

## Implementation and cutover

1. Ask the current processor whether this exact merchant account and terminal can be used with a custom iPad web POS independently of the departing vendor. Obtain its approved integration documentation, test credentials, reader provisioning requirements and any activation/certification fee. Confirm authorization, tip adjustment, partial payments, refunds, and supported printer control.
2. Build the connector for that verified provider on the existing payment-provider boundary. Keep merchant and reader configuration on the server. Preserve stable transaction IDs, exact amounts, duplicate-request protection, signed callbacks/status reconciliation, and original-payment refunds. No simulated result becomes a live payment.
3. Import the venue's actual menu, modifiers, prices, tax rules and staff mapping from an authorized export. Configure recipes and opening stock where supplied. Deploy the ONE Club service with HTTPS, strict authentication, durable storage, backups and recovery. Complete the bartender screen and service workflows.
4. Test against the existing hardware and actual iPad. Verify a charge, tip, split, decline, timeout recovery, refund, receipt/printer operation, cash close, and transaction visibility under the unchanged venue merchant account. If the processor cannot provide a sandbox for the reader, arrange a supervised, explicitly authorized live pilot.
5. Schedule the switch after a closed batch/shift. Resolve open card authorizations/tabs, unsettled tips, gift cards, refunds, and outstanding balances in their original system unless the provider supports migration. Preserve historical exports and the original transaction references needed for later refunds/disputes.
6. Train staff and keep an agreed rollback path during the pilot. Cancel only the departing software/reseller services that the venue intends to end, once independent payment operation is proven. Do not cancel the retained merchant account or disable credentials still required for settlement/refunds.

## Costs and Black Label revenue

- New hardware purchase: potentially $0, conditional on ownership, compatibility and continued provisioning.
- Existing processing charges continue until the processor separately agrees to change them. Leaving another supplier does not automatically transfer that supplier's residual to Black Label.
- Black Label can charge for its POS software, setup and support. Payment-margin revenue requires a separate written agreement with the existing processor; it is optional for the first software launch.
- Venue monthly saving = canceled software/reseller charges actually removed − Black Label subscription − any new integration charges, plus any separately negotiated processing reduction.
- Basic hosting/storage/backup planning allowance remains $20–$60 per month; internal development/support time and any provider integration fees are additional. This is a budget allowance, not a selected hosting bill.
- Example only: replace a $200/month old POS bill with a $99/month Black Label subscription, with processing unchanged and no new integration fee. The venue saves $101/month. Black Label earns $99/month before hosting/support. Actual bills remain unknown.

## 24-hour target

This removes default reader procurement and new-processor underwriting from the critical path **if** the retained account and hardware are independently usable. A 24-hour pilot can be assessed once the exact provider confirms access and compatibility. It is not currently a confirmed go-live promise: the provider is unidentified, the new bar screen remains under integration, the production service is not deployed, and physical iPad/reader acceptance is outstanding.

If hardware or payment access is locked to the departing POS, get the current processor's re-provisioning or supported-reader path before promising reuse. Do not switch to another processor silently. No account, hardware, payment configuration or vendor service has been changed by this planning update.
