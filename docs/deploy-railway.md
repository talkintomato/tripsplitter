# Deploying to Railway

This runs TripSplitter on Railway with its database on a Railway volume, using Railway's Serverless setting so the app sleeps when nobody is using it.

Facts about Railway below were read from its documentation on 2026-09-27. Check the current pages if something looks different.

## What it costs

| Plan | Price | Volume size |
|---|---|---|
| Trial | One-time 5 USD of credit | 0.5 GB |
| Free | 0 USD a month, with 1 USD of credit each month | 0.5 GB |
| Hobby | 5 USD a month, which includes 5 USD of usage | 5 GB |

You pay for what the app uses while it is awake. With Serverless on, it is asleep most of the time. Whether the Free plan's 1 USD a month is enough has not been measured.

## How Serverless affects the bot

- The app goes to sleep after 5 to 10 minutes without sending anything.
- It wakes when Telegram or a person opening the Mini App calls it.
- Railway says the first call to a sleeping app "may return a 502 Bad Gateway response". For the bot this means the first message after a quiet period can be answered late. For the Mini App it means the first open can fail and work on a second try.
- The bot must run in webhook mode, where Telegram calls the app. In the other mode the app asks Telegram for messages all the time and would never sleep. Setting `WEBHOOK_URL` turns webhook mode on.

## Steps

### 1. Log in

```
railway login
```

This opens a browser page to approve.

### 2. Create the project and service

From the project folder:

```
railway init
railway add --service tripsplitter
railway service tripsplitter
```

### 3. Add the volume

```
railway volume add --mount-path /data
```

The database file lives here and survives restarts, sleep and new deployments.

### 4. Get the public address

```
railway domain
```

It prints an address like `https://tripsplitter-production.up.railway.app`. You need it in the next step and for BotFather.

### 5. Set the settings

Replace each value in angle brackets. Generate the two secrets with `openssl rand -hex 24`.

```
railway variables \
  --set "NODE_ENV=production" \
  --set "BOT_TOKEN=<bot token from BotFather>" \
  --set "BOT_USERNAME=<bot username without @>" \
  --set "MINI_APP_NAME=<short name of the Mini App>" \
  --set "LINK_SECRET=<first secret>" \
  --set "WEBHOOK_SECRET=<second secret>" \
  --set "WEBHOOK_URL=<the address from step 4>" \
  --set "DATABASE_PATH=/data/tripsplitter.db" \
  --set "OPENAI_API_KEY=<OpenAI key>" \
  --set "RECEIPT_MODEL=gpt-6-luna" \
  --set "RAILWAY_RUN_UID=0"
```

- `RAILWAY_RUN_UID=0` is needed because the app does not run as the root user, and Railway's volume is otherwise not writable by it.
- Do not set `PORT`. Railway provides it.
- Keep `LINK_SECRET` the same for the life of the deployment. Changing it breaks every link already posted in groups.

### 6. Turn on Serverless

In the Railway dashboard: open the service, then Settings, then Deploy, and switch on Serverless. Railway's documentation does not list a way to set this from the config file.

### 7. Deploy

```
railway up
```

Railway builds the image from the `Dockerfile` and starts it. It counts as started when `/health` answers.

### 8. Check it

```
curl https://<your address>/health
```

should answer `{"status":"ok","database":"ok"}`.

### 9. Point BotFather at it

1. `/myapps`, choose the Mini App, and set its web address to the address from step 4. If there is no Mini App yet, create it with `/newapp` and use the same short name as `MINI_APP_NAME`.
2. `/setprivacy`, choose the bot, choose Disable.
3. If the bot was already in a group before step 2, remove it and add it back.

### 10. Stop any copy running on your own machine

Only one copy can receive the bot's messages. A local copy using the same bot token takes messages away from the deployed one, and Telegram refuses the local copy while a webhook is set.

## Backups

Railway can back up the volume, by hand or on a schedule, from the volume's page in the dashboard. Take one before each new deployment.

## Updating

Run `railway up` again. Railway stops the old copy before starting the new one, because only one can use the volume, so the app is unavailable for a short time.

## Not yet verified

- The image builds and starts on a local machine. It has not been deployed to Railway.
- Whether Telegram delivers a message again after a 502 from a sleeping app, and how long that takes.
- Monthly cost with Serverless on.

## Show an Open button on the bot's profile

In @BotFather, use `/mybots`, choose your bot, and open Bot Settings → Configure Mini App
to set its Main Mini App. Use the same public HTTPS base address as `WEBHOOK_URL`
(for Railway, the address from step 4), without a group start parameter or webhook secret path.
The profile's Open button and the private-chat `/start` button then open **Your groups**.
Keep the named Mini App's address set to that same URL for the pinned group links.
Without `WEBHOOK_URL`, private `/start` gives text directing people to their group's pinned message.

## Chat agent settings

In Railway Variables, `AGENT_ENABLED` defaults to true when `OPENAI_API_KEY` exists. Set `AGENT_ENABLED=false` and redeploy to disable chat. No key means mentions point to the Mini App. `AGENT_MODEL` defaults to `gpt-6-luna`; `AGENT_DAILY_CAP` defaults to 100 messages per group per Singapore day and `AGENT_GLOBAL_DAILY_CAP` to 1000 across groups (0 removes only the global cap). Receipt limits are independent. See [agent.md](agent.md) for privacy, confirmations and the optional live check.
