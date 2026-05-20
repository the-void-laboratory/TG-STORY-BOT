/**
 * TG Story Bot
 * Posts photos/videos to your Telegram story via the MTProto client API.
 *
 * How it works:
 * 1. You (the owner) send a photo or video to the bot.
 * 2. The bot receives it and uses your Telegram USER session (GramJS)
 * to post it as a story on your account.
 *
 * Requirements:
 * - BOT_TOKEN      → from @BotFather
 * - API_ID + API_HASH → from https://my.telegram.org/apps
 * - SESSION_STRING → generated once via `node setup.js`
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
const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || "300", 10); // Default 5 minutes (300 seconds)
const OWNER_ID = parseInt(process.env.OWNER_ID, 10); // Only you can use the bot
const MONGODB_URI = process.env.MONGODB_URI;

if (!BOT_TOKEN || !API_ID || !API_HASH) {
  console.error("❌  Missing BOT_TOKEN, API_ID, or API_HASH in .env");
  process.exit(1);
}

// ── Telegram Bot (node-telegram-bot-api) ──────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Handle duplicate polling conflicts gracefully on server deployments
bot.on("polling_error", (error) => {
  if (error.message.includes("409 Conflict")) {
    console.warn("⚠️ Dual polling conflict noticed. Old container is spinning down...");
  } else {
    console.error("📋 Polling Error:", error.message);
  }
});

// ── Settings Persistence ─────────────────────────────────────────────────────
let db, sessionsColl, settingsColl;

async function initDB() {
  if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI not found. Falling back to memory (non-persistent).");
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
    console.warn("⚠️ Falling back to memory (non-persistent) mode.");
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

// Global runtime maps
const activeClients = new Map();
const pendingStories = new Map(); // Store pending stories per user ID
const waitingForCaption = new Set(); // User IDs waiting to send a custom caption
const waitingForCustomTime = new Set(); // User IDs waiting for custom minutes input
const userCooldowns = new Map(); // userId -> lastPostTimestamp (for cooldown)
const loginStates = new Map();   // Track login progress per user

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
    client.invoke(new Api.account.UpdateStatus({ offline: true })).catch((e) => {
      console.warn(`Could not set status to offline for ${userId}:`, e.message);
    });
    return client;
  }
  return null;
}

async function loadUserSettings(userId) {
  const defaults = { currentPrivacy: "all", currentDuration: 86400 };
  if (!settingsColl) return defaults;
  try {
    const settings = await settingsColl.findOne({ userId });
    return settings || defaults;
  } catch (err) {
    console.error(`⚠️ Failed to load settings for ${userId}:`, err);
    return defaults;
  }
}

async function saveUserSettings(userId, privacy, duration) {
  if (!settingsColl) return;
  await settingsColl.updateOne({ userId }, { $set: { currentPrivacy: privacy, currentDuration: duration } }, { upsert: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generates the scheduling inline keyboard with templates or main options.
 */
