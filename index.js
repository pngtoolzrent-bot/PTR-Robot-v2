const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const admin = require("firebase-admin");

const TOKEN = process.env.BOT_TOKEN;
const FIREBASE_KEY = process.env.FIREBASE_KEY;

if (!TOKEN || !FIREBASE_KEY) {
  console.error("Missing env variables");
  process.exit(1);
}

// Firebase init
const serviceAccount = JSON.parse(FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Bot init
const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
app.get("/", (req, res) => res.send("Bot running"));
app.listen(process.env.PORT || 3000);

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

  const slotsSnap = await db.collection("slots").get();

  if (slotsSnap.empty) {
    for (let i = 1; i <= 5; i++) {
      await db.collection("slots").doc(`slot${i}`).set({
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

  const slotsSnap = await db.collection("slots")
    .where("status", "==", "available")
    .get();

  const buttons = [];

  slotsSnap.forEach(doc => {
    buttons.push([{
      text: `Slot ${doc.id}`,
      callback_data: `slot_${doc.id}`
    }]);
  });

  bot.sendMessage(chatId, "Select a slot:", {
    reply_markup: { inline_keyboard: buttons }
  });
});

// ================= SLOT =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const slotId = query.data.replace("slot_", "");

  const slotRef = db.collection("slots").doc(slotId);
  const slotDoc = await slotRef.get();

  if (!slotDoc.exists || slotDoc.data().status !== "available") {
    bot.sendMessage(chatId, "Slot not available");
    return;
  }

  await slotRef.update({
    status: "booked",
    bookedBy: userId
  });

  await db.collection("bookings").doc(String(userId)).set({
    slot: slotId,
    status: "pending",
    createdAt: Date.now()
  });

  bot.sendMessage(chatId, "Slot booked. Send receipt.");
});

// ================= RECEIPT =================
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;

  const userId = msg.from.id;
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

    bot.sendMessage(msg.chat.id, "Receipt received.");
  }
});

console.log("Bot running...");
