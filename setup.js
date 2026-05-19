/**
 * setup.js — Run this ONCE to authenticate your Telegram user account.
 * It will generate a SESSION_STRING that you paste into your .env file.
 *
 * Usage:
 *   node setup.js
 */

require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const fs = require("fs");
const path = require("path");

const API_ID = parseInt(process.env.API_ID, 10);
const API_HASH = process.env.API_HASH;

if (!API_ID || !API_HASH) {
  console.error("❌  Set API_ID and API_HASH in your .env file first.");
  process.exit(1);
}

(async () => {
  console.log("\n🔐  Telegram Story Bot — First-Time Setup\n");
  console.log("This will log into your Telegram account to get a session string.");
  console.log("The session string lets the bot post stories on your behalf.\n");

  if (process.env.SESSION_STRING) {
    const confirm = await input.confirm("⚠️ A SESSION_STRING already exists in .env. Do you want to generate a new one?");
    if (!confirm) process.exit(0);
  }

  const session = new StringSession(""); // Start a fresh session
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("📱 Enter your phone number (with country code, e.g. +2348012345678): "),
    password: async () => await input.text("🔑 2FA password (leave blank if none): "),
    phoneCode: async () => await input.text("📬 Enter the code Telegram sent you: "),
    onError: (err) => console.error("Error:", err),
  });

  const sessionString = client.session.save();

  console.log("\n✅  Authenticated successfully!\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Add this to your .env file:\n");
  console.log(`SESSION_STRING=${sessionString}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("⚠️  Keep this string private — it grants full access to your account!\n");

  await client.disconnect();
  process.exit(0);
})();
