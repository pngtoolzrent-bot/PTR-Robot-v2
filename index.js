const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// ================= EXPRESS (RENDER FIX) =================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("PNGToolzRent Bot is running ✅");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ================= ENV CHECK =================
if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!process.env.ADMIN_ID) throw new Error("ADMIN_ID missing");
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT missing");

// ================= BOT =================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMIN_ID = process.env.ADMIN_ID;

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});

const db = admin.firestore();

// ================= STATE =================
const userStates = {};
const pendingInputs = {};

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  await db.collection("users").doc(String(userId)).set({
    id: userId,
    username: msg.from.username || null,
    firstName: msg.from.first_name || null,
    joinedAt: Date.now()
  }, { merge: true });

  bot.sendMessage(chatId,
`👋 Welcome to PNGToolzRent

💰 K10 for 6 Hours
⚡ Fast & secure service
🙏 Thank you for choosing us`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛠 Rent Tool", callback_data: "rent_tool" }],
        [{ text: "📊 My Status", callback_data: "my_status" }],
        ...(String(userId) === String(ADMIN_ID)
          ? [[{ text: "⚙️ Admin Panel", callback_data: "admin_panel" }]]
          : [])
      ]
    }
  });
});

// ================= CALLBACK =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  const isAdmin = String(userId) === String(ADMIN_ID);

  // ===== ADMIN PANEL =====
  if (data === "admin_panel" && isAdmin) {
    bot.sendMessage(chatId, "⚙️ Admin Panel", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛠 Tools", callback_data: "admin_tools" }],
          [{ text: "➕ Add Tool", callback_data: "admin_addtool" }],
          [{ text: "❌ Remove Tool", callback_data: "admin_removetool" }],
          [{ text: "👥 Customers", callback_data: "admin_customers" }],
          [{ text: "⏳ Active Sessions", callback_data: "admin_active" }]
        ]
      }
    });
  }

  // ===== TOOLS =====
  if (data === "admin_tools" && isAdmin) {
    const snap = await db.collection("tools").get();

    let text = "🛠 Tools:\n\n";
    snap.forEach(doc => {
      text += `${doc.id} → ${doc.data().name}\n`;
    });

    bot.sendMessage(chatId, text || "No tools.");
  }

  if (data === "admin_addtool" && isAdmin) {
    pendingInputs[userId] = "add_tool";
    bot.sendMessage(chatId, "Send tool name:");
  }

  if (data === "admin_removetool" && isAdmin) {
    pendingInputs[userId] = "remove_tool";
    bot.sendMessage(chatId, "Send tool ID to remove:");
  }

  // ===== CUSTOMERS =====
  if (data === "admin_customers" && isAdmin) {
    const snap = await db.collection("users").get();

    let text = "👥 Customers:\n\n";

    snap.forEach(doc => {
      const d = doc.data();
      const username = d.username ? `@${d.username}` : (d.firstName || "NoUsername");

      text += `👤 ${username}\n🆔 ${doc.id}\n\n`;
    });

    bot.sendMessage(chatId, text || "No customers.");
  }

  // ===== ACTIVE SESSIONS =====
  if (data === "admin_active" && isAdmin) {
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

    bot.sendMessage(chatId, text || "No active sessions.");
  }

  // ===== RENT TOOL =====
  if (data === "rent_tool") {
    const toolsSnap = await db.collection("tools").get();

    let buttons = [];

    toolsSnap.forEach(doc => {
      buttons.push([
        { text: doc.data().name, callback_data: `select_tool_${doc.id}` }
      ]);
    });

    bot.sendMessage(chatId, "🛠 Select a tool:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("select_tool_")) {
    const toolId = data.replace("select_tool_", "");

    await db.collection("bookings").doc(String(userId)).set({
      tool: toolId,
      status: "pending",
      createdAt: Date.now()
    });

    userStates[userId] = "waiting_receipt";

    bot.sendMessage(chatId,
`💰 Payment: K10 for 6 Hours

Please send your receipt after payment.

🙏 Thank you for choosing PNGToolzRent`);
  }

  // ===== APPROVE =====
  if (data.startsWith("approve_") && isAdmin) {
    const targetUser = data.split("_")[1];

    pendingInputs[userId] = `login_${targetUser}`;

    bot.sendMessage(chatId, "✍️ Send login details for this user:");
  }

  // ===== REJECT =====
  if (data.startsWith("reject_") && isAdmin) {
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
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const isAdmin = String(userId) === String(ADMIN_ID);

  // ===== ADMIN INPUT =====
  if (isAdmin && pendingInputs[userId]) {
    const action = pendingInputs[userId];

    if (action === "add_tool") {
      const id = msg.text.toLowerCase();

      await db.collection("tools").doc(id).set({
        name: msg.text
      });

      bot.sendMessage(chatId, "✅ Tool added");
      delete pendingInputs[userId];
      return;
    }

    if (action === "remove_tool") {
      await db.collection("tools").doc(msg.text).delete();

      bot.sendMessage(chatId, "❌ Tool removed");
      delete pendingInputs[userId];
      return;
    }

    if (action.startsWith("login_")) {
      const targetUser = action.split("_")[1];

      const bookingDoc = await db.collection("bookings").doc(targetUser).get();
      const data = bookingDoc.data();

      const loginDetails = msg.text;

      const expiresAt = Date.now() + (6 * 60 * 60 * 1000);

      await db.collection("bookings").doc(targetUser).update({
        status: "active",
        loginDetails,
        expiresAt
      });

      // Send to user
      bot.sendMessage(targetUser,
`✅ Approved!

🔐 Login Details:
${loginDetails}

⏳ Duration: 6 Hours
🙏 Thank you for choosing PNGToolzRent`);

      // Log to channel
      try {
        await bot.sendMessage("@ptr_records",
`✅ APPROVED

User: ${targetUser}
Tool: ${data.tool}
Status: Active
Duration: 6 Hours`);
      } catch (e) {
        console.error("Channel log failed:", e.message);
      }

      bot.sendMessage(chatId, "✅ Login sent and session activated.");

      delete pendingInputs[userId];
      return;
    }
  }

  // ===== RECEIPT HANDLING =====
  if (msg.photo && userStates[userId] === "waiting_receipt") {
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    const booking = await db.collection("bookings").doc(String(userId)).get();
    const data = booking.data();

    const caption = `📥 RECEIPT

User: ${userId}
Username: @${msg.from.username || "N/A"}
Tool: ${data.tool}
Status: Pending`;

    // Admin
    bot.sendPhoto(ADMIN_ID, fileId, {
      caption,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve_${userId}` },
            { text: "❌ Reject", callback_data: `reject_${userId}` }
          ]
        ]
      }
    });

    // Channel
    try {
      await bot.sendPhoto("@ptr_records", fileId, { caption });
    } catch (e) {
      console.error("Channel forward failed:", e.message);
    }

    bot.sendMessage(chatId, "📩 Receipt received. Awaiting approval.");

    userStates[userId] = null;
  }
});

// ================= EXPIRY =================
setInterval(async () => {
  const snap = await db.collection("bookings")
    .where("status", "==", "active")
    .get();

  const now = Date.now();

  snap.forEach(async (doc) => {
    const d = doc.data();

    if (d.expiresAt && now > d.expiresAt) {
      await db.collection("bookings").doc(doc.id).update({
        status: "expired"
      });

      bot.sendMessage(doc.id, "⏰ Your session has expired.");
    }
  });
}, 60000);