function getSchedulingKeyboard(showTemplates = false) {
  if (showTemplates) {
    return {
      inline_keyboard: [
        [
          { text: "15m", callback_data: "sched_900" },
          { text: "30m", callback_data: "sched_1800" },
          { text: "1h", callback_data: "sched_3600" }
        ],
        [
          { text: "3h", callback_data: "sched_10800" },
          { text: "6h", callback_data: "sched_21600" },
          { text: "12h", callback_data: "sched_43200" }
        ],
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

/**
 * Download a file from a URL to a temp path.
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.destroy();
        fs.unlink(destPath, () => {});
        return reject(new Error(`Failed to download media: ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }).on("error", (err) => {
      file.destroy();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Logic to handle actual scheduling via setTimeout
 */
function handleScheduling(userId, delaySeconds, userPending, chatId, messageId = null) {
  const storyData = { ...userPending };
  pendingStories.delete(userId);
  userCooldowns.set(userId, Date.now());

  const text = delaySeconds === 0 ? "🚀 Posting now..." : `✅ Scheduled for ${Math.floor(delaySeconds / 60)}m from now.`;
  
  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
  } else {
    bot.sendMessage(chatId, text);
  }

  setTimeout(async () => {
    try {
      const client = await getClient(userId);
      const settings = await loadUserSettings(userId);
      await postToStory(client, storyData.filePath, storyData.isVideo, storyData.caption, settings.currentPrivacy, settings.currentDuration);
      bot.sendMessage(userId, "✅ Your story has been posted!");
    } catch (err) {
      console.error("Scheduled post error:", err);
      bot.sendMessage(userId, `❌ Scheduled post failed: ${err.message}`);
    } finally {
      if (fs.existsSync(storyData.filePath)) fs.unlinkSync(storyData.filePath);
    }
  }, delaySeconds * 1000);
}

/**
 * Post media (photo or video) to the authenticated user's story.
 */
async function postToStory(client, filePath, isVideo, caption = "", privacy, duration) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error("Temporary file is missing or empty. Please try again.");
  }

  const uploadedFile = await client.uploadFile({ 
    file: filePath,
    workers: 4,
  });

  let media;
  if (isVideo) {
    media = new Api.InputMediaUploadedDocument({
      file: uploadedFile,
      mimeType: "video/mp4",
      attributes: [new Api.DocumentAttributeVideo({
        duration: 0,
        w: 0,
        h: 0,
        supportsStreaming: true,
      })],
    });
  } else {
    media = new Api.InputMediaUploadedPhoto({
      file: uploadedFile,
    });
  }

  let privacyRules;
  if (privacy === "contacts") {
    privacyRules = [new Api.InputPrivacyValueAllowContacts()];
  } else if (privacy === "closeFriends") {
    privacyRules = [new Api.InputPrivacyValueAllowCloseFriends()];
  } else {
    privacyRules = [new Api.InputPrivacyValueAllowAll()];
  }

  const result = await client.invoke(
    new Api.stories.SendStory({
      peer: new Api.InputPeerSelf(),
      media,
      privacyRules,
      caption: caption || undefined,
      period: duration,
    })
  );

  return result;
}

// ── Bot Handlers ──────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 *Story Bot is ready!*\n\nTo post stories, you must first link your account.\n\n🔐 /login - Link your Telegram account\n🚪 /logout - Remove your account\n📜 /list - View your active stories\n⚙️ /privacy - Set visibility\n⏱ /duration - Set story life\n\n📸 Supported: JPEG, PNG, MP4`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const session = await getSessionStr(userId);
  if (!session) {
    return bot.sendMessage(userId, "❓ You are not logged in.");
  }

  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Yes, Log Me Out", callback_data: "logout_confirm_yes" }],
        [{ text: "❌ No, Keep Me Logged In", callback_data: "logout_confirm_no" }]
      ],
    },
    parse_mode: "Markdown"
  };

  await bot.sendMessage(userId, "🚨 Are you sure you want to log out? This will remove your linked Telegram account from the bot.", opts);
});

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const client = await getClient(userId);
  if (client) return bot.sendMessage(userId, "✅ You are already logged in!");

  if (loginStates.has(userId)) {
    const currentClient = loginStates.get(userId).client;
    if (currentClient && currentClient.connected) currentClient.disconnect();
    loginStates.delete(userId);
  }

  loginStates.set(userId, { step: "PHONE" });
  bot.sendMessage(userId, "📱 Please send your phone number in international format (e.g., +1234567890).");
});

