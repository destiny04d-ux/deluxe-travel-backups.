# Deluxe Travel database backups

This separate, private repository exports the live Neon database daily, checks the archive, tests recovery in an isolated temporary PostgreSQL database, and stores the successful backup as a private GitHub Actions artifact.

The website continues to run on Render. This repository does not deploy or change the website.

## Setup

1. Create an empty **private** GitHub repository named `deluxe-travel-backups`, using the business owner's GitHub account.
2. In that repository, open **Settings → Secrets and variables → Actions → New repository secret**.
3. Set the name to `NEON_BACKUP_DATABASE_URL`. Enter the direct, unpooled connection string for the production database `deluxe_travel_live` privately in GitHub. It begins with `postgresql://`. Copy it from Neon Connect with connection pooling off, or use the working direct `DATABASE_URL` from the Render web service. Do not paste it into code, an issue, a commit, or a chat.
4. Publish this directory's contents on the repository's default branch. `.github` and `scripts` must be at the repository root.
5. Open **Actions → Daily Neon backup → Run workflow**, using the default branch.
6. Confirm that the first real run succeeds, including the isolated restore step. Download its artifact and retain a copy outside GitHub.
7. Check **Settings → Notifications** in GitHub so failures reach the owner. Check that a fresh successful backup appears daily; a missing run does not necessarily produce an email.

Setup is not complete until the real cloud run and its restore check have passed. Local script tests do not establish connectivity, credentials, permissions, or a successful GitHub-hosted run.

## Schedule and retention

- The intended daily start time is **02:17 Africa/Lagos**, represented as **01:17 UTC**. GitHub can delay or drop scheduled runs, so this is not a guaranteed recovery-point service.
- The manual **Run workflow** button is also available. Only the default branch is accepted.
- Successful artifacts are retained for **14 days**, then GitHub expires them. Deleting a workflow run or repository can also remove its artifacts.
- Download a successful backup periodically to a separately protected location. A reasonable initial routine is one independent copy each week, and another before significant changes.

## Files in a successful artifact

- `deluxe-travel-live.backup`: compressed PostgreSQL custom-format archive.
- `SHA256SUMS`: integrity checksum of that archive.
- `manifest.json`: non-secret export metadata and restore verification result.

The database archive contains private customer information, password hashes, and authentication records. It is compressed, **not separately encrypted by this project**. Keep repository and downloaded-file access restricted. Repository readers can download artifacts; repository writers can change workflows and access repository secrets through them.

Credentials are supplied only to the export step. The script uses a temporary protected password file for the PostgreSQL client and deletes it after use. It does not print the connection string, database rows, password, or raw database diagnostics, and it never places these in the artifact directory.

## Export and recovery checks

The runner uses the official `postgres:18-bookworm` image. This major version matches the current Neon PostgreSQL 18 database. The image tag receives upstream patch updates; unlike the pinned GitHub Actions, the container tag is not an immutable digest pin.

Before connecting, the script checks the expected database and direct Neon hostname. TLS uses certificate verification and the container's system trust store. After the dump, it checks the custom archive, required table definitions and data entries, file size, and checksum.

The following step restores into a new, isolated PostgreSQL 18 container with no published port or external network. The original Neon database is not a restore destination. Ownership and privilege mappings are omitted for this test. The temporary test database is discarded afterward. The archive is uploaded only after the recovery check succeeds.

The GitHub upload action, checkout action, and Node setup action are pinned to reviewed commit IDs. The workflow has read-only repository permissions, does not run for pull requests or pushes, and refuses a public repository.

## Free allowances and growth

The current manual export was about 32 KB. At that size, fourteen daily copies are small relative to GitHub Free's currently documented 500 MB artifact allowance. The allowance is shared with GitHub Packages and other repositories; account usage still matters. GitHub Free currently documents a shared monthly compute allowance rather than unlimited execution.

The export stops before upload if the compressed archive exceeds **25 MiB**, allowing room for a small rolling backup set. This is a safety limit, not a billing guarantee or a complete account-wide storage cap. Extra manual runs also consume storage. Review the owner's actual GitHub usage and spending controls, and Neon compute/network allowances. No paid plan or spending increase is required by this setup.

## Restore to a new database

1. Download a successful artifact and extract its files. Verify the archive against `SHA256SUMS` before use.
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

Transfer the backup repository together with the application repository and required service ownership. Have the buyer configure a new backup connection secret under their control, update the expected hostname/database when necessary, and pass a manual backup plus restore test. Review collaborators and spending controls. A dedicated read-only database role can reduce the backup credential's privileges; configure its current and future-table read permissions before replacing the secret.

## Local checks

The scripts use Node.js built-ins and require Node.js 20 or newer. Run the tests without database credentials:

```sh
node --test scripts/*.test.mjs
```

The actual backup and recovery jobs require Linux, Docker, network access to Neon, and the private repository secret. Docker-based end-to-end operation must be confirmed in the first GitHub-hosted run.

## Official references

- [PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)
- [PostgreSQL connection and TLS parameters](https://www.postgresql.org/docs/18/libpq-connect.html)
- [Neon export guidance](https://neon.com/docs/manage/backup-pg-dump)
- [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
