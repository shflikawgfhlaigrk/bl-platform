# Bar One iPad app and handoff

September 6, 2026. The authoritative status is [Bar One current status](bar-one/CURRENT-STATUS.md).

## Installed application

Signed Release **Bar One 1.0 (12)** is installed on the **iPad (A16), iPadOS 26.6.1**, bundle `com.blacklabel.oneclub.pos`.

Open **Bar One** on the iPad. Choose **Club Manager** and use the existing register PIN when asked. The menu, open tabs, business logic, and SQLite database are on this iPad. No venue-server address is required. The Mac POS server and relay have been retired.

The transfer preserved all 238 tables, including the three existing open tabs and the 80-item menu with 63 verified prices. Seventeen item prices still need confirmation. No tax rate or payment processor was guessed.

Physical acceptance passed menu/sign-in/restart; then, with both Mac services stopped, adding, naming, saving, restarting and recovering a bill. Only the verification tab was canceled. An encrypted backup was created and verified through the iPad Settings screen.

## Storage and recovery

- Active SQLite database: the app's private Application Support/BarOne directory. WAL, full synchronous writes and foreign keys are enabled.
- Operator session and credential encryption key: iPad Keychain.
- Screens and POS engine: signed application resources, loaded without a network server.
- Backup: Settings → Backups → Run backup now. The native adapter creates a consistent encrypted SQLite snapshot and verifies a restored temporary copy before marking it verified.
- Retired Mac data, historical backups and source archive: encrypted recovery archive in the iPad's private app container. The transferred archive passed round-trip checksum and authenticated decryption verification.

Do not delete the installed app to reinstall it: an in-place signed upgrade preserves its data. The first transfer is imported only when no established on-device database exists; later upgrades preserve that database.

## Build and install

Project: `apps/ipad/OneClubPOS.xcodeproj`; scheme: `OneClubPOS`; minimum OS: iPadOS 17.

```sh
node scripts/build-ipad-runtime.mjs
xcodegen generate --spec apps/ipad/project.yml
bash scripts/install-one-club-ipad.sh ACTUAL_IPAD_UDID
```

The install script verifies the selected iPad, rebuilds the bundled engine/UI, signs, and installs in place. A fresh device requires an explicit data transfer; venue records and keys are not embedded in the distributable app.

Native storage: `apps/ipad/Sources/LocalRegisterStore.swift`. Portable engine/SQLite adapter: `apps/ipad/Runtime`. The same POS domain services, RBAC, PIN verification, transactions, idempotency and reconciliation run inside the installed app.

## Remaining venue setup

The Star **TSP143IIILAN** remains configured at **10.1.10.71** and needs a verified physical print. The Ingenico **Lane/3600 CL Ethernet**, previously identified at **10.1.10.248**, still needs its actual merchant integration. No real charge or refund has been submitted. Tax remains unset and payment remains disabled until setup is completed.

The former Cloudflare address and Mac-based hosting instructions are historical. They are not required by build 12.