bot.on("message", async (msg) => {
  const userId = msg.from.id;

  // Handle custom schedule time input
  if (waitingForCustomTime.has(userId) && msg.text && !msg.text.startsWith("/")) {
    const minutes = parseInt(msg.text, 10);
    if (isNaN(minutes) || minutes < 1) {
      return bot.sendMessage(userId, "❌ Please enter a valid number of minutes (e.g., 45).");
    }
    waitingForCustomTime.delete(userId);
    const userPending = pendingStories.get(userId);
    if (userPending) {
      handleScheduling(userId, minutes * 60, userPending, msg.chat.id);
    }
    return;
  }

  // Handle custom caption input
  if (waitingForCaption.has(userId) && msg.text && !msg.text.startsWith("/")) {
    const userPending = pendingStories.get(userId);
    if (userPending) {
      userPending.caption = msg.text;
      waitingForCaption.delete(userId);
      return bot.sendMessage(userId, `✅ Caption set to: *${msg.text}*\n\nWhen should I post it?`, {
        parse_mode: "Markdown",
        reply_markup: getSchedulingKeyboard(),
      });
    }
    waitingForCaption.delete(userId);
  }

  const state = loginStates.get(userId);
  if (!state || !msg.text || msg.text.startsWith("/")) return;

  try {
    if (state.step === "PHONE") {
      const cleanPhone = msg.text.replace(/\s+/g, "");
      const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });
      await client.connect();

      // Setup deferred promise placeholders so client.start can asynchronously receive parameters via chat updates
      let resolveCode, resolvePassword;
      const codePromise = new Promise((resolve) => { resolveCode = resolve; });
      const passwordPromise = new Promise((resolve) => { resolvePassword = resolve; });

      // Trigger the background execution loop using GramJS's robust auth lifecycle
      client.start({
        phoneNumber: async () => cleanPhone,
        phoneCode: async () => await codePromise,
        password: async () => await passwordPromise,
        onError: (err) => { throw err; }
      }).then(async () => {
        await finishLogin(userId, client);
      }).catch((err) => {
        console.error("Async login internal error:", err);
        bot.sendMessage(userId, `❌ Login process broken: ${err.message}`);
        loginStates.delete(userId);
      });

      loginStates.set(userId, { step: "CODE", client, resolveCode, resolvePassword });
      bot.sendMessage(userId, "📬 Enter the code Telegram just sent you:");

    } else if (state.step === "CODE") {
      const { resolveCode } = state;
      loginStates.set(userId, { ...state, step: "2FA_CHECK" });
      
      // Send code response directly to GramJS promise holder
      resolveCode(msg.text.trim());

      // Give the background execution engine time to evaluate if a 2FA prompt is needed
      setTimeout(() => {
        const currentState = loginStates.get(userId);
        if (currentState && currentState.step === "2FA_CHECK") {
          loginStates.set(userId, { ...currentState, step: "2FA" });
          bot.sendMessage(userId, "🔑 2FA is enabled. Please enter your cloud password:");
        }
      }, 2500);

    } else if (state.step === "2FA" || state.step === "2FA_CHECK") {
      const { resolvePassword } = state;
      resolvePassword(msg.text.trim());
    }
  } catch (err) {
    console.error("Login initialization setup error:", err);
    bot.sendMessage(userId, `❌ Setup initialization failed: ${err.message}. Use /login to try again.`);
    loginStates.delete(userId);
  }
});

async function finishLogin(userId, client) {
  const sessionStr = client.session.save();
  await saveSession(userId, sessionStr);
  activeClients.set(userId, client);
  loginStates.delete(userId);
  bot.sendMessage(userId, "✅ Account linked successfully! You can now send photos/videos to post as stories.");
}

bot.onText(/\/status/, async (msg) => {
  const client = await getClient(msg.from.id);
  const connected = client && client.connected;
  bot.sendMessage(msg.chat.id, connected ? "✅ Client connected." : "❌ Client disconnected. Restart the bot.");
});

bot.onText(/\/backup/, (msg) => {
  if (msg.from.id !== OWNER_ID) return;
  bot.sendMessage(msg.chat.id, "💾 Data is now stored in MongoDB. Use Railway dashboard for backups.");
});

bot.onText(/\/privacy/, async (msg) => {
  const userId = msg.from.id;
  const session = await getSessionStr(userId);
  if (!session) return bot.sendMessage(userId, "❌ Link your account first with /login");

  const settings = await loadUserSettings(userId);

  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Everyone", callback_data: "set_privacy_all" }],
        [{ text: "Contacts Only", callback_data: "set_privacy_contacts" }],
        [{ text: "Close Friends Only", callback_data: "set_privacy_closeFriends" }],
      ],
    },
  };

  bot.sendMessage(
    msg.chat.id,
    `Current privacy: *${settings.currentPrivacy}*\n\nSelect who can see your future stories:`,
    { ...opts, parse_mode: "Markdown" }
  );
});

bot.onText(/\/duration/, async (msg) => {
  const userId = msg.from.id;
  const session = await getSessionStr(userId);
  if (!session) return bot.sendMessage(userId, "❌ Link your account first with /login");

  const settings = await loadUserSettings(userId);

  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "6 Hours", callback_data: "set_duration_21600" },
          { text: "12 Hours", callback_data: "set_duration_43200" },
        ],
        [
          { text: "24 Hours", callback_data: "set_duration_86400" },
          { text: "48 Hours", callback_data: "set_duration_172800" },
        ],
      ],
    },
  };

  bot.sendMessage(
    msg.chat.id,
    `Current story duration: *${settings.currentDuration / 3600} hours*\n\nSelect how long your future stories should stay up:`,
    { ...opts, parse_mode: "Markdown" }
  );
});

