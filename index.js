const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// ================= EXPRESS =================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("PNGToolzRent Bot Running ✅");
});

app.listen(PORT, () => console.log("Server running on port", PORT));

// ================= ENV =================
if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!process.env.ADMIN_ID) throw new Error("ADMIN_ID missing");
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT missing");

const ADMIN_ID = String(process.env.ADMIN_ID);
const CHANNEL = "@ptr_records";

// ================= FIREBASE =================
let db;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  db = admin.firestore();
} catch (err) {
  console.error("Firebase init failed:", err);
  process.exit(1);
}

// ================= BOT =================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ================= STATE =================
const userFlow = {};

// ================= HELPERS =================
const isAdmin = (id) => String(id) === ADMIN_ID;

// ================= INIT DB =================
async function initDB() {
  try {
    const toolsRef = db.collection("tools");
    const snap = await toolsRef.get();

    if (snap.empty) {
      await toolsRef.doc("unlocktool").set({
        name: "UnlockTool",
        maxSlots: 5
      });

      console.log("Database seeded");
    }
  } catch (err) {
    console.error("DB init error:", err);
  }
}

initDB();

// ================= SLOT STATUS =================
async function getToolStatus(toolId) {
  const toolDoc = await db.collection("tools").doc(toolId).get();
  if (!toolDoc.exists) return null;

  const tool = toolDoc.data();

  const bookingsSnap = await db.collection("bookings")
    .where("tool", "==", toolId)
    .where("status", "==", "active")
    .get();

  const activeCount = bookingsSnap.size;
  const maxSlots = tool.maxSlots || 0;

  let nextAvailableIn = null;

  if (activeCount >= maxSlots) {
    let earliest = null;

    bookingsSnap.forEach(doc => {
      const d = doc.data();
      if (!earliest || d.expiresAt < earliest) {
        earliest = d.expiresAt;
      }
    });

    const diff = earliest - Date.now();
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);

    nextAvailableIn = `${h}h ${m}m`;
  }

  return {
    name: tool.name,
    maxSlots,
    activeCount,
    available: activeCount < maxSlots,
    nextAvailableIn
  };
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;

  await db.collection("users").doc(String(userId)).set({
    username: msg.from.username || null,
    firstName: msg.from.first_name || null
  }, { merge: true });

  showMainMenu(msg.chat.id, userId);
});

// ================= MAIN MENU =================
async function showMainMenu(chatId, userId) {
  const buttons = [
    [{ text: "🛠 Rent Tool", callback_data: "rent" }]
  ];

  if (isAdmin(userId)) {
    buttons.push([{ text: "⚙️ Admin Panel", callback_data: "admin" }]);
  }

  bot.sendMessage(chatId, "Welcome to PNGToolzRent 👋", {
    reply_markup: { inline_keyboard: buttons }
  });
}

// ================= CALLBACK ROUTER =================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  bot.answerCallbackQuery(q.id);

  // ================= ADMIN PANEL =================
  if (data === "admin") {
    if (!isAdmin(userId)) return;

    return bot.sendMessage(chatId, "⚙️ Admin Panel", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "👥 Customers", callback_data: "admin_customers" }],
          [{ text: "⏳ Active Sessions", callback_data: "admin_sessions" }]
        ]
      }
    });
  }

  // ================= RENT =================
  if (data === "rent") {
    const toolsSnap = await db.collection("tools").get();

    const buttons = [];

    for (const doc of toolsSnap.docs) {
      const status = await getToolStatus(doc.id);

      let label = `${status.name} (${status.activeCount}/${status.maxSlots})`;

      if (!status.available) {
        label += status.nextAvailableIn ? ` - Full (${status.nextAvailableIn})` : " - Full";
      }

      buttons.push([{ text: label, callback_data: `tool_${doc.id}` }]);
    }

    return bot.sendMessage(chatId, "Select Tool", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // ================= TOOL =================
  if (data.startsWith("tool_")) {
    const toolId = data.replace("tool_", "");
    const status = await getToolStatus(toolId);

    if (!status.available) {
      return bot.sendMessage(chatId, `❌ Full. Next available in ${status.nextAvailableIn}`);
    }

    userFlow[userId] = { toolId };

    return bot.sendMessage(chatId, "Select Rate", {
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
    if (!userFlow[userId]) return;

    const hours = data === "rate_6" ? 6 : 12;
    userFlow[userId].rate = hours;

    return bot.sendMessage(chatId, "Choose Payment Method", {
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
    if (!userFlow[userId]) return;

    const method = data === "pay_bsp" ? "BSP" : "CellMoni";
    userFlow[userId].payment = method;

    const details =
      method === "BSP"
        ? "Account#: 0001196222"
        : "Number: 74703925";

    return bot.sendMessage(chatId, `Send receipt after payment:\n\n${details}`);
  }

  // ================= ADMIN APPROVE =================
  if (data.startsWith("approve_")) {
    if (!isAdmin(userId)) return;

    const targetUserId = data.split("_")[1];

    const bookingDoc = await db.collection("bookings").doc(targetUserId).get();
    const booking = bookingDoc.data();

    if (!booking) return;

    await db.collection("bookings").doc(targetUserId).update({
      status: "active",
      expiresAt: booking.expiresAt
    });

    bot.sendMessage(targetUserId, "✅ Approved! Session active.");
    bot.sendMessage(chatId, "Approved");
  }

  // ================= ADMIN REJECT =================
  if (data.startsWith("reject_")) {
    if (!isAdmin(userId)) return;

    const targetUserId = data.split("_")[1];

    await db.collection("bookings").doc(targetUserId).update({
      status: "rejected"
    });

    bot.sendMessage(targetUserId, "❌ Rejected.");
    bot.sendMessage(chatId, "Rejected");
  }
});

// ================= RECEIPT HANDLER =================
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (msg.photo && userFlow[userId]) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const flow = userFlow[userId];

    const expiresAt = Date.now() + (flow.rate * 3600000);

    await db.collection("bookings").doc(String(userId)).set({
      userId,
      tool: flow.toolId,
      rate: flow.rate,
      payment: flow.payment,
      status: "pending",
      expiresAt
    });

    const caption = `Receipt\nUser: ${userId}\nTool: ${flow.toolId}\nPayment: ${flow.payment}`;

    // send to admin
    bot.sendPhoto(ADMIN_ID, fileId, {
      caption,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Approve", callback_data: `approve_${userId}` }],
          [{ text: "Reject", callback_data: `reject_${userId}` }]
        ]
      }
    });

    // send to channel
    try {
      await bot.sendPhoto(CHANNEL, fileId, { caption });
    } catch (e) {}

    bot.sendMessage(chatId, "Receipt received. Await admin approval.");

    delete userFlow[userId];
  }
});

// ================= AUTO EXPIRY =================
setInterval(async () => {
  try {
    const snap = await db.collection("bookings")
      .where("status", "==", "active")
      .get();

    const now = Date.now();

    snap.forEach(async doc => {
      const d = doc.data();

      if (d.expiresAt && now > d.expiresAt) {
        await doc.ref.update({ status: "expired" });
        bot.sendMessage(d.userId, "⏳ Session expired.");
      }
    });
  } catch (err) {
    console.error(err);
  }
}, 60000);
