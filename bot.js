/**
 * TG Story Bot
 * Posts photos/videos to your Telegram story via the MTProto client API.
 * Includes an HTTP panel to prevent Railway dual-polling container auth drops.
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
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !API_ID || !API_HASH) {
  console.error("❌ Missing BOT_TOKEN, API_ID, or API_HASH in .env");
  process.exit(1);
}

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on("polling_error", (error) => {
  if (error.message.includes("409 Conflict")) {
    console.warn("⚠️ Dual polling conflict noticed. Another container instance is running...");
  } else {
    console.error("📋 Polling Error:", error.message);
  }
});

// ── Settings Persistence ─────────────────────────────────────────────────────
let db, sessionsColl, settingsColl;

async function initDB() {
  if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI not found. Falling back to memory mode.");
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

// Global runtime containers
const activeClients = new Map(); 
const pendingStories = new Map(); 
const waitingForCaption = new Set(); 
const waitingForCustomTime = new Set(); 
const userCooldowns = new Map(); 
const webAuthSessions = new Map(); // Shared object for web UI log-ins

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
      if (res.statusCode !== 200) {
        return reject(new Error(`Status: ${res.statusCode}`));
      }
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

// ── Web Dashboard Login (Solves Railway Handshake Conflict) ─────────────────
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  
  if (urlObj.pathname === "/login-panel") {
    const uid = urlObj.searchParams.get("uid");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
      <body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#f4f7f9;">
        <h2>🔐 Link Telegram Account (ID: ${uid})</h2>
        <form action="/submit-phone" method="GET" style="margin-bottom:20px;">
          <input type="hidden" name="uid" value="${uid}">
          <input type="text" name="phone" placeholder="+123456789" required style="padding:10px; width:250px;"><br><br>
          <button type="submit" style="padding:10px 20px; background:#0088cc; color:#fff; border:none; border-radius:4px; cursor:pointer;">Request Verification Code</button>
        </form>
        <form action="/submit-code" method="GET">
          <input type="hidden" name="uid" value="${uid}">
          <input type="text" name="code" placeholder="Enter Code" required style="padding:10px; width:120px;">
          <input type="password" name="password" placeholder="2FA Password (if enabled)" style="padding:10px; width:180px;"><br><br>
          <button type="submit" style="padding:10px 20px; background:#4caf50; color:#fff; border:none; border-radius:4px; cursor:pointer;">Complete Connection</button>
        </form>
      </body>
      </html>
    `);
  } 
  else if (urlObj.pathname === "/submit-phone") {
    const uid = parseInt(urlObj.searchParams.get("uid"), 10);
    const phone = urlObj.searchParams.get("phone").replace(/\s+/g, "");
    try {
      const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });
      await client.connect();
      const { phoneCodeHash } = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
      webAuthSessions.set(uid, { client, phone, phoneCodeHash });
      res.end("Code sent! Check your Telegram App, type it into the panel box and click Complete Connection.");
    } catch (e) {
      res.end("Error sending code: " + e.message);
    }
  } 
  else if (urlObj.pathname === "/submit-code") {
    const uid = parseInt(urlObj.searchParams.get("uid"), 10);
    const code = urlObj.searchParams.get("code").trim();
    const password = urlObj.searchParams.get("password")?.trim();
    const sessionData = webAuthSessions.get(uid);

    if (!sessionData) return res.end("Session missing. Please refresh the main panel link.");

    try {
      const { client, phone, phoneCodeHash } = sessionData;
      try {
        await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
      } catch (err) {
        if (err.errorMessage === "SESSION_PASSWORD_NEEDED" && password) {
          await client.start({ password: async () => password });
        } else if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
          return res.end("Error: This account has 2FA enabled. Please fill out the 2FA Password field.");
        } else throw err;
      }
      
      const sessionStr = client.session.save();
      await saveSession(uid, sessionStr);
      activeClients.set(uid, client);
      webAuthSessions.delete(uid);

      bot.sendMessage(uid, "✅ Account linked successfully! You can now send photos/videos.");
      res.end("Success! Your account is securely connected. You can close this tab.");
    } catch (e) {
      res.end("Login failed: " + e.message);
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── Telegram Event Commands ──────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `👋 *Story Bot is running!*\n\n🔐 /login - Link account via login panel\n🚪 /logout - Remove account\n⚙️ /privacy - Set visibility\n⏱ /duration - Expire timer`);
});

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const client = await getClient(userId);
  if (client) return bot.sendMessage(userId, "✅ You are already logged in!");

  // Dynamic public dashboard URL fallback for environments like Railway
  const appUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  bot.sendMessage(userId, `🔗 Click the secure authorization panel below to verify your account without container interruptions:\n\n👉 ${appUrl}/login-panel?uid=${userId}`);
});

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  await deleteSession(userId);
  activeClients.delete(userId);
  bot.sendMessage(userId, "🗑️ Logged out. Session data deleted.");
});

bot.on("message", async (msg) => {
  const userId = msg.from.id;
  if (waitingForCustomTime.has(userId) && msg.text && !msg.text.startsWith("/")) {
    const minutes = parseInt(msg.text, 10);
    if (isNaN(minutes) || minutes < 1) return bot.sendMessage(userId, "❌ Enter a valid number.");
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
      return bot.sendMessage(userId, `Caption updated! When should I post it?`, { reply_markup: getSchedulingKeyboard() });
    }
  }
});

bot.on("photo", async (msg) => {
  const userId = msg.from.id;
  const client = await getClient(userId);
  if (!client) return bot.sendMessage(userId, "❌ Please execute /login first.");

  const tempPath = path.join(__dirname, `story_${Date.now()}.jpg`);
  const photo = msg.photo[msg.photo.length - 1];
  const fileInfo = await bot.getFile(photo.file_id);
  
  await downloadFile(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`, tempPath);
  pendingStories.set(userId, { filePath: tempPath, isVideo: false, caption: msg.caption || "" });

  bot.sendMessage(msg.chat.id, "📸 Photo loaded! Choose an option:", { reply_markup: getSchedulingKeyboard() });
});

bot.on("video", async (msg) => {
  const userId = msg.from.id;
  const client = await getClient(userId);
  if (!client) return bot.sendMessage(userId, "❌ Please execute /login first.");

  const tempPath = path.join(__dirname, `story_${Date.now()}.mp4`);
  const fileInfo = await bot.getFile(msg.video.file_id);
  
  await downloadFile(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`, tempPath);
  pendingStories.set(userId, { filePath: tempPath, isVideo: true, caption: msg.caption || "" });

  bot.sendMessage(msg.chat.id, "🎥 Video loaded! Choose an option:", { reply_markup: getSchedulingKeyboard() });
});

bot.on("callback_query", async (query) => {
  const data = query.data;
  const userId = query.from.id;

  if (data.startsWith("sched_")) {
    const pending = pendingStories.get(userId);
    if (!pending) return bot.answerCallbackQuery(query.id, { text: "No pending session." });

    const action = data.replace("sched_", "");
    if (action === "now") handleScheduling(userId, 0, pending, query.message.chat.id, query.message.message_id);
    else if (action === "custom") {
      waitingForCustomTime.add(userId);
      bot.sendMessage(userId, "📅 How many minutes from now?");
    } else if (action === "cancel") {
      if (fs.existsSync(pending.filePath)) fs.unlinkSync(pending.filePath);
      pendingStories.delete(userId);
      bot.editMessageText("❌ Canceled.", { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }
  }
});

// ── Execution ─────────────────────────────────────────────────────────────────
(async () => {
  await initDB();
  server.listen(PORT, () => console.log(`🚀 Security authentication panel online on port ${PORT}`));
})();