# Run TripSplitter

TripSplitter runs its Telegram bot, API and Mini App in one Node 22 process. Choose any host that provides an always-on process, a persistent disk, an HTTPS address and outbound internet access. A service that sleeps between requests is unsuitable for long polling. Keep one running instance attached to one database; do not run two bot pollers or place SQLite on shared network storage.

The host must forward its public HTTPS address to the app's HTTP port (3000 by default). HTTPS can be handled by the host or a reverse proxy. The Mini App needs HTTPS even when the bot uses long polling. The database must survive restarts, redeployments and image replacements.

## Set up Telegram

1. In Telegram, open the verified **@BotFather** account and send `/newbot`. Choose a display name and a username. Save the token privately as `BOT_TOKEN`; put the username, without `@`, in `BOT_USERNAME`.
2. Register a Mini App with BotFather using `/newapp`, select your bot, and follow the prompts for its title, description, image and HTTPS URL. Set its URL to your public app address, such as `https://your-domain.example/`. Record the short name as `MINI_APP_NAME`. The links use `https://t.me/<bot_username>/<short_name>`; the short name is not the bot username. BotFather's bot settings can also configure a Main Mini App or menu button; use the same HTTPS URL. TripSplitter's pinned group link supplies the group information, so start there when testing.
3. Send `/setprivacy`, select the bot, and choose **Disable**. This lets it learn the human members from group messages. Remove and re-add the bot to every group it belonged to before this change. Privacy-off is required unless the bot is an administrator. Allow it to join groups in BotFather if needed.
4. Add the bot to a test group. Give it permission to send messages and pin its introduction (making it an administrator with pin permission is the simplest way). Have two people send a message so the bot learns their names. Open the Mini App from the pinned message.

No ordinary chat message text is stored. Tagged receipt descriptions are saved. Anyone with a current group link can join the trip, including people outside the Telegram chat. Any member can reset the link from Members; earlier links then stop working, while existing members stay members.

## Settings

Copy `.env.example` to a private `.env` file, or use your host's secret/environment settings. Never commit the filled-in file. Use different random values for `LINK_SECRET` and `WEBHOOK_SECRET`; generate each with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` on your computer. Keep `LINK_SECRET` stable across deployments so existing links continue to work.

| Variable | What to enter |
|---|---|
| `NODE_ENV` | `production` on the host. Default is `development` outside Docker; `test` is also supported. |
| `BOT_TOKEN` | Required: the private token from BotFather. |
| `BOT_USERNAME` | Required: the bot username, without `@`. |
| `MINI_APP_NAME` | Required: the Mini App's short name from BotFather. |
| `LINK_SECRET` | Required: at least 32 random characters, for signing group links. |
| `DATABASE_PATH` | `/data/tripsplitter.db` in Docker. Outside Docker, default `./data/tripsplitter.db`; use a persistent disk. |
| `ALLOWED_CHAT_IDS` | Optional comma-separated group IDs, including their minus signs. Empty means every group can use the bot. See below. |
| `OPENAI_API_KEY` | Optional private key for reading receipts. Leave empty to disable receipt reading; manual expenses still work. |
| `RECEIPT_MODEL` | Receipt model ID available to your OpenAI account. Default `gpt-6-luna`. |
| `RECEIPT_DAILY_CAP` | Positive whole number of model calls per group per Singapore day. Default `30`. Retries and failed calls use reservations too. |
| `RECEIPT_GLOBAL_DAILY_CAP` | Whole number of model calls across all groups per Singapore day. Default `300`; `0` disables this overall limit. The per-group cap still applies. |
| `PORT` | HTTP port, default `3000`. Keep it consistent with your host's port forwarding. |
| `WEBHOOK_URL` | Optional public HTTPS **base** URL, e.g. `https://your-domain.example`. Leave empty for long polling. Do not include the secret route. |
| `WEBHOOK_SECRET` | Required with `WEBHOOK_URL`: 16–256 letters, digits, `_` or `-`. Used in both the route and Telegram's secret header. |
| `DEV_FAKE_USER` | Leave empty in production. Local-only JSON, e.g. `{"id":1,"first_name":"Dev"}`. Production startup refuses it. With development mode and this set, the main entry point uses offline fixtures and does not contact Telegram or OpenAI. |
| `DEV_NO_RATES` | Optional local fixture switch, `1` makes development suggestions unavailable. Only the offline development server reads this; leave unset on the host. |

Rate lookup needs outbound HTTPS to `api.frankfurter.dev`; Telegram and enabled receipt reading also need outbound HTTPS. Rates are suggested automatically and remain fixed per trip until a member changes them. Rate entry is always home currency first, for example **1 SGD = 112.4 JPY**.

## First run with Docker

From the repository directory:

```sh
docker build -t tripsplitter .
docker volume create tripsplitter-data
docker run -d --name tripsplitter --restart unless-stopped \
  --env-file .env \
  -e NODE_ENV=production -e DATABASE_PATH=/data/tripsplitter.db \
  -p 3000:3000 \
  -v tripsplitter-data:/data \
  tripsplitter
```

