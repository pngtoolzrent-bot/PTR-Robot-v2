const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// ================= EXPRESS (Render fix) =================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Bot is running"));
app.listen(PORT);

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID);
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!BOT_TOKEN || !ADMIN_ID || !FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Missing ENV variables");
}

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
});

const db = admin.firestore();

// ================= BOT =================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ================= CONSTANTS =================
const CHANNEL = "@ptr_records";

// ================= HELPERS =================
const isAdmin = (id) => String(id) === ADMIN_ID;

// ================= INIT DB =================
async function initDB() {
  const toolRef = db.collection("tools").doc("unlocktool");
  const doc = await toolRef.get();

  if (!doc.exists) {
    await toolRef.set({ name: "UnlockTool" });

    const slots = toolRef.collection("slots");

    for (let i = 1; i <= 5; i++) {
      await slots.doc(`slot${i}`).set({
        userId: null,
        expiresAt: null
      });
    }

    console.log("DB initialized");
  }
}
initDB();

// ================= GET SLOTS =================
async function getSlots() {
  const snap = await db.collection("tools").doc("unlocktool").collection("slots").get();
  const slots = [];
  snap.forEach(d => slots.push({ id: d.id, ...d.data() }));
  return slots;
}

// ================= FIND FREE SLOT =================
async function findFreeSlot() {
  const slots = await getSlots();
  return slots.find(s => !s.userId) || null;
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  await db.collection("users").doc(String(userId)).set({
    username: msg.from.username || null
  }, { merge: true });

  bot.sendMessage(chatId, "👋 Welcome to PNGToolzRent", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛠 Rent Tool", callback_data: "rent" }],
        isAdmin(userId) ? [{ text: "⚙️ Admin Panel", callback_data: "admin" }] : []
      ]
    }
  });
});

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  bot.answerCallbackQuery(q.id);

  // ================= RENT =================
  if (data === "rent") {
    const slot = await findFreeSlot();

    if (!slot) {
      return bot.sendMessage(chatId, "❌ No slots available right now.");
    }

    await db.collection("requests").doc(String(userId)).set({
      toolId: "unlocktool",
      slotId: slot.id,
      status: "pending"
    });

    return bot.sendMessage(chatId, "Choose duration:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "6 Hours - K10", callback_data: "rate_6" }],
          [{ text: "12 Hours - K18", callback_data: "rate_12" }]
        ]
      }
    });
  }

  // ================= RATE =================
  if (data.startsWith("rate_")) {
    const hours = data === "rate_6" ? 6 : 12;

    await db.collection("requests").doc(String(userId)).update({
      rate: hours
    });

    return bot.sendMessage(chatId, "Choose payment method:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏦 BSP", callback_data: "pay_bsp" }],
          [{ text: "📱 CellMoni", callback_data: "pay_cell" }]
        ]
      }
    });
  }

  // ================= PAYMENT =================
  if (data === "pay_bsp" || data === "pay_cell") {
    const method = data === "pay_bsp" ? "BSP" : "CellMoni";

    await db.collection("requests").doc(String(userId)).update({
      payment: method
    });

    const details =
      method === "BSP"
        ? "🏦 BSP Account: 0001196222\nSend receipt after payment."
        : "📱 CellMoni Number: 74703925\nSend receipt after payment.";

    return bot.sendMessage(chatId, details);
  }

  // ================= ADMIN PANEL =================
  if (data === "admin") {
    if (!isAdmin(userId)) return;

    const slots = await getSlots();

    const text = slots.map(s =>
      `${s.id} - ${s.userId ? `USED (${s.userId})` : "FREE"}`
    ).join("\n");

    return bot.sendMessage(chatId, `⚙️ Admin Panel\n\n${text}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Refresh", callback_data: "admin" }]
        ]
      }
    });
  }

  // ================= APPROVE =================
  if (data.startsWith("approve_")) {
    if (!isAdmin(userId)) return;

    const targetId = data.split("_")[1];

    const reqDoc = await db.collection("requests").doc(targetId).get();
    if (!reqDoc.exists) return;

    const req = reqDoc.data();

    const expiresAt = Date.now() + (req.rate * 3600000);

    await db.collection("tools")
      .doc(req.toolId)
      .collection("slots")
      .doc(req.slotId)
      .update({
        userId: targetId,
        expiresAt
      });

    await db.collection("requests").doc(targetId).update({
      status: "approved"
    });

    bot.sendMessage(targetId, "✅ Approved. Your session is active.");
    bot.sendMessage(chatId, "Approved.");
  }

  // ================= REJECT =================
  if (data.startsWith("reject_")) {
    if (!isAdmin(userId)) return;

    const targetId = data.split("_")[1];

    await db.collection("requests").doc(targetId).update({
      status: "rejected"
    });

    bot.sendMessage(targetId, "❌ Payment rejected.");
  }
});

// ================= RECEIPTS =================
bot.on("message", async (msg) => {
  const userId = msg.from.id;

  if (msg.photo) {
    const fileId = msg.photo.pop().file_id;

    const reqDoc = await db.collection("requests").doc(String(userId)).get();
    if (!reqDoc.exists) return;

    const req = reqDoc.data();

    // forward to admin
    bot.sendPhoto(ADMIN_ID, fileId, {
      caption: `User: ${userId}`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Approve", callback_data: `approve_${userId}` }],
          [{ text: "Reject", callback_data: `reject_${userId}` }]
        ]
      }
    });

    // forward to record channel
    try {
      await bot.sendPhoto(CHANNEL, fileId, {
        caption: `User: ${userId}\nTool: ${req.toolId}\nStatus: pending`
      });
    } catch (e) {}

    bot.sendMessage(msg.chat.id, "📩 Receipt received. Waiting for admin approval.");
  }
});

// ================= AUTO EXPIRY =================
setInterval(async () => {
  const slotsSnap = await db.collection("tools").doc("unlocktool").collection("slots").get();

  slotsSnap.forEach(async (doc) => {
    const data = doc.data();

    if (data.userId && data.expiresAt && Date.now() > data.expiresAt) {
      await doc.ref.update({
        userId: null,
        expiresAt: null
      });

      try {
        bot.sendMessage(data.userId, "⏳ Your session has expired.");
      } catch {}
    }
  });
}, 60000);
