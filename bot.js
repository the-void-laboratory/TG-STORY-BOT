/**
 * TG Story Bot
 * Posts photos/videos to your Telegram story via the MTProto client API.
 *
 * How it works:
 *  1. You (the owner) send a photo or video to the bot.
 *  2. The bot receives it and uses your Telegram USER session (GramJS)
 *     to post it as a story on your account.
 *
 * Requirements:
 *  - BOT_TOKEN      → from @BotFather
 *  - API_ID + API_HASH → from https://my.telegram.org/apps
 *  - SESSION_STRING → generated once via `node setup.js`
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
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

if (!BOT_TOKEN || !API_ID || !API_HASH) {
  console.error("❌  Missing BOT_TOKEN, API_ID, or API_HASH in .env");
  process.exit(1);
}

// ── Telegram User Client (GramJS) ─────────────────────────────────────────────
const session = new StringSession(SESSION_STRING);
const client = new TelegramClient(session, API_ID, API_HASH, {
  connectionRetries: 5,
});

// ── Telegram Bot (node-telegram-bot-api) ──────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── Settings Persistence ─────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, "settings.json");

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = fs.readFileSync(SETTINGS_PATH, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("⚠️ Failed to load settings:", err);
  }
  return { currentPrivacy: "all", currentDuration: 86400 };
}

function saveSettings() {
  const data = JSON.stringify({ currentPrivacy, currentDuration }, null, 2);
  fs.writeFileSync(SETTINGS_PATH, data, "utf8");
}

// ── State ────────────────────────────────────────────────────────────────────
const savedSettings = loadSettings();
let currentPrivacy = savedSettings.currentPrivacy;
let currentDuration = savedSettings.currentDuration;

const pendingStories = new Map(); // Store pending stories per user ID
const userCooldowns = new Map(); // userId -> lastPostTimestamp (for cooldown)

// ── Helpers ───────────────────────────────────────────────────────────────────

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
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      fs.unlink(destPath, () => reject(err));
    });
  });
}

/**
 * Post media (photo or video) to the authenticated user's story.
 */
async function postToStory(filePath, isVideo, caption = "") {
  // Upload the file via GramJS
  const uploadedFile = await client.uploadFile({
    file: filePath,
    workers: 4,
  });

  // Build media object
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

  // Determine privacy based on current state
  let privacyRules;
  if (currentPrivacy === "contacts") {
    privacyRules = [new Api.InputPrivacyValueAllowContacts()];
  } else if (currentPrivacy === "closeFriends") {
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
      period: currentDuration,
    })
  );

  return result;
}

// ── Bot Handlers ──────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 *Story Bot is ready!*\n\nJust send me a photo or video and I'll post it to your Telegram story immediately.\n\n⚙️ /privacy - Change who can see your stories\n⏱ /duration - Set how long stories last\n📜 /list - View active stories\n📊 /status - Check connection\n\n📸 Supported: JPEG, PNG, MP4\n⏱ Current duration: ${currentDuration / 3600}h`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, async (msg) => {
  if (OWNER_ID && msg.from.id !== OWNER_ID) return;
  const connected = client.connected;
  bot.sendMessage(msg.chat.id, connected ? "✅ Client connected." : "❌ Client disconnected. Restart the bot.");
});

// Privacy Menu
bot.onText(/\/privacy/, (msg) => {
  if (OWNER_ID && msg.from.id !== OWNER_ID) return;

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
    `Current privacy: *${currentPrivacy}*\n\nSelect who can see your future stories:`,
    { ...opts, parse_mode: "Markdown" }
  );
});

// Duration Menu
bot.onText(/\/duration/, (msg) => {
  if (OWNER_ID && msg.from.id !== OWNER_ID) return;

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
    `Current story duration: *${currentDuration / 3600} hours*\n\nSelect how long your future stories should stay up:`,
    { ...opts, parse_mode: "Markdown" }
  );
});

// List Active Stories
bot.onText(/\/list/, async (msg) => {
  if (OWNER_ID && msg.from.id !== OWNER_ID) return;

  await sendStoryList(msg.chat.id);
});