bot.onText(/\/list/, async (msg) => {
  const client = await getClient(msg.from.id);
  if (!client) return bot.sendMessage(msg.from.id, "❌ Link your account first with /login");
  await sendStoryList(client, msg.chat.id);
});

async function sendStoryList(client, chatId, messageId = null) {
  try {
    if (!client) return;

    const result = await client.invoke(
      new Api.stories.GetPeerStories({
        peer: new Api.InputPeerSelf(),
      })
    );

    const storiesList = result.stories?.stories || [];
    const activeStories = storiesList.filter(s => s.className === "StoryItem");

    let text = "🎞 *Your Active Stories:*\n\n";
    const inline_keyboard = [];
    const now = Math.floor(Date.now() / 1000);

    if (activeStories.length === 0) {
      text = "📭 You have no active stories.";
    } else {
      activeStories.forEach((story, index) => {
        const timeLeft = story.expireDate - now;
        const hours = Math.floor(timeLeft / 3600);
        const mins = Math.floor((timeLeft % 3600) / 60);
        
        const caption = story.caption || "_No caption_";
        const isVideo = story.media && story.media.className === "MessageMediaDocument";
        const type = isVideo ? "🎥 Video" : "📸 Photo";
        const views = story.views?.viewsCount || 0;

        text += `${index + 1}. ${type} (ID: ${story.id})\n`;
        text += `📝 Caption: ${caption}\n`;
        text += `👁 Views: ${views}\n`;
        text += `⏳ Expires in: ${hours}h ${mins}m\n\n`;

        inline_keyboard.push([{ text: `🗑️ Delete Story ${story.id}`, callback_data: `delete_story_${story.id}` }]);
      });
    }

    const opts = {
      parse_mode: "Markdown",
      reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
    };

    if (messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
    } else {
      await bot.sendMessage(chatId, text, opts);
    }

  } catch (err) {
    console.error("List stories error:", err);
    bot.sendMessage(chatId, `❌ Failed to fetch stories: ${err.message}`);
  }
}

