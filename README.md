# Deluxe Travel database backups

This separate repository can be public. It exports the live Neon database daily, checks the archive, tests recovery in an isolated temporary PostgreSQL database, and encrypts the verified backup before uploading it. Only an encrypted bundle and its ciphertext checksum are uploaded. Encryption is mandatory in public and private repositories alike.

The website continues to run on Render. Repository visibility does not determine who can visit the website.

## Setup

1. Create a separate GitHub repository using the business owner's account. The current repository is `destiny04d-ux/deluxe-travel-backups.`; the final period is part of its name.
2. In that repository, open **Settings → Secrets and variables → Actions → New repository secret**.
3. Set the name to `NEON_BACKUP_DATABASE_URL`. Enter the direct, unpooled connection string for the production database `deluxe_travel_live` privately in GitHub. It begins with `postgresql://`. Copy it from Neon Connect with connection pooling off, or use the working direct `DATABASE_URL` from the Render web service. Do not paste it into code, an issue, a commit, or a chat.
4. Generate a separate random recovery key with `node scripts/generate-recovery-key.mjs` followed by a new absolute destination filename in an existing private folder outside this repository. The generator writes 64 hexadecimal characters from 32 random bytes, never prints the value, and refuses to overwrite an existing file. On Windows, access follows the destination folder's permissions; use a folder restricted to your account.
5. Copy only that key's single line into a second Actions repository secret named `NEON_BACKUP_ENCRYPTION_KEY`. Keep a separate protected recovery copy outside GitHub. Never upload the key file, put it in source, or paste it into chat. It is separate from the application's MFA encryption key and database password. Lost keys cannot be recovered from encrypted backups.
6. Publish this directory's contents on the default branch. `.github` and `scripts` must be at the repository root.
7. Open **Actions → Daily Neon backup → Run workflow**, using the default branch. Start a fresh run after changes rather than rerunning an old revision.
8. Require a successful real run, including the isolated database restore and encryption/decryption checks. Download its artifact and test recovery in a private local folder with the separately saved key before relying on it.
9. Check **Settings → Notifications** in GitHub so failures reach the owner. Check that a fresh successful backup appears daily; a missing run does not necessarily produce an email.

Setup is not complete until the real cloud run and its restore check have passed. Local script tests do not establish connectivity, credentials, permissions, or a successful GitHub-hosted run.

## Schedule and retention

- The intended daily start time is **02:17 Africa/Lagos**, represented as **01:17 UTC**. GitHub can delay or drop scheduled runs, so this is not a guaranteed recovery-point service.
- The manual **Run workflow** button is also available. Only the default branch is accepted.
- Successful artifacts are retained for **14 days**, then GitHub expires them. Deleting a workflow run or repository can also remove its artifacts.
- Download a successful backup periodically to a separately protected location. A reasonable initial routine is one independent copy each week, and another before significant changes.

## Files in a successful artifact

- `deluxe-travel-live.tar.gpg`: GnuPG AES-256 encrypted bundle of the PostgreSQL archive, its original checksum, and the restore verification manifest.
- `SHA256SUMS`: checksum of the encrypted file.

The unencrypted database archive contains private customer information, password hashes, and authentication records. It is never included in the upload paths. On a public repository, other logged-in GitHub users can download the encrypted artifact. Keep the recovery key private. Downloaded encrypted copies can outlive GitHub's retention period. Changing the key affects future backups; retain old keys for older backups. Repository writers can change workflows to access secrets, so restrict write access and review workflow changes.

Credentials are supplied only to the export step. The script uses a temporary protected password file for the PostgreSQL client and deletes it after use. It does not print the connection string, database rows, password, or raw database diagnostics, and it never places these in the artifact directory.

## Export and recovery checks

The runner uses the official `postgres:18-bookworm` image. This major version matches the current Neon PostgreSQL 18 database. The image tag receives upstream patch updates; unlike the pinned GitHub Actions, the container tag is not an immutable digest pin.

Before connecting, the script checks the expected database and direct Neon hostname. TLS uses certificate verification and the container's system trust store. After the dump, it checks the custom archive, required table definitions and data entries, file size, and checksum.

The following step restores into a new, isolated PostgreSQL 18 container with no published port or external network. The original Neon database is not a restore destination. Ownership and privilege mappings are omitted for this test. The temporary test database is discarded afterward.

