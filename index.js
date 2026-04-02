const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const admin = require("firebase-admin");

// ================= ENV =================
const TOKEN = process.env.BOT_TOKEN;
const FIREBASE_KEY = process.env.FIREBASE_KEY;
const ADMIN_ID = 8155108761;

if (!TOKEN || !FIREBASE_KEY) {
  console.error("Missing env variables");
  process.exit(1);
}

// ================= FIREBASE =================
const serviceAccount = JSON.parse(FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ================= BOT =================
const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
app.get("/", (req, res) => res.send("Bot running"));
app.listen(process.env.PORT || 3000);

// ================= MEMORY =================
let pendingLoginInput = {};

// ================= BOOTSTRAP =================
async function bootstrap() {
  const toolRef = db.collection("tools").doc("unlocktool");
  const toolDoc = await toolRef.get();

  if (!toolDoc.exists) {
    await toolRef.set({
      name: "UnlockTool",
      emoji: "🔓",
      active: true,
      durationHours: 24
    });
  }

  const slotsSnap = await db.collection("slots")
    .where("tool", "==", "unlocktool")
    .get();

  if (slotsSnap.empty) {
    for (let i = 1; i <= 5; i++) {
      await db.collection("slots").doc(`unlock_slot${i}`).set({
        tool: "unlocktool",
        status: "available",
        bookedBy: null
      });
    }
  }

  console.log("Database ready");
}

bootstrap();

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  await db.collection("users").doc(String(userId)).set({
    username: msg.from.username || null,
    firstSeen: Date.now()
  }, { merge: true });

  const toolsSnap = await db.collection("tools")
    .where("active", "==", true)
    .get();

  const buttons = [];

  toolsSnap.forEach(doc => {
    const t = doc.data();

    buttons.push([{
      text: `${t.emoji} ${t.name}`,
      callback_data: `tool_${doc.id}`
    }]);
  });

  bot.sendMessage(chatId, "🛠 Select a tool:", {
    reply_markup: { inline_keyboard: buttons }
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

    await slotRef.update({
      status: "booked",
      bookedBy: userId
    });

    await db.collection("bookings").doc(String(userId)).set({
      tool: slotDoc.data().tool,
      slot: slotId,
      status: "pending",
      createdAt: Date.now()
    });

    bot.sendMessage(chatId, "💳 Send your receipt now.");

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

    bot.sendMessage(ADMIN_ID, "✍️ Send login details");
    bot.sendMessage(targetUser, "✅ Approved. Waiting for login...");
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

    bot.sendMessage(targetUser, "❌ Rejected");
  }
});

// ================= RECEIPT =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.text && msg.text.startsWith("/")) return;

  const bookingRef = db.collection("bookings").doc(String(userId));
  const booking = await bookingRef.get();

  if (!booking.exists) return;

  if (msg.photo || msg.document) {
    const fileId = msg.photo
      ? msg.photo[msg.photo.length - 1].file_id
      : msg.document.file_id;

    await bookingRef.update({
      receiptFileId: fileId
    });

    bot.sendMessage(chatId, "✅ Receipt received. Waiting for approval.");

    bot.sendPhoto(ADMIN_ID, fileId, {
      caption: `Receipt from ${userId}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve_${userId}` },
            { text: "❌ Reject", callback_data: `reject_${userId}` }
          ]
        ]
      }
    });
  }

  // ADMIN LOGIN INPUT
  if (userId === ADMIN_ID && pendingLoginInput[ADMIN_ID]) {
    const targetUser = pendingLoginInput[ADMIN_ID];

    bot.sendMessage(targetUser, `🔐 Login Details:\n\n${msg.text}`);
    bot.sendMessage(ADMIN_ID, "✅ Sent");

    delete pendingLoginInput[ADMIN_ID];

    await db.collection("bookings").doc(targetUser).update({
      status: "active",
      expiresAt: Date.now() + (24 * 60 * 60 * 1000)
    });
  }
});

console.log("Bot running...");