// Helper function to fetch and send/edit the story list
async function sendStoryList(chatId, messageId = null) {
  try {
    // Fetch active stories for the current user
    const result = await client.invoke(
      new Api.stories.GetPeerStories({
        peer: new Api.InputPeerSelf(),
      })
    );

    // result.stories is the PeerStories object, which has a stories array
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

// Handle menu interactions
bot.on("callback_query", async (query) => { // Made async to handle API calls
  const data = query.data;
  const userId = query.from.id;
  const isOwner = OWNER_ID && userId === OWNER_ID;

  if (data.startsWith("set_privacy_")) { // Owner-only
    if (!isOwner) return bot.answerCallbackQuery(query.id, { text: "⛔ Owner only." });
    currentPrivacy = data.replace("set_privacy_", "");
    saveSettings();
    
    bot.answerCallbackQuery(query.id, { text: `Privacy updated!` });
    bot.editMessageText(`✅ Privacy updated to: *${currentPrivacy}*`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  }
  else if (data.startsWith("set_duration_")) { // Owner-only
    if (!isOwner) return bot.answerCallbackQuery(query.id, { text: "⛔ Owner only." });
    currentDuration = parseInt(data.replace("set_duration_", ""), 10);
    saveSettings();

    bot.answerCallbackQuery(query.id, { text: `Duration updated!` });
    bot.editMessageText(`✅ Story duration updated to: *${currentDuration / 3600} hours*`, {
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
    if (action === "cancel") {
      if (fs.existsSync(userPending.filePath)) fs.unlinkSync(userPending.filePath);
      pendingStories.delete(userId);
      return bot.editMessageText("❌ Canceled.", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    }

    const delaySeconds = action === "now" ? 0 : parseInt(action, 10);
    const storyData = { ...userPending };
    pendingStories.delete(userId); // Clear state so user can queue another
    userCooldowns.set(userId, Date.now()); // Record post time for cooldown

    bot.editMessageText(delaySeconds === 0 ? "🚀 Posting now..." : `✅ Scheduled for ${delaySeconds / 3600}h from now.`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });

    setTimeout(async () => {
      try {
        await postToStory(storyData.filePath, storyData.isVideo, storyData.caption);
        bot.sendMessage(userId, "✅ Your story has been posted!"); // Notify the user who scheduled it
      } catch (err) {
        console.error("Scheduled post error:", err);
        bot.sendMessage(userId, `❌ Scheduled post failed: ${err.message}`); // Notify the user
      } finally {
        if (fs.existsSync(storyData.filePath)) fs.unlinkSync(storyData.filePath);
      }
    }, delaySeconds * 1000);
  } else if (data.startsWith("delete_story_")) { // Owner-only
    if (!isOwner) return bot.answerCallbackQuery(query.id, { text: "⛔ Owner only." });

    const storyId = parseInt(data.replace("delete_story_", ""), 10);
    if (isNaN(storyId)) {
      return bot.answerCallbackQuery(query.id, { text: "Invalid story ID." });
    }

    try {
      await client.invoke(
        new Api.stories.DeleteStories({
          id: [storyId],
        })
      );
      await bot.answerCallbackQuery(query.id, { text: `Story ${storyId} deleted!` });
      // Re-send/edit the list message to reflect the deletion
      await sendStoryList(query.message.chat.id, query.message.message_id);
    } catch (err) {
      console.error("Delete story error:", err);
      bot.answerCallbackQuery(query.id, { text: `❌ Failed to delete story: ${err.message}` });
    }
  }
});

// Handle photos
bot.on("photo", async (msg) => { // Public access
  const userId = msg.from.id;

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
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Post Now", callback_data: "sched_now" }],
          [
            { text: "⏰ In 1 Hour", callback_data: "sched_3600" },
            { text: "⏰ In 6 Hours", callback_data: "sched_21600" },
          ],
          [{ text: "❌ Cancel", callback_data: "sched_cancel" }],
        ],
      },
    });
  } catch (err) {
    console.error("Photo story error:", err);
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

// Handle videos
bot.on("video", async (msg) => { // Public access
  const userId = msg.from.id;

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

    // Bot API has a 20MB download limit
    if (msg.video.file_size > 20 * 1024 * 1024) {
      throw new Error("Video exceeds 20MB Bot API limit. Please compress and retry.");
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    await downloadFile(fileUrl, tempPath);

    pendingStories.set(userId, { filePath: tempPath, isVideo: true, caption: msg.caption || "" });

    bot.sendMessage(msg.chat.id, "🎥 Video received! When should I post it?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Post Now", callback_data: "sched_now" }],
          [
            { text: "⏰ In 1 Hour", callback_data: "sched_3600" },
            { text: "⏰ In 6 Hours", callback_data: "sched_21600" },
          ],
          [{ text: "❌ Cancel", callback_data: "sched_cancel" }],
        ],
      },
    });
  } catch (err) {
    console.error("Video story error:", err);
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log("🔌 Connecting Telegram user client...");
  await client.connect();

  if (!await client.isUserAuthorized()) {
    console.error("❌  User client not authorized. Run `node setup.js` first to generate SESSION_STRING.");
    process.exit(1);
  }

  console.log("✅ User client connected.");
  console.log("🤖 Bot polling started. Send a photo or video to post to your story!");
})();