bot.on("callback_query", async (query) => {
  const data = query.data;
  const userId = query.from.id;
  const isOwner = OWNER_ID && userId === OWNER_ID;

  if (data.startsWith("set_privacy_")) {
    const newPrivacy = data.replace("set_privacy_", "");
    const settings = await loadUserSettings(userId);
    await saveUserSettings(userId, newPrivacy, settings.currentDuration);

    bot.answerCallbackQuery(query.id, { text: `Privacy updated!` });
    bot.editMessageText(`✅ Privacy updated to: *${newPrivacy}*`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  }
  else if (data.startsWith("set_duration_")) {
    const newDuration = parseInt(data.replace("set_duration_", ""), 10);
    const settings = await loadUserSettings(userId);
    await saveUserSettings(userId, settings.currentPrivacy, newDuration);

    bot.answerCallbackQuery(query.id, { text: `Duration updated!` });
    bot.editMessageText(`✅ Story duration updated to: *${newDuration / 3600} hours*`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  } else if (data.startsWith("sched_")) {
    const userPending = pendingStories.get(userId);
    if (!userPending) {
      return bot.answerCallbackQuery(query.id, { text: "No pending media found." });
    }

    const action = data.replace("sched_", "");

    if (action === "templates") {
      return bot.editMessageReplyMarkup(getSchedulingKeyboard(true), {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    }

    if (action === "main_menu") {
      return bot.editMessageReplyMarkup(getSchedulingKeyboard(false), {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    }

    if (action === "custom") {
      waitingForCustomTime.add(userId);
      return bot.sendMessage(userId, "📅 How many minutes from now should I post the story? (e.g., 30)");
    }

    if (action === "edit_caption") {
      waitingForCaption.add(userId);
      bot.sendMessage(userId, "✏️ Please send the new caption for your story:");
      return bot.answerCallbackQuery(query.id);
    }

    if (action === "cancel") {
      if (fs.existsSync(userPending.filePath)) fs.unlinkSync(userPending.filePath);
      pendingStories.delete(userId);
      waitingForCaption.delete(userId);
      waitingForCustomTime.delete(userId);
      return bot.editMessageText("❌ Canceled.", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    }

    const delaySeconds = action === "now" ? 0 : parseInt(action, 10);
    handleScheduling(userId, delaySeconds, userPending, query.message.chat.id, query.message.message_id);
  } else if (data.startsWith("delete_story_")) {
    if (!isOwner) return bot.answerCallbackQuery(query.id, { text: "⛔ Owner only." });

    const storyId = parseInt(data.replace("delete_story_", ""), 10);
    if (isNaN(storyId)) {
      return bot.answerCallbackQuery(query.id, { text: "Invalid story ID." });
    }

    try {
      const client = await getClient(userId);
      await client.invoke(
        new Api.stories.DeleteStories({
          id: [storyId],
        })
      );
      await bot.answerCallbackQuery(query.id, { text: `Story ${storyId} deleted!` });
      await sendStoryList(client, query.message.chat.id, query.message.message_id);
    } catch (err) {
      console.error("Delete story error:", err);
      bot.answerCallbackQuery(query.id, { text: `❌ Failed to delete story: ${err.message}` });
    }
  } else if (data === "logout_confirm_yes") {
    const messageId = query.message.message_id;

    const client = activeClients.get(userId);
    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        console.error("Error disconnecting client during logout:", err);
      }
      activeClients.delete(userId);
    }

    await deleteSession(userId);

    await bot.answerCallbackQuery(query.id, { text: "Logging out..." });
    await bot.editMessageText("✅ You have been successfully logged out. Your session has been deleted.", {
      chat_id: userId,
      message_id: messageId,
      parse_mode: "Markdown"
    });
  } else if (data === "logout_confirm_no") {
    const messageId = query.message.message_id;

    await bot.answerCallbackQuery(query.id, { text: "Logout cancelled." });
    await bot.editMessageText("❌ Logout cancelled. You are still logged in.", {
      chat_id: userId,
      message_id: messageId,
      parse_mode: "Markdown"
    });
  }
});

// Handle photos
bot.on("photo", async (msg) => {
  const userId = msg.from.id;
  waitingForCaption.delete(userId);

  const client = await getClient(userId);
  if (!client) return bot.sendMessage(userId, "❌ You must link your Telegram account first! Use /login.");

  const lastPostTime = userCooldowns.get(userId);
  if (lastPostTime) {
    const timeElapsed = (Date.now() - lastPostTime) / 1000;
    if (timeElapsed < COOLDOWN_SECONDS) {
      const remainingSeconds = Math.ceil(COOLDOWN_SECONDS - timeElapsed);
      return bot.sendMessage(msg.chat.id,
        `⏳ Please wait ${remainingSeconds} seconds before posting another story.`);
    }
  }

  const tempPath = path.join(__dirname, `story_photo_${Date.now()}.jpg`);

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const fileInfo = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

    await downloadFile(fileUrl, tempPath);
    pendingStories.set(userId, { filePath: tempPath, isVideo: false, caption: msg.caption || "" });

    bot.sendMessage(msg.chat.id, "📸 Photo received! When should I post it?", {
      reply_markup: getSchedulingKeyboard(),
    });
  } catch (err) {
    console.error("Photo story error:", err);
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

// Handle videos
bot.on("video", async (msg) => {
  const userId = msg.from.id;
  waitingForCaption.delete(userId);

  const client = await getClient(userId);
  if (!client) return bot.sendMessage(userId, "❌ You must link your Telegram account first! Use /login.");

  const lastPostTime = userCooldowns.get(userId);
  if (lastPostTime) {
    const timeElapsed = (Date.now() - lastPostTime) / 1000;
    if (timeElapsed < COOLDOWN_SECONDS) {
      const remainingSeconds = Math.ceil(COOLDOWN_SECONDS - timeElapsed);
      return bot.sendMessage(msg.chat.id,
        `⏳ Please wait ${remainingSeconds} seconds before posting another story.`);
    }
  }

  const tempPath = path.join(__dirname, `story_video_${Date.now()}.mp4`);

  try {
    const fileInfo = await bot.getFile(msg.video.file_id);

    if (msg.video.file_size > 20 * 1024 * 1024) {
      throw new Error("Video exceeds 20MB Bot API limit. Please compress and retry.");
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    await downloadFile(fileUrl, tempPath);

    pendingStories.set(userId, { filePath: tempPath, isVideo: true, caption: msg.caption || "" });

    bot.sendMessage(msg.chat.id, "🎥 Video received! When should I post it?", {
      reply_markup: getSchedulingKeyboard(),
    });
  } catch (err) {
    console.error("Video story error:", err);
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await initDB();
  console.log("🤖 Bot polling started. Users can now link accounts via /login.");
})();