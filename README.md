# Discord Away Bot (multi-tenant)

One bot, invited into as many Discord servers as you like. Anyone in any of
those servers can turn on their own "away mode" and the bot will:

- Reply on their behalf (via a free NVIDIA NIM-hosted LLM) whenever someone
  @mentions them and they're marked away
- Auto-follow them into voice channels while they're away
- Clearly disclose it's an AI stand-in if anyone asks — it never claims to
  be a real person, and Discord's own `BOT` tag on the account makes that
  obvious regardless

It's a proper **bot account**, not a self-bot automating anyone's personal
login — that's against Discord's Terms of Service and gets accounts banned.
This is the same architecture as any legitimate SaaS Discord bot (Dyno,
MEE6, etc).

---

## 1. Create the bot in Discord's Developer Portal

1. https://discord.com/developers/applications → **New Application** → name it.
2. Sidebar → **Bot** → **Add Bot** → **Reset Token** → copy it (`DISCORD_BOT_TOKEN`).
3. Still on the Bot page, enable **Privileged Gateway Intents**:
   `MESSAGE CONTENT INTENT` and `SERVER MEMBERS INTENT`.

## 2. Get a free NVIDIA NIM API key

1. Sign up at https://build.nvidia.com (free, no credit card — phone
   verification is required, one-time).
2. Go to **Settings → API Keys** → generate a key (`nvapi-...`). This is
   `NVIDIA_API_KEY`.
3. The default model in this project is
   `nvidia/llama-3.3-nemotron-super-49b-v1` — NVIDIA's recommended general
   chat model. You can swap `NIM_MODEL` to any other model in their catalog
   (e.g. `meta/llama-3.3-70b-instruct`) at https://build.nvidia.com/models.

**Free tier limits to know before selling this:** ~40 requests/minute,
shared across your whole API key — not per server or per user. That's fine
for a handful of servers and light use, but if you get enough paying
customers to bump into it regularly, you'll want to move to a paid provider
or a self-hosted NIM container down the line.

## 3. Get an invite link (same link works for every customer)

1. Developer Portal → **OAuth2 → URL Generator**.
2. Scope: `bot`.
3. Permissions: `Send Messages`, `Read Message History`, `View Channels`,
   `Connect`, `Speak`.
4. Copy the generated URL — this is what you send to colleagues/customers so
   they can add the bot to their own server. No per-customer setup needed on
   your end.

## 4. Run it locally to test

```bash
cd discord-away-bot
cp .env.example .env
# paste DISCORD_BOT_TOKEN and NVIDIA_API_KEY into .env
pip install -r requirements.txt
python main.py
```

In any server the bot is in:
- `!away on` — marks *you* away in *that* server, using your display name
- `!away on Alex from Sales` — marks you away under a custom name
- `!awaylist` — shows everyone currently away in that server
- `!away off` — turns it back off
- `!join` / `!leave` — manually move the bot into/out of voice, useful for testing

Ask a friend to `@mention` you while away mode is on to see the AI stand-in reply.

## 5. Deploy to Render for 24/7 uptime

A Discord bot needs a **Background Worker** on Render — the free tier only
covers web services, and those sleep after 15 minutes of inactivity, which
would silently disconnect the bot. `render.yaml` is set up for a **Starter
worker (~$7/month)** with a small **persistent disk (~$0.25/month)** so the
away-status database survives restarts and redeploys.

1. Push this folder to a GitHub repo.
2. Render dashboard → **New → Blueprint** → connect the repo. It reads
   `render.yaml` and creates the worker + disk automatically.
3. In the service's **Environment** tab, add `DISCORD_BOT_TOKEN` and
   `NVIDIA_API_KEY` (marked `sync: false` so Render prompts you rather than
   storing them in git).
4. Deploy. Check **Logs** for `Logged in as ...` to confirm it's connected.

## Before you sell this to colleagues

A few practical things worth knowing, not to talk you out of it — just so
there are no surprises:

- **Discord Developer Policy**: bots can absolutely be monetized, but once
  a bot is in 100+ servers, Discord requires it to go through **bot
  verification**. Worth reading
  [Discord's Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy)
  before you scale past a small pilot group.
- **Data handling**: this bot stores Discord user IDs and away-status/persona
  names per server. If you're charging money for it, it's good practice to
  have a short privacy note for customers explaining what's stored (this is
  pretty much it — no message content is persisted beyond the in-memory
  conversation window, which resets on restart).
- **NVIDIA's free tier is for prototyping**, not committed production
  throughput — see the rate-limit note above. Fine for a paid pilot with a
  few colleagues; something to revisit if this grows.

## Commands

| Command | Who | What |
|---|---|---|
| `!away on [name]` | anyone | Marks the caller away in the current server |
| `!away off` | anyone | Turns their own away mode off |
| `!awaylist` | anyone | Lists who's currently away in the current server |
| `!join` | anyone | Bot joins the caller's current voice channel |
| `!leave` | anyone | Bot leaves voice |

## Design notes

- State is per **(server, user)** in `store.py` (SQLite), so the same bot
  correctly serves many different servers and many away users at once.
- If two away users are in different voice channels at the same moment, the
  bot can only be in one — it follows whichever moved most recently. Fine
  for now; would need per-guild multi-voice-client logic to fully fix.
- If a message @mentions more than one away person at once, only the first
  gets a stand-in reply, to keep v1 simple.
- Conversation memory is in-process, keyed by (channel, away-user), and
  resets if the bot restarts — swap in a real table in `store.py` if you
  want it to persist too.
