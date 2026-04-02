const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// ================= EXPRESS =================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Bot Running ✅"));
app.listen(PORT);

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID);
const CHANNEL = "@ptr_records";

if (!BOT_TOKEN || !ADMIN_ID || !process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Missing ENV");
}

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

// ================= BOT =================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ================= STATE =================
const userFlow = {};

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

    console.log("Slots created");
  }
}
initDB();

// ================= GET SLOTS =================
async function getSlots(toolId) {
  const snap = await db.collection("tools").doc(toolId).collection("slots").get();

  const slots = [];
  snap.forEach(doc => {
    slots.push({ id: doc.id, ...doc.data() });
  });

  return slots;
}

// ================= FIND FREE SLOT =================
async function findFreeSlot(toolId) {
  const slots = await getSlots(toolId);

  for (let slot of slots) {
    if (!slot.userId) return slot;
  }

  return null;
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;

  await db.collection("users").doc(String(userId)).set({
    username: msg.from.username || null
  }, { merge: true });

  bot.sendMessage(msg.chat.id, "Welcome to PNGToolzRent", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛠 Rent Tool", callback_data: "rent" }],
        isAdmin(userId) ? [{ text: "⚙️ Admin", callback_data: "admin" }] : []
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

  // ===== RENT =====
  if (data === "rent") {
    const freeSlot = await findFreeSlot("unlocktool");

    if (!freeSlot) {
      return bot.sendMessage(chatId, "❌ All slots are full. Try later.");
    }

    userFlow[userId] = { toolId: "unlocktool", slotId: freeSlot.id };

    return bot.sendMessage(chatId, "Choose Duration", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "6 Hours - K10", callback_data: "rate_6" }],
          [{ text: "12 Hours - K18", callback_data: "rate_12" }]
        ]
      }
    });
  }

  // ===== RATE =====
  if (data.startsWith("rate_")) {
    const hours = data === "rate_6" ? 6 : 12;
    userFlow[userId].rate = hours;

    return bot.sendMessage(chatId, "Select Payment Method", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏦 BSP", callback_data: "pay_bsp" }],
          [{ text: "📱 CellMoni", callback_data: "pay_cell" }]
        ]
      }
    });
  }

  // ===== PAYMENT =====
  if (data === "pay_bsp" || data === "pay_cell") {
    const method = data === "pay_bsp" ? "BSP" : "CellMoni";
    userFlow[userId].payment = method;

    const details = method === "BSP"
      ? "Account#: 0001196222"
      : "Number: 74703925";

    bot.sendMessage(chatId, `Send receipt:\n\n${details}`);
  }

  // ===== APPROVE =====
  if (data.startsWith("approve_")) {
    if (!isAdmin(userId)) return;

    const targetId = data.split("_")[1];
    const flow = userFlow[targetId];

    const expiresAt = Date.now() + (flow.rate * 3600000);

    await db.collection("tools")
      .doc(flow.toolId)
      .collection("slots")
      .doc(flow.slotId)
      .update({
        userId: targetId,
        expiresAt
      });

    bot.sendMessage(targetId, "✅ Approved. Session active.");
  }

  // ===== REJECT =====
  if (data.startsWith("reject_")) {
    if (!isAdmin(userId)) return;

    const targetId = data.split("_")[1];
    bot.sendMessage(targetId, "❌ Rejected.");
  }
});

// ================= RECEIPT =================
bot.on("message", async (msg) => {
  const userId = msg.from.id;

  if (msg.photo && userFlow[userId]) {
    const fileId = msg.photo.pop().file_id;

    bot.sendPhoto(ADMIN_ID, fileId, {
      caption: `User: ${userId}`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Approve", callback_data: `approve_${userId}` }],
          [{ text: "Reject", callback_data: `reject_${userId}` }]
        ]
      }
    });

    try {
      await bot.sendPhoto(CHANNEL, fileId);
    } catch {}

    bot.sendMessage(msg.chat.id, "Waiting for approval...");
  }
});

// ================= AUTO EXPIRY =================
setInterval(async () => {
  const tools = await db.collection("tools").get();

  tools.forEach(async toolDoc => {
    const slots = await toolDoc.ref.collection("slots").get();

    slots.forEach(async slotDoc => {
      const slot = slotDoc.data();

      if (slot.userId && slot.expiresAt && Date.now() > slot.expiresAt) {
        await slotDoc.ref.update({
          userId: null,
          expiresAt: null
        });

        bot.sendMessage(slot.userId, "⏳ Session expired.");
      }
    });
  });
}, 60000);