The image builds both the server and Mini App, includes the migrations, and runs as the unprivileged `node` user (UID 1000). A newly created named volume inherits `/data` permissions. If your host supplies an existing disk or a bind-mounted folder, arrange for UID 1000 to be able to write that folder. Do not solve permission problems by running the app as root.

Forward the HTTPS address to port 3000 and visit `https://your-domain.example/health`. A healthy response is `{"status":"ok","database":"ok"}`; an unavailable database returns HTTP 503. The normal app address without a group link explains how to open it from Telegram. Check startup with `docker logs tripsplitter`. Avoid logging webhook URLs or proxy request paths containing your webhook secret.

With `WEBHOOK_URL` empty the process deletes any previous webhook, then polls Telegram. With it set, startup registers `/telegram/<WEBHOOK_SECRET>` with Telegram and checks `X-Telegram-Bot-Api-Secret-Token` on every request. Forward that header unchanged through your HTTPS proxy. Both modes request the update types needed for membership changes. Only one mode runs at a time.

New databases and later schema migrations are created automatically on startup. The process drains requests and bot work before closing SQLite when it receives SIGINT or SIGTERM. Allow a generous shutdown period for receipt reads: for example `docker stop --time 120 tripsplitter`. Your host should send SIGTERM and allow the same grace period during deploys.

Without Docker, use Node 22 and the pnpm version declared in `package.json`: install the locked dependencies, run `pnpm build`, and run `pnpm start` under your host's process supervisor. Keep the working directory at the repository/build root so `web/dist` can be found. The host must still provide persistent disk and HTTPS.

## Restrict the bot to selected groups

Leaving `ALLOWED_CHAT_IDS` empty allows any group to use the bot, subject to both receipt limits. To restrict it, enter IDs such as `-1001234567890,-1009876543210` and restart the process. The API enforces the same restriction on Mini App links. If a group upgrades to a supergroup, a previously recorded chat ID is still recognized.

To discover the ID of a group already registered in your database, run this on your host:

```sh
docker exec tripsplitter node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(process.env.DATABASE_PATH, {readonly:true}); console.table(db.prepare("SELECT chat_id, title FROM chat_group").all()); db.close();'
```

For an initial private rollout, add the bot to your chosen group while the list is empty, read the ID, then set the restriction before sharing the bot publicly. Do not paste bot tokens into third-party websites to look up IDs.

## Back up and restore

SQLite uses WAL mode. Copying only the main `.db` file while the app is running may miss recent changes. The following makes a consistent, standalone SQLite backup while the app runs, using better-sqlite3's backup API:

```sh
docker exec tripsplitter node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(process.env.DATABASE_PATH); try { await db.backup("/data/tripsplitter-backup.db"); } finally { db.close(); }'
mkdir -p backups
docker cp tripsplitter:/data/tripsplitter-backup.db ./backups/tripsplitter-backup.db
```

Move or rename that downloaded backup with its date before making the next one. Keep backups outside the host's disk, protected like the original database: they contain names, expense information and Telegram identifiers. Back up before every upgrade and on a regular schedule. Keep environment secrets separately in your password manager or host's secret store. A backup on the same disk alone does not protect against disk loss.

To restore, stop the app cleanly first. Keep a copy of the existing database and any `-wal`/`-shm` files together as a rollback copy. Replace `/data/tripsplitter.db` with the standalone backup, remove stale `tripsplitter.db-wal` and `tripsplitter.db-shm` files from the restore destination, and ensure UID 1000 can write the restored file and directory. Restart the app and check `/health` and the trip balances. Never replace or delete SQLite files while the app is running. Test restoring to a separate disk before relying on your backup procedure.

## Check before inviting everyone

Use two Telegram accounts to check the [PRD 5 end-to-end list](prds/5-currency-launch.md#end-to-end-check), including a third account joining by link, reset-link refusal, SGD/JPY setup, receipt handling, balance previews, stale edits and trip ending. This repository build does not prove the real Telegram signature, BotFather settings, OpenAI model access or your host's HTTPS forwarding: those need your deployed test group. The expense-form currency picker, per-expense rate controls and rate-source detail are deferred to the next integration stage, so the full launch checklist cannot yet be signed off.

## Show an Open button on the bot's profile

In @BotFather, use `/mybots`, choose your bot, and open Bot Settings → Configure Mini App
to set its Main Mini App. Use the same public HTTPS base address as `WEBHOOK_URL`
(for Railway, the address from step 4), without a group start parameter or webhook secret path.
The profile's Open button and the private-chat `/start` button then open **Your groups**.
Keep the named Mini App's address set to that same URL for the pinned group links.
Without `WEBHOOK_URL`, private `/start` gives text directing people to their group's pinned message.

## Chat agent settings

`AGENT_ENABLED` defaults to true when `OPENAI_API_KEY` exists; set it to `false` and restart to disable chat. Without the key, mentions point to the Mini App. `AGENT_MODEL` defaults to `gpt-6-luna`. `AGENT_DAILY_CAP=100` limits messages per group per Singapore day; `AGENT_GLOBAL_DAILY_CAP=1000` limits all groups (0 disables only the global cap). These are separate from receipt limits. See [agent.md](agent.md) for privacy, confirmations and the optional live check.
