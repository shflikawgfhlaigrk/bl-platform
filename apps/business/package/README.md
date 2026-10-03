# BlackLabel Business

One company workspace for customers, scheduling, quotes, invoices, conversations, workflows, files, customer access, team operations, reviews, reporting, and industry configuration.

## Install

This candidate targets Apple silicon macOS and includes its Node runtime and SQLite driver. It starts with empty business data.

Run `./install.sh` from the extracted package. The installer creates a private installation at `~/.blacklabel-business`, registers its own LaunchAgent, and verifies startup. Then visit `http://127.0.0.1:47832`. Your private owner access key is in `~/.blacklabel-business/data/access.token`.

Choose a company name, add your customers, and connect your own email account under Connections. Resend requires your own API key and verified sender. Saving the connection does not send email. Provider admission and delivery are recorded separately in the inbox. An unresolved submission must be reconciled with its existing provider record before another attempt.

For a supervised installation, `./install.sh --root /dedicated/installation --no-service` installs files without starting a service. Set `BLACKLABEL_BUSINESS_DATA` to that installation's `data` directory when starting its `app/start.sh`.

## Customer and team access

Create customer accounts under Customer access. The customer portal restricts every record to the signed-in customer. Only files explicitly shared with a customer appear there. Sign-in email carries a single-use link to this installation.

Add team members, create checklists, assign work, and schedule shifts under Team. Give each employee an individual access key; they sign in at `/team`. Team members can clock in/out, use a local-timezone daily schedule, complete checklists, update work status, add notes, and upload JPEG/PNG/WebP photos. Managers can review team work and add manager comments. Work photos are stored in the file vault and are accessible only through an authorized assignment. Disabling a team member or revoking a key invalidates its access on subsequent requests.

Create review requests under Reviews and share the generated `/review` link with the customer. The form records feedback or opt-out against that specific request.

The default installation is local. For shared customer/team access, point your business hostname at the installation host and provide its TLS certificate and owner-readable private key:

```sh
./install.sh --host 0.0.0.0 --port 8443 --public-origin https://operations.example.com:8443 --tls-cert /private/certificates/fullchain.pem --tls-key /private/certificates/key.pem
```

Use your own hostname and paths. The service verifies the hostname, certificate validity and private-key match before starting. It accepts only the configured HTTPS origin, sets secure session cookies, and bounds streamed upload size and duration. Firewall/DNS reachability and public certificate trust must be checked on a separate customer device before handing over shared access. Upgrades preserve the saved network configuration unless replacement options are supplied.

## Collection and files

Invoices support exact balances and recorded payments. The included collection path gives manual payment instructions; it does not process card payments. Customer uploads store actual bytes, verify the saved content, and support authenticated downloads. The current interface accepts files up to 10 MB.

## Backup, upgrade, and recovery

Backups includes the SQLite snapshot, file vault, installation identity, and encrypted connection settings with the installation keys. Keep the backup in private storage. Each file is hashed; restore verifies archive paths, file hashes, and SQLite integrity before promoting the restored data. The previous data directory is retained.

Create a backup in Backups, or stop this installation and run its `app/start.sh backup`. To restore while stopped, set `BLACKLABEL_BUSINESS_DATA` to the destination data directory and run `app/start.sh restore /path/to/blacklabel-business-backup.tar.gz`.

An upgrade preserves the previous application and makes a backup before replacing it. Failed startup retains the rejected application, restores the prior application and database backup, restores the previous service configuration, and restarts the previous service. Startup is checked against the installation identity and package build. Installation failures produce a private recovery report in the installation directory.

## Candidate status

This is a packaged release candidate. Installation, browser workflows, recovery, provider acceptance, shared access, and customer download must be accepted against the exact archive before commercial release. Consult the accompanying release evidence; an archive alone is not a completed release.
