# 📸 TG Story Bot

A Telegram bot that instantly posts photos and videos to your Telegram story — just send the media to the bot and it goes live.

---

## How It Works

```
You  →  send photo/video to bot  →  bot posts it to YOUR story
```

The bot uses two Telegram APIs:
- **Bot API** (`node-telegram-bot-api`) — receives your messages
- **MTProto / GramJS** (`telegram`) — authenticates as *you* to post the story

---

## Prerequisites

- Node.js v18+
- A Telegram account with Stories enabled
- A bot created via [@BotFather](https://t.me/BotFather)
- API credentials from [my.telegram.org/apps](https://my.telegram.org/apps)

---

## Setup (3 steps)

### Step 1 — Get your credentials

1. **Bot Token**: Message [@BotFather](https://t.me/BotFather), create a new bot, copy the token.
2. **API ID & Hash**: Go to [my.telegram.org/apps](https://my.telegram.org/apps), log in, create an app, copy `App api_id` and `App api_hash`.
3. **Your User ID**: Message [@userinfobot](https://t.me/userinfobot) on Telegram to get your numeric user ID.

### Step 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
```
BOT_TOKEN=...
API_ID=...
API_HASH=...
OWNER_ID=...     ← your numeric Telegram user ID
```

### Step 3 — Authenticate & run

```bash
# Install dependencies
npm install

# Generate your session string (run once)
npm run setup
```

Follow the prompts — enter your phone number and the OTP Telegram sends you. Copy the `SESSION_STRING` printed at the end into your `.env`.

```bash
# Start the bot
npm start
```

---

## Usage

Once the bot is running:

| Action | Result |
|--------|--------|
| Send a photo | Posts to your story instantly |
| Send a video (≤20MB) | Posts to your story instantly |
| Add a caption | Caption appears on the story |
| `/start` | Shows welcome message |
| `/status` | Shows client connection status |

Stories are visible to **everyone** by default and expire after **24 hours**.

---

## Customizing Privacy

In `bot.js`, find the `privacyRules` array and change it:

```js
// Everyone (default)
const privacyRules = [new Api.InputPrivacyValueAllowAll()];

// Contacts only
const privacyRules = [new Api.InputPrivacyValueAllowContacts()];

// Close friends only
const privacyRules = [new Api.InputPrivacyValueAllowCloseFriends()];
```

---

## Running in Production

Use [PM2](https://pm2.keymetrics.io/) to keep the bot alive:

```bash
npm install -g pm2
pm2 start bot.js --name tg-story-bot
pm2 save
pm2 startup
```

---

## Security Notes

- ⚠️ Your `SESSION_STRING` grants **full access to your Telegram account** — never share it or commit it to git.
- The `OWNER_ID` setting ensures only you can send media to the bot.
- `.gitignore` already excludes `.env`.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `User client not authorized` | Re-run `npm run setup` |
| `Video exceeds 20MB` | Compress the video first |
| `FLOOD_WAIT` | Telegram rate-limited you; wait the specified seconds |
| Bot doesn't respond | Check `BOT_TOKEN` and that the bot is running |
