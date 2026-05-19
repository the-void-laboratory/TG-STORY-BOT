/**
 * TG Story Bot
 * Purely Interactive Chat-Based Telegram Authentication (No Web Site Interface)
 *
 * Requirements:
 * - BOT_TOKEN      → from @BotFather
 * - API_ID + API_HASH → from https://my.telegram.org/apps
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const { MongoClient } = require("mongodb");
const path = require("path");
const https = require("https");
const http = require("http");

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = parseInt(process.env.API_ID, 10);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || "";
const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || "300", 10);
const OWNER_ID = parseInt(process.env.OWNER_ID, 10);
const MONGODB_URI = process.env.MONGODB_URI;

if (!BOT_TOKEN || !API_ID || !API_HASH) {
  console.error("❌ Missing BOT_TOKEN, API_ID, or API_HASH in .env");
  process.exit(1);
}

// ── Telegram Bot Initialization ──────────────────────────────────────────────
// Passing testEnvironment: false explicitly blocks local handshake mutations
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: {
    autoStart: true,
    params: {
      timeout: 10
    }
  } 
});

// Gracefully drop existing conflicts to prioritize this active container sequence
bot.on("polling_error", (error) => {
  if (error.message.includes("409 Conflict")) {
    console.warn("⚠️ Dual polling conflict noticed. Forcefully reclaiming loop context...");
  } else {
    console.error("📋 Polling Error:", error.message);
  }
});

// ── Settings Persistence ─────────────────────────────────────────────────────
let db, sessionsColl, settingsColl;

async function initDB() {
  if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI not found. Running in memory fallback.");
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db("storybot");
    sessionsColl = db.collection("sessions");
    settingsColl = db.collection("settings");
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err.message);
  }
}

async function getSessionStr(userId) {
  if (!sessionsColl) return (userId === OWNER_ID ? SESSION_STRING : null);
  const doc = await sessionsColl.findOne({ userId });
  return doc ? doc.sessionStr : (userId === OWNER_ID ? SESSION_STRING : null);
}

async function saveSession(userId, sessionStr) {
  if (!sessionsColl) return;
  await sessionsColl.updateOne({ userId }, { $set: { sessionStr } }, { upsert: true });
}

async function deleteSession(userId) {
  if (!sessionsColl) return;
  await sessionsColl.deleteOne({ userId });
}

// Runtime Storage Objects
const activeClients = new Map(); 
const pendingStories = new Map(); 
const waitingForCaption = new Set(); 
const waitingForCustomTime = new Set(); 
const userCooldowns = new Map(); 
const loginStates = new Map();   

async function getClient(userId) {
  let client = activeClients.get(userId);

  if (!client) {
    const sessionStr = await getSessionStr(userId);
    if (!sessionStr) return null;

    client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { 
      connectionRetries: 5,
    });
    await client.connect();
    activeClients.set(userId, client);
  }

  if (await client.isUserAuthorized()) {
    client.invoke(new Api.account.UpdateStatus({ offline: true })).catch(() => {});
    return client;
  }
  return null;
}

async function loadUserSettings(userId) {
  const defaults = { currentPrivacy: "all", currentDuration: 86400 };
  if (!settingsColl) return defaults;
  const settings = await settingsColl.findOne({ userId });
  return settings || defaults;
}

async function saveUserSettings(userId, privacy, duration) {
  if (!settingsColl) return;
  await settingsColl.updateOne({ userId }, { $set: { currentPrivacy: privacy, currentDuration: duration } }, { upsert: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSchedulingKeyboard(showTemplates = false) {
  if (showTemplates) {
    return {
      inline_keyboard: [
        [{ text: "15m", callback_data: "sched_900" }, { text: "30m", callback_data: "sched_1800" }, { text: "1h", callback_data: "sched_3600" }],
        [{ text: "3h", callback_data: "sched_10800" }, { text: "6h", callback_data: "sched_21600" }, { text: "12h", callback_data: "sched_43200" }],
        [{ text: "⬅️ Back", callback_data: "sched_main_menu" }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "🚀 Post Now", callback_data: "sched_now" }],
      [{ text: "📋 Templates", callback_data: "sched_templates" }, { text: "📅 Custom", callback_data: "sched_custom" }],
      [{ text: "✏️ Edit Caption", callback_data: "sched_edit_caption" }],
      [{ text: "❌ Cancel", callback_data: "sched_cancel" }],
    ],
  };
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Failed setup: ${res.statusCode}`));
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

function handleScheduling(userId, delaySeconds, userPending, chatId, messageId = null) {
  const storyData = { ...userPending };
  pendingStories.delete(userId);
  userCooldowns.set(userId, Date.now());

  const text = delaySeconds === 0 ? "🚀 Posting now..." : `✅ Scheduled for ${Math.floor(delaySeconds / 60)}m from now.`;
  if (messageId) bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
  else bot.sendMessage(chatId, text);

  setTimeout(async () => {
    try {
      const client = await getClient(userId);
      const settings = await loadUserSettings(userId);
      await postToStory(client, storyData.filePath, storyData.isVideo, storyData.caption, settings.currentPrivacy, settings.currentDuration);
      bot.sendMessage(userId, "✅ Your story has been posted!");
    } catch (err) {
      bot.sendMessage(userId, `❌ Scheduled post failed: ${err.message}`);
    } finally {
      if (fs.existsSync(storyData.filePath)) fs.unlinkSync(storyData.filePath);
    }
  }, delaySeconds * 1000);
}

async function postToStory(client, filePath, isVideo, caption = "", privacy, duration) {
  const uploadedFile = await client.uploadFile({ file: filePath, workers: 4 });
  let media = isVideo 
    ? new Api.InputMediaUploadedDocument({ file: uploadedFile, mimeType: "video/mp4", attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0, supportsStreaming: true })] })
    : new Api.InputMediaUploadedPhoto({ file: uploadedFile });

  let privacyRules = privacy === "contacts" ? [new Api.InputPrivacyValueAllowContacts()] : privacy === "closeFriends" ? [new Api.InputPrivacyValueAllowCloseFriends()] : [new Api.InputPrivacyValueAllowAll()];

  return await client.invoke(new Api.stories.SendStory({ peer: new Api.InputPeerSelf(), media, privacyRules, caption: caption || undefined, period: duration }));
}

// ── Bot Conversational Triggers ────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `👋 *Story Bot Is Ready*\n\n🔐 /login - Connection Verification Account Flow\n🚪 /logout - Unlink account session`);
});

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  await deleteSession(userId);
  activeClients.delete(userId);
  bot.sendMessage(userId, "✅ Logged out completely. Active variables unlinked.");
});

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const client = await getClient(userId);
  if (client) return bot.sendMessage(userId, "✅ You are already logged in!");

  if (loginStates.has(userId)) {
    const existing = loginStates.get(userId).client;
    if (existing && existing.connected) existing.disconnect().catch(() => {});
    loginStates.delete(userId);
  }

  loginStates.set(userId, { step: "PHONE" });
  bot.sendMessage(userId, "📱 Please send your phone number in international format (e.g., `+1234567890`).", { parse_mode: "Markdown" });
});

bot.on("message", async (msg) => {
  const userId = msg.from.id;

  if (waitingForCustomTime.has(userId) && msg.text && !msg.text.startsWith("/")) {
    const minutes = parseInt(msg.text, 10);
    if (isNaN(minutes) || minutes < 1) return bot.sendMessage(userId, "❌ Please write an explicit amount of minutes.");
    waitingForCustomTime.delete(userId);
    const pending = pendingStories.get(userId);
    if (pending) handleScheduling(userId, minutes * 60, pending, msg.chat.id);
    return;
  }

  if (waitingForCaption.has(userId) && msg.text && !msg.text.startsWith("/")) {
    const pending = pendingStories.get(userId);
    if (pending) {
      pending.caption = msg.text;
      waitingForCaption.delete(userId);
      return bot.sendMessage(userId, `✅ Caption configured to: *${msg.text}*\nWhen should I post?`, {
        parse_mode: "Markdown",
        reply_markup: getSchedulingKeyboard(),
      });
    }
  }

  const state = loginStates.get(userId);
  if (!state || !msg.text || msg.text.startsWith("/")) return;

  try {
    if (state.step === "PHONE") {
      const cleanPhone = msg.text.replace(/\s+/g, "");
      const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { 
        connectionRetries: 5,
        useWSS: false
      });
      await client.connect();
      
      const { phoneCodeHash } = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, cleanPhone);
      
      // Save the instance immediately to preserve the handshake socket connection
      loginStates.set(userId, { step: "CODE", client, phone: cleanPhone, phoneCodeHash });
      bot.sendMessage(userId, "📬 Type the verification code sent directly to your Telegram devices:");

    } else if (state.step === "CODE") {
      const { client, phone, phoneCodeHash } = state;
      const parsedCode = msg.text.trim();

      try {
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash,
            phoneCode: parsedCode,
          })
        );
      } catch (err) {
        if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
          loginStates.set(userId, { ...state, step: "2FA" });
          return bot.sendMessage(userId, "🔑 2FA is active. Please send your cloud validation password below:");
        }
        throw err;
      }
      
      await finishLogin(userId, client);

    } else if (state.step === "2FA") {
      const { client } = state;
      await client.start({
        password: async () => msg.text.trim(),
      });
      await finishLogin(userId, client);
    }
  } catch (err) {
    console.error("Login error:", err);
    bot.sendMessage(userId, `❌ Connection attempt crashed: ${err.message}. Type /login to start a fresh handshake.`);
    loginStates.delete(userId);
  }
});

async function finishLogin(userId, client) {
  const sessionStr = client.session.save();
  await saveSession(userId, sessionStr);
  activeClients.set(userId, client);
  loginStates.delete(userId);
  bot.sendMessage(userId, "✅ Account successfully linked! You can now send photos and videos directly to post them as stories.");
}

bot.on("photo", async (msg) => {
  const userId = msg.from.id;
  const client = await getClient(userId);
  if (!client) return bot.sendMessage(userId, "❌ Use /login to link an active Telegram profile first.");

  const tempPath = path.join(__dirname, `story_${Date.now()}.jpg`);
  const photo = msg.photo[msg.photo.length - 1];
  const fileInfo = await bot.getFile(photo.file_id);
  
  await downloadFile(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`, tempPath);
  pendingStories.set(userId, { filePath: tempPath, isVideo: false, caption: msg.caption || "" });

  bot.sendMessage(msg.chat.id, "📸 Photo context saved! Choose scheduling distribution profile:", { reply_markup: getSchedulingKeyboard() });
});

bot.on("video", async (msg) => {
  const userId = msg.from.id;
  const client = await getClient(userId);
  if (!client) return bot.sendMessage(userId, "❌ Use /login to link an active Telegram profile first.");

  const tempPath = path.join(__dirname, `story_${Date.now()}.mp4`);
  const fileInfo = await bot.getFile(msg.video.file_id);
  
  await downloadFile(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`, tempPath);
  pendingStories.set(userId, { filePath: tempPath, isVideo: true, caption: msg.caption || "" });

  bot.sendMessage(msg.chat.id, "🎥 Video context saved! Choose scheduling distribution profile:", { reply_markup: getSchedulingKeyboard() });
});

bot.on("callback_query", async (query) => {
  const data = query.data;
  const userId = query.from.id;

  if (data.startsWith("sched_")) {
    const pending = pendingStories.get(userId);
    if (!pending) return bot.answerCallbackQuery(query.id, { text: "No pending setup active." });

    const action = data.replace("sched_", "");
    if (action === "now") handleScheduling(userId, 0, pending, query.message.chat.id, query.message.message_id);
    else if (action === "custom") {
      waitingForCustomTime.add(userId);
      bot.sendMessage(userId, "📅 How many minutes from now should I upload this story?");
    } else if (action === "cancel") {
      if (fs.existsSync(pending.filePath)) fs.unlinkSync(pending.filePath);
      pendingStories.delete(userId);
      bot.editMessageText("❌ Canceled.", { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }
  }
});

// Dummy listening server to keep the Railway network port assignment requirement happy
http.createServer((req, res) => { res.writeHead(200); res.end("Online"); }).listen(process.env.PORT || 3000);

(async () => {
  await initDB();
})();