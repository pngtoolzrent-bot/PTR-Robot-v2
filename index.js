const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const admin = require("firebase-admin");

// ================= ENV =================
const TOKEN = process.env.BOT_TOKEN;
const FIREBASE_KEY = process.env.FIREBASE_KEY;
const ADMIN_ID = 8155108761;

if (!TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

if (!FIREBASE_KEY) {
  console.error("Missing FIREBASE_KEY");
  process.exit(1);
}

// ================= FIREBASE INIT =================
const serviceAccount = JSON.parse(FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ================= BOT =================
const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
app.get("/", (req, res) => res.send("Bot running ✅"));
app.listen(process.env.PORT || 3000);

// ================= MEMORY =================
let pendingLoginInput = {};

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  // Save user
  await db.collection("users").doc(String(msg.from.id)).set({
    username: msg.from.username || null,
    firstSeen: Date.now()
  }, { merge: true });

  // Fetch tools from Firebase
  const toolsSnap = await db.collection("tools").where("active", "==", true).get();

  const buttons = [];

  toolsSnap.forEach(doc => {
    const t = doc.data();

    buttons.push([{
      text: `${t.emoji || "🛠"} ${t.name}`,
      callback_data: `tool_${doc.id}`
    }]);
  });

  bot.sendMessage(chatId, "👋 Welcome\n\nSelect a tool:", {
    reply_markup: {
      inline_keyboard: buttons.length ? buttons : [[{ text: "No tools available", callback_data: "none" }]]
    }
  });
});

// ================= CALLBACK =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // TOOL SELECT
  if (data.startsWith("tool_")) {
    const toolId = data.replace("tool_", "");

    const slotsSnap = await db.collection("slots")
      .where("tool", "==", toolId)
      .get();

    const buttons = [];

    slotsSnap.forEach(doc => {
      const slot = doc.data();

      if (slot.status === "available") {
        buttons.push([{
          text: `Slot ${doc.id} ✅`,
          callback_data: `slot_${doc.id}`
        }]);
      } else {
        buttons.push([{
          text: `Slot ${doc.id} ❌`,
          callback_data: "none"
        }]);
      }
    });

    bot.sendMessage(chatId, "📊 Select a slot:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // SLOT SELECT
  if (data.startsWith("slot_")) {
    const slotId = data.replace("slot_", "");

    const slotRef = db.collection("slots").doc(slotId);
    const slotDoc = await slotRef.get();

    if (!slotDoc.exists || slotDoc.data().status !== "available") {
      bot.sendMessage(chatId, "❌ Slot not available");
      return;
    }

    // Book slot
    await slotRef.update({
      status: "booked",
      bookedBy: userId,
      bookedAt: Date.now()
    });

    // Save booking
    await db.collection("bookings").doc(String(userId)).set({
      userId,
      slot: slotId,
      status: "pending",
      createdAt: Date.now()
    }, { merge: true });

    // Ask for receipt
    bot.sendMessage(chatId, "💳 Please send your payment receipt.");

    // Notify admin
    bot.sendMessage(
      ADMIN_ID,
      `📥 New Booking\nUser: ${userId}\nSlot: ${slotId}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `approve_${userId}` },
              { text: "❌ Reject", callback_data: `reject_${userId}` }
            ]
          ]
        }
      }
    );
  }

  // ADMIN APPROVE
  if (data.startsWith("approve_") && userId === ADMIN_ID) {
    const targetUser = data.split("_")[1];

    pendingLoginInput[ADMIN_ID] = targetUser;

    bot.sendMessage(ADMIN_ID, "✍️ Send login details now");
    bot.sendMessage(targetUser, "✅ Receipt approved.\n\nPlease wait while login details are sent.");
  }

  // ADMIN REJECT
  if (data.startsWith("reject_") && userId === ADMIN_ID) {
    const targetUser = data.split("_")[1];

    const booking = await db.collection("bookings").doc(targetUser).get();

    if (booking.exists) {
      const slotId = booking.data().slot;

      await db.collection("slots").doc(slotId).update({
        status: "available",
        bookedBy: null
      });

      await db.collection("bookings").doc(targetUser).update({
        status: "rejected"
      });
    }

    bot.sendMessage(targetUser, "❌ Your request was rejected.");
  }
});

// ================= RECEIPT HANDLER =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.text && msg.text.startsWith("/")) return;

  const booking = await db.collection("bookings").doc(String(userId)).get();
  if (!booking.exists) return;

  if (msg.photo || msg.document) {
    const fileId = msg.photo
      ? msg.photo[msg.photo.length - 1].file_id
      : msg.document.file_id;

    // Acknowledge user (FIXED)
    bot.sendMessage(chatId, "✅ Receipt received. Please wait for admin approval.");

    // Send to admin
    bot.sendPhoto(ADMIN_ID, fileId, {
      caption: `Receipt from user ${userId}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve_${userId}` },
            { text: "❌ Reject", callback_data: `reject_${userId}` }
          ]
        ]
      }
    });

    // Save receipt
    await db.collection("bookings").doc(String(userId)).update({
      receiptFileId: fileId
    });
  }

  // ADMIN LOGIN INPUT
  if (userId === ADMIN_ID && pendingLoginInput[ADMIN_ID]) {
    const targetUser = pendingLoginInput[ADMIN_ID];

    bot.sendMessage(targetUser, `🔐 Login Details:\n\n${msg.text}`);
    bot.sendMessage(ADMIN_ID, "✅ Sent");

    delete pendingLoginInput[ADMIN_ID];

    // Mark booking active
    await db.collection("bookings").doc(targetUser).update({
      status: "active",
      activatedAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24h default
    });
  }
});

// ================= SLOT EXPIRY CHECK =================
setInterval(async () => {
  const now = Date.now();

  const snapshot = await db.collection("bookings")
    .where("status", "==", "active")
    .get();

  snapshot.forEach(async (doc) => {
    const data = doc.data();

    if (data.expiresAt && now >= data.expiresAt) {
      const slotId = data.slot;

      await doc.ref.update({ status: "expired" });

      await db.collection("slots").doc(slotId).update({
        status: "available",
        bookedBy: null
      });

      bot.sendMessage(data.userId, "⏰ Your slot has expired.");
    }
  });

}, 60000);

console.log("Bot running...");
