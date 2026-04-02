// ================= IMPORTS =================
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// ================= EXPRESS KEEP ALIVE =================
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

// ================= FIREBASE INIT =================
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

// ================= SLOT CHECK =================
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

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  // ===== RENT =====
  if (data === "rent") {
    const toolsSnap = await db.collection("tools").get();

    const buttons = [];

    for (const doc of toolsSnap.docs) {
      const status = await getToolStatus(doc.id);
      if (!status) continue;

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

  // ===== TOOL SELECT =====
  if (data.startsWith("tool_")) {
    const toolId = data.replace("tool_", "");
    const status = await getToolStatus(toolId);

    if (!status.available) {
      return bot.sendMessage(chatId, `Tool is full. Next available in ${status.nextAvailableIn}`);
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

  // ===== RATE =====
  if (data.startsWith("rate_")) {
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

  // ===== PAYMENT =====
  if (data === "pay_bsp" || data === "pay_cell") {
    const method = data === "pay_bsp" ? "BSP" : "CellMoni";
    userFlow[userId].payment = method;

    const details = method === "BSP"
      ? "Account#: 0001196222"
      : "Number: 74703925";

    return bot.sendMessage(chatId, `Send receipt after payment:\n\n${details}`);
  }
});

// ================= RECEIPT =================
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

    // forward to channel
    try {
      await bot.sendPhoto(CHANNEL, fileId, { caption });
    } catch (e) {}

    bot.sendMessage(chatId, "Receipt received. Please wait for admin approval.");

    delete userFlow[userId];
  }
});

// ================= APPROVAL =================
bot.on("callback_query", async (q) => {
  const data = q.data;
  const adminId = q.from.id;

  if (!isAdmin(adminId)) return;

  if (data.startsWith("approve_")) {
    const userId = data.split("_")[1];

    const booking = await db.collection("bookings").doc(userId).get();
    const d = booking.data();

    const expiresAt = d.expiresAt;

    await db.collection("bookings").doc(userId).update({
      status: "active",
      expiresAt
    });

    bot.sendMessage(userId, "✅ Approved! Your session is now active.");
  }

  if (data.startsWith("reject_")) {
    const userId = data.split("_")[1];

    await db.collection("bookings").doc(userId).update({
      status: "rejected"
    });

    bot.sendMessage(userId, "❌ Your request was rejected.");
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
        bot.sendMessage(d.userId, "⏳ Your session has expired.");
      }
    });
  } catch (err) {
    console.error("Expiry check error:", err);
  }
}, 60000);
