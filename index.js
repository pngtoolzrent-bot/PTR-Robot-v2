const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const admin = require("firebase-admin");

// ================= ENV =================
const TOKEN = process.env.BOT_TOKEN;
const FIREBASE_KEY = process.env.FIREBASE_KEY;
const ADMIN_ID = "8155108761";

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

// ================= MENU =================
function getMainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ["🛠 Select Tool"],
        ["⏳ Check Time"]
      ],
      resize_keyboard: true
    }
  };
}

// ================= BOOTSTRAP =================
async function bootstrap() {
  const toolRef = db.collection("tools").doc("unlocktool");
  const toolDoc = await toolRef.get();

  if (!toolDoc.exists) {
    await toolRef.set({
      name: "UnlockTool",
      emoji: "🔓",
      active: true,
      durationHours: 6
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
        bookedBy: null,
        expiresAt: null
      });
    }
  }

  console.log("Database ready");
}
bootstrap();

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  await db.collection("users").doc(userId).set({
    username: msg.from.username || null,
    firstSeen: Date.now()
  }, { merge: true });

  bot.sendMessage(chatId,
`👋 Welcome to PNGToolzRent

We appreciate you choosing our service 🙌

💰 Pricing:
K10 = 6 Hours Access

Use the buttons below to continue.`,
    getMainMenu()
  );
});

// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (msg.text && msg.text.startsWith("/")) return;

  // 🛠 SELECT TOOL BUTTON
  if (msg.text === "🛠 Select Tool") {

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

    return;
  }

  // ⏳ CHECK TIME BUTTON
  if (msg.text === "⏳ Check Time") {

    const bookingRef = db.collection("bookings").doc(userId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      bot.sendMessage(chatId, "❌ You have no active session.");
      return;
    }

    const data = bookingDoc.data();

    if (data.status !== "active" || !data.expiresAt) {
      bot.sendMessage(chatId, "⏳ No active time running.");
      return;
    }

    const now = Date.now();
    const remaining = data.expiresAt - now;

    if (remaining <= 0) {
      bot.sendMessage(chatId, "⏰ Your session has expired.");
      return;
    }

    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

    bot.sendMessage(chatId, `⏳ Time Remaining: ${hours}h ${minutes}m`);

    return;
  }

  // 📩 RECEIPT HANDLING
  const bookingRef = db.collection("bookings").doc(userId);
  const booking = await bookingRef.get();

  if (!booking.exists) return;

  if (msg.photo || msg.document) {
    const fileId = msg.photo
      ? msg.photo[msg.photo.length - 1].file_id
      : msg.document.file_id;

    await bookingRef.update({
      receiptFileId: fileId
    });

    bot.sendMessage(chatId, "✅ Receipt received. Please wait for approval.");

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

  // ADMIN SEND LOGIN
  if (userId === ADMIN_ID && pendingLoginInput[ADMIN_ID]) {

    const targetUser = pendingLoginInput[ADMIN_ID];
    const bookingRef = db.collection("bookings").doc(targetUser);
    const bookingDoc = await bookingRef.get();

    if (bookingDoc.exists) {
      const slotId = bookingDoc.data().slot;

      const durationHours = 6;
      const expiresAt = Date.now() + (durationHours * 60 * 60 * 1000);

      await bookingRef.update({
        status: "active",
        expiresAt: expiresAt
      });

      await db.collection("slots").doc(slotId).update({
        expiresAt: expiresAt
      });

      bot.sendMessage(targetUser,
`🔐 Login Details:

${msg.text}

⏳ Access Time: 6 Hours

Thank you for using PNGToolzRent 🙌`
      );

      bot.sendMessage(ADMIN_ID, "✅ Login sent & timer started");

      delete pendingLoginInput[ADMIN_ID];
    }
  }
});

// ================= CALLBACK =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const data = query.data;

  // TOOL SELECT
  if (data.startsWith("tool_")) {
    const toolId = data.replace("tool_", "");

    const slotsSnap = await db.collection("slots")
      .where("tool", "==", toolId)
      .get();

    const buttons = [];

    slotsSnap.forEach(doc => {
      if (doc.data().status === "available") {
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

    await db.collection("bookings").doc(userId).set({
      userId: userId,
      slot: slotId,
      status: "pending",
      createdAt: Date.now()
    });

    bot.sendMessage(chatId, "💳 Send your receipt now.");

    bot.sendMessage(
      ADMIN_ID,
      `📥 Booking Request\nUser: ${userId}\nSlot: ${slotId}`,
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

  // APPROVE
  if (data.startsWith("approve_") && userId === ADMIN_ID) {
    const targetUser = data.split("_")[1];

    pendingLoginInput[ADMIN_ID] = targetUser;

    bot.sendMessage(ADMIN_ID, "✍️ Send login details");
    bot.sendMessage(targetUser, "✅ Approved. Waiting for login...");
  }

  // REJECT
  if (data.startsWith("reject_") && userId === ADMIN_ID) {
    const targetUser = data.split("_")[1];

    const booking = await db.collection("bookings").doc(targetUser).get();

    if (booking.exists) {
      const slotId = booking.data().slot;

      await db.collection("slots").doc(slotId).update({
        status: "available",
        bookedBy: null,
        expiresAt: null
      });

      await db.collection("bookings").doc(targetUser).update({
        status: "rejected"
      });
    }

    bot.sendMessage(targetUser, "❌ Booking rejected");
  }
});

// ================= AUTO EXPIRY =================
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
        bookedBy: null,
        expiresAt: null
      });

      bot.sendMessage(data.userId, "⏰ Your time has expired. Slot released.");

      console.log(`Expired: ${doc.id}`);
    }
  });

}, 60000);

console.log("🚀 PNGToolzRent Bot Running...");
