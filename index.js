const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// ================= ENV SETUP =================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});

const db = admin.firestore();

// ================= CONFIG =================
const ADMIN_ID = process.env.ADMIN_ID;

// ================= STATE =================
const pendingInputs = {};
const userStates = {};

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await db.collection("users").doc(String(msg.from.id)).set({
    id: msg.from.id,
    firstName: msg.from.first_name,
    username: msg.from.username || null,
    joinedAt: Date.now()
  }, { merge: true });

  bot.sendMessage(chatId,
`👋 Welcome to PNGToolzRent

💰 K10 for 6 Hours per tool
⚡ Fast approval system
🔒 Secure tool rental platform

We appreciate you choosing our service.

Select an option below:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛠 Rent Tool", callback_data: "rent_tool" }],
        [{ text: "📊 My Status", callback_data: "my_status" }],
        ...(msg.from.id == ADMIN_ID ? [[{ text: "⚙️ Admin Panel", callback_data: "admin_panel" }]] : [])
      ]
    }
  });
});

// ================= CALLBACKS =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // ================= ADMIN PANEL =================
  if (data === "admin_panel" && userId == ADMIN_ID) {
    bot.sendMessage(chatId, "⚙️ Admin Panel", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📊 View Slots", callback_data: "admin_slots" }],
          [{ text: "👥 View Customers", callback_data: "admin_customers" }],
          [{ text: "⏳ Active Sessions", callback_data: "admin_active" }],
          [{ text: "🛠 View Tools", callback_data: "admin_tools" }],
          [{ text: "➕ Add Tool", callback_data: "admin_addtool" }],
          [{ text: "❌ Remove Tool", callback_data: "admin_removetool" }]
        ]
      }
    });
  }

  // ================= TOOLS =================
  if (data === "admin_tools" && userId == ADMIN_ID) {
    const snapshot = await db.collection("tools").get();

    let text = "🛠 Tools:\n\n";
    snapshot.forEach(doc => {
      const t = doc.data();
      text += `${doc.id} → ${t.name}\n`;
    });

    bot.sendMessage(chatId, text || "No tools found.");
  }

  if (data === "admin_addtool" && userId == ADMIN_ID) {
    pendingInputs[userId] = "add_tool";
    bot.sendMessage(chatId, "Send tool name (e.g. UnlockTool)");
  }

  if (data === "admin_removetool" && userId == ADMIN_ID) {
    pendingInputs[userId] = "remove_tool";
    bot.sendMessage(chatId, "Send tool ID to remove");
  }

  // ================= CUSTOMERS =================
  if (data === "admin_customers" && userId == ADMIN_ID) {
    const snapshot = await db.collection("users").get();

    let text = "👥 Customers:\n\n";
    snapshot.forEach(doc => {
      text += `${doc.id}\n`;
    });

    bot.sendMessage(chatId, text || "No customers.");
  }

  // ================= ACTIVE SESSIONS =================
  if (data === "admin_active" && userId == ADMIN_ID) {
    const snapshot = await db.collection("bookings")
      .where("status", "==", "active")
      .get();

    const now = Date.now();
    let text = "⏳ Active Sessions:\n\n";

    snapshot.forEach(doc => {
      const d = doc.data();
      const remaining = d.expiresAt - now;

      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

      text += `User: ${doc.id}\nTool: ${d.tool}\nRemaining: ${hours}h ${minutes}m\n\n`;
    });

    bot.sendMessage(chatId, text || "No active sessions.");
  }

  // ================= RENT TOOL =================
  if (data === "rent_tool") {
    const toolsSnap = await db.collection("tools").get();

    let buttons = [];

    toolsSnap.forEach(doc => {
      const t = doc.data();
      buttons.push([{ text: t.name, callback_data: `select_tool_${doc.id}` }]);
    });

    bot.sendMessage(chatId, "🛠 Select a tool:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("select_tool_")) {
    const toolId = data.replace("select_tool_", "");

    const slot = `slot_${Date.now()}`;

    await db.collection("bookings").doc(String(userId)).set({
      tool: toolId,
      slot: slot,
      status: "pending",
      createdAt: Date.now()
    });

    bot.sendMessage(chatId,
`💰 Payment Required

K10 for 6 Hours

Please send your receipt after payment.

We appreciate you using PNGToolzRent.`);

    userStates[userId] = "waiting_receipt";
  }

  // ================= APPROVE =================
  if (data.startsWith("approve_") && userId == ADMIN_ID) {
    const targetUser = data.split("_")[1];

    const expiresAt = Date.now() + (6 * 60 * 60 * 1000);

    await db.collection("bookings").doc(targetUser).update({
      status: "active",
      expiresAt: expiresAt
    });

    bot.sendMessage(targetUser, "✅ Approved! Your tool is now active for 6 hours.");
    bot.sendMessage(chatId, "Approved.");
  }

  // ================= REJECT =================
  if (data.startsWith("reject_") && userId == ADMIN_ID) {
    const targetUser = data.split("_")[1];

    await db.collection("bookings").doc(targetUser).update({
      status: "rejected"
    });

    bot.sendMessage(targetUser, "❌ Payment rejected.");
    bot.sendMessage(chatId, "Rejected.");
  }
});

// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // ---------- ADMIN INPUT ----------
  if (userId == ADMIN_ID && pendingInputs[userId]) {
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
  }

  // ---------- RECEIPT HANDLING ----------
  if (msg.photo) {
    if (userStates[userId] === "waiting_receipt") {
      const fileId = msg.photo[msg.photo.length - 1].file_id;

      const booking = await db.collection("bookings").doc(String(userId)).get();
      const data = booking.data();

      const caption = `📥 Receipt

User: ${userId}
Tool: ${data.tool}
Slot: ${data.slot}`;

      // Send to admin
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

      // Forward to record channel
      bot.sendPhoto("@ptr_records", fileId, {
        caption
      });

      bot.sendMessage(chatId, "📩 Receipt received. Awaiting approval.");

      userStates[userId] = null;
    }
  }
});

// ================= TIMER SYSTEM =================
setInterval(async () => {
  const snapshot = await db.collection("bookings")
    .where("status", "==", "active")
    .get();

  const now = Date.now();

  snapshot.forEach(async (doc) => {
    const data = doc.data();

    if (data.expiresAt && now > data.expiresAt) {
      await db.collection("bookings").doc(doc.id).update({
        status: "expired"
      });

      bot.sendMessage(doc.id, "⏰ Your tool session has expired.");
    }
  });
}, 60000);
