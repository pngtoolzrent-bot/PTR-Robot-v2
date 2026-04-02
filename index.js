const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// ================= EXPRESS (RENDER FIX) =================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("PNGToolzRent Bot Running ✅");
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

// ================= ENV =================
if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!process.env.ADMIN_ID) throw new Error("ADMIN_ID missing");
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT missing");

const ADMIN_ID = process.env.ADMIN_ID;

// ================= BOT =================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});

const db = admin.firestore();

// ================= STATE =================
const userFlow = {};
const pendingAdminInput = {};

// ================= CHANNEL =================
const CHANNEL = "@ptr_records";

// ================= HELPERS =================
const isAdmin = (id) => String(id) === String(ADMIN_ID);

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;

  await db.collection("users").doc(String(userId)).set({
    username: msg.from.username || null,
    firstName: msg.from.first_name || null
  }, { merge: true });

  userFlow[userId] = { step: "idle" };

  bot.sendMessage(msg.chat.id, "Welcome to PNGToolzRent", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛠 Rent Tool", callback_data: "rent" }],
        ...(isAdmin(userId) ? [[{ text: "⚙️ Admin Panel", callback_data: "admin" }]] : [])
      ]
    }
  });
});

// ================= CALLBACKS =================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  // ===== ADMIN PANEL =====
  if (data === "admin" && isAdmin(userId)) {
    bot.sendMessage(chatId, "Admin Panel", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "👥 Customers", callback_data: "customers" }],
          [{ text: "🛠 Tools", callback_data: "tools" }],
          [{ text: "⛔ Terminate Session", callback_data: "terminate" }],
          [{ text: "⏳ Active Sessions", callback_data: "active" }]
        ]
      }
    });
  }

  // ===== RENT TOOL =====
  if (data === "rent") {
    const toolsSnap = await db.collection("tools").get();

    const buttons = [];
    toolsSnap.forEach(doc => {
      buttons.push([{ text: doc.data().name, callback_data: `tool_${doc.id}` }]);
    });

    bot.sendMessage(chatId, "Select tool:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // ===== TOOL SELECT =====
  if (data.startsWith("tool_")) {
    const tool = data.replace("tool_", "");

    userFlow[userId] = {
      step: "select_payment",
      tool
    };

    bot.sendMessage(chatId,
`💰 Choose Payment Method:

K10 for 6 Hours`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏦 BSP Bank", callback_data: "pay_bsp" }],
          [{ text: "📱 CellMoni", callback_data: "pay_cell" }]
        ]
      }
    });
  }

  // ===== PAYMENT SELECTION =====
  if (data === "pay_bsp" || data === "pay_cell") {
    if (!userFlow[userId]) return;

    const method = data === "pay_bsp" ? "BSP" : "CellMoni";

    userFlow[userId].step = "waiting_receipt";
    userFlow[userId].paymentMethod = method;

    bot.sendMessage(chatId,
`💳 Payment Details:

${method === "BSP"
? "Account#: 0001196222"
: "Number: 67574703925"}

📸 Send your receipt after payment.`);
  }

  // ===== ADMIN TERMINATE =====
  if (data === "terminate" && isAdmin(userId)) {
    pendingAdminInput[userId] = "terminate";
    bot.sendMessage(chatId, "Send User ID to terminate:");
  }

  // ===== CUSTOMERS =====
  if (data === "customers" && isAdmin(userId)) {
    const snap = await db.collection("users").get();

    let text = "👥 Customers:\n\n";

    snap.forEach(doc => {
      const d = doc.data();
      const name = d.username ? `@${d.username}` : d.firstName || "NoName";
      text += `${name} (${doc.id})\n`;
    });

    bot.sendMessage(chatId, text);
  }

  // ===== TOOLS =====
  if (data === "tools" && isAdmin(userId)) {
    const snap = await db.collection("tools").get();

    let text = "🛠 Tools:\n\n";
    snap.forEach(doc => {
      text += `${doc.id} → ${doc.data().name}\n`;
    });

    bot.sendMessage(chatId, text || "No tools");
  }

  // ===== ACTIVE SESSIONS =====
  if (data === "active" && isAdmin(userId)) {
    const snap = await db.collection("bookings")
      .where("status", "==", "active")
      .get();

    const now = Date.now();
    let text = "⏳ Active Sessions:\n\n";

    snap.forEach(doc => {
      const d = doc.data();
      const remaining = d.expiresAt - now;
      const h = Math.floor(remaining / (1000 * 60 * 60));
      const m = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

      text += `User: ${doc.id}\nTool: ${d.tool}\nRemaining: ${h}h ${m}m\n\n`;
    });

    bot.sendMessage(chatId, text || "No active sessions");
  }

  // ===== APPROVE / REJECT =====
  if (data.startsWith("approve_") && isAdmin(userId)) {
    const targetUser = data.split("_")[1];
    pendingAdminInput[userId] = `login_${targetUser}`;
    bot.sendMessage(chatId, "Send login details:");
  }

  if (data.startsWith("reject_") && isAdmin(userId)) {
    const targetUser = data.split("_")[1];

    await db.collection("bookings").doc(targetUser).update({
      status: "rejected"
    });

    bot.sendMessage(targetUser, "❌ Your payment was rejected.");
    bot.sendMessage(chatId, "Rejected.");
  }
});

// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // ===== ADMIN TERMINATE INPUT =====
  if (isAdmin(userId) && pendingAdminInput[userId] === "terminate") {
    const target = msg.text;

    await db.collection("bookings").doc(target).update({
      status: "terminated"
    });

    bot.sendMessage(target, "⛔ Session terminated by admin.");
    bot.sendMessage(chatId, "Done.");

    delete pendingAdminInput[userId];
    return;
  }

  // ===== ADMIN LOGIN INPUT =====
  if (isAdmin(userId) && pendingAdminInput[userId]?.startsWith("login_")) {
    const targetUser = pendingAdminInput[userId].split("_")[1];
    const loginDetails = msg.text;

    const expiresAt = Date.now() + (6 * 60 * 60 * 1000);

    await db.collection("bookings").doc(targetUser).set({
      status: "active",
      loginDetails,
      expiresAt
    }, { merge: true });

    bot.sendMessage(targetUser,
`✅ Approved

${loginDetails}`);

    try {
      await bot.sendMessage(CHANNEL,
`✅ APPROVED

User: ${targetUser}
Status: Active
Duration: 6 Hours`);
    } catch (e) {
      console.error("Channel error:", e.message);
    }

    bot.sendMessage(chatId, "Login sent.");

    delete pendingAdminInput[userId];
    return;
  }

  // ===== RECEIPT HANDLER =====
  if (msg.photo && userFlow[userId]?.step === "waiting_receipt") {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const { tool, paymentMethod } = userFlow[userId];

    const caption = `Receipt\nUser: ${userId}\nTool: ${tool}\nPayment: ${paymentMethod}`;

    await db.collection("bookings").doc(String(userId)).set({
      userId,
      tool,
      paymentMethod,
      status: "pending",
      createdAt: Date.now()
    });

    // Admin
    bot.sendPhoto(ADMIN_ID, fileId, {
      caption,
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Approve", callback_data: `approve_${userId}` }],
          [{ text: "❌ Reject", callback_data: `reject_${userId}` }]
        ]
      }
    });

    // Channel
    try {
      await bot.sendPhoto(CHANNEL, fileId, { caption });
    } catch (e) {
      console.error("Channel send failed:", e.message);
    }

    bot.sendMessage(chatId, "📩 Receipt received.");

    delete userFlow[userId];
  }
});

// ================= AUTO EXPIRY =================
setInterval(async () => {
  const snap = await db.collection("bookings")
    .where("status", "==", "active")
    .get();

  const now = Date.now();

  snap.forEach(async (doc) => {
    const d = doc.data();
    if (d.expiresAt && now > d.expiresAt) {
      await doc.ref.update({ status: "expired" });
      bot.sendMessage(d.userId, "⏰ Session expired");
    }
  });
}, 60000);