Encryption requires a passed restore result and matching source files. It bundles the three files with tar, encrypts them with GnuPG, decrypts a temporary copy, and compares it to the original tar before publishing ciphertext. The random key is supplied through standard input, not command arguments or inherited child environments. GnuPG uses an isolated temporary home, ignores default options, and raw diagnostics are suppressed. Temporary plaintext is cleaned up; the hosted runner is disposable if cancellation or machine failure interrupts cleanup.

The upload action names two exact encrypted output files in a separate directory. Missing keys, failed restore checks, or encryption failures have no unencrypted upload fallback. The workflow requires the key and encryption tools before connecting to Neon. The GitHub upload, checkout, and Node setup actions are pinned to reviewed commit IDs. Permissions are read-only, the default branch is required, and no push or pull-request trigger is used. GnuPG and tar are supplied by the hosted runner; preflight stops if they are unavailable.

## Free allowances and growth

The current manual export was about 32 KB. Review the owner's actual GitHub and Neon usage as the database grows; account allowances and other repositories' usage still matter.

The export stops before upload if the compressed archive exceeds **25 MiB**, allowing room for a small rolling backup set. This is a safety limit, not a billing guarantee or a complete account-wide storage cap. Extra manual runs also consume storage. Review the owner's actual GitHub usage and spending controls, and Neon compute/network allowances. No paid plan or spending increase is required by this setup.

## Restore to a new database

1. In a fresh private folder, extract a successful artifact ZIP and verify the encrypted bundle against its `SHA256SUMS`. Use GnuPG to decrypt: `gpg --output deluxe-travel-live.tar --decrypt deluxe-travel-live.tar.gpg`. Enter the matching recovery key privately at the prompt, never directly in command arguments. Require successful decryption with no integrity error before using its output. Inspect and extract the tar, which must contain exactly `deluxe-travel-live.backup`, `SHA256SUMS`, and `manifest.json`. Move the outer checksum aside before extraction because the inner checksum has the same name. Verify the extracted database archive against the inner checksum and review the manifest's successful restore result. Protect extracted files because they contain private customer data.
2. Create a fresh database on a supported PostgreSQL host. Keep the production database intact while testing.
3. In pgAdmin, connect to the fresh destination and choose **Restore** with the custom-format `.backup` file.
4. Leave **Role name** blank. Set **Only data** and **Only schema** off. Under **Do not save**, turn **Owner**, **Privileges**, and **Tablespaces** on. Use **Single transaction** on, one job/default, **Include CREATE DATABASE** off, and **Clean before restore** off.
5. Require a successful restore, compare record counts against that archive, and check representative users, bookings, inventory, and admin login before using the restored database for production.
6. If recovering production, pause application writes for the final switch. Preserve new records created after the backup; switching to an old snapshot can otherwise lose them.

An archive is a snapshot. Authentication/session counts change as the website is used. The migration's old fixed counts are not a permanent expected result for a running database.

## Configuration required beyond the database

A database export does not contain Render's environment settings, source code, payment/email credentials, or external supplier accounts. Preserve the existing **`ADMIN_MFA_ENCRYPTION_KEY`** separately in protected recovery records: the encrypted authenticator secret in a database backup needs that same key. Do not generate a replacement key as a routine restore step.

Retain the application's deployment instructions and current settings, including its normal start command (`npm start`), production environment, website base URL, and required third-party configuration. These records must not be committed here with secret values.

## Buyer handover

Transfer the backup repository together with the application repository and required service ownership. Share existing recovery keys through a private channel. Have the buyer configure their own database connection and a new encryption key, update expected targets when necessary, and pass a manual cloud run plus local recovery test. Retain old keys for existing backups. Review collaborators and spending controls. A dedicated read-only database role can reduce the backup credential's privileges; configure its current and future-table read permissions before replacing the secret.

## Local checks

The scripts use Node.js built-ins and require Node.js 20 or newer. Run the tests without database credentials:

```sh
node --test scripts/*.test.mjs
```

Encryption integration tests use synthetic data with GnuPG and tar when available. The actual backup and recovery jobs require Linux, Docker, network access to Neon, and both private Actions secrets. Full end-to-end operation must be confirmed in the first GitHub-hosted run and a local recovery test with the separately saved key.

## Official references

- [PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)
- [PostgreSQL connection and TLS parameters](https://www.postgresql.org/docs/18/libpq-connect.html)
- [Neon export guidance](https://neon.com/docs/manage/backup-pg-dump)
- [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
- [GnuPG encryption and decryption](https://www.gnupg.org/documentation/manuals/gnupg/Operational-GPG-Commands.html)
- [GnuPG private passphrase input](https://www.gnupg.org/documentation/manuals/gnupg/GPG-Esoteric-Options.html)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
