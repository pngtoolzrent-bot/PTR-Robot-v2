// PNGToolzRent Telegram Bot (Slot Management Enabled)

const express = require("express"); const TelegramBot = require("node-telegram-bot-api"); const admin = require("firebase-admin");

// ================= EXPRESS ================= const app = express(); const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => { res.send("PNGToolzRent Bot Running ✅"); });

app.listen(PORT, () => console.log("Server running on port", PORT));

// ================= ENV ================= if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN missing"); if (!process.env.ADMIN_ID) throw new Error("ADMIN_ID missing"); if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT missing");

const ADMIN_ID = process.env.ADMIN_ID; const CHANNEL = "@ptr_records";

// ================= FIREBASE ================= admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });

const db = admin.firestore();

// ================= BOT ================= const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ================= STATE ================= const userFlow = {}; const adminInput = {};

// ================= HELPERS ================= const isAdmin = (id) => String(id) === String(ADMIN_ID);

// ================= INIT DB ================= async function initDB() { const toolsRef = db.collection("tools"); const snap = await toolsRef.get();

if (snap.empty) { await toolsRef.doc("unlocktool").set({ name: "UnlockTool", maxSlots: 5 }); console.log("Database seeded"); } } initDB();

// ================= SLOT HELPERS ================= async function getToolStatus(toolId) { const toolDoc = await db.collection("tools").doc(toolId).get(); if (!toolDoc.exists) return null;

const toolData = toolDoc.data();

const bookingsSnap = await db.collection("bookings") .where("tool", "==", toolId) .where("status", "==", "active") .get();

const activeCount = bookingsSnap.size; const maxSlots = toolData.maxSlots || 0;

let nextAvailableIn = null;

if (activeCount >= maxSlots) { let earliest = null;

bookingsSnap.forEach(doc => {
  const d = doc.data();
  if (!earliest || d.expiresAt < earliest) {
    earliest = d.expiresAt;
  }
});

const now = Date.now();
const diff = Math.max(0, earliest - now);

const h = Math.floor(diff / 3600000);
const m = Math.floor((diff % 3600000) / 60000);

nextAvailableIn = `${h}h ${m}m`;

}

return { name: toolData.name, maxSlots, activeCount, available: activeCount < maxSlots, nextAvailableIn }; }

// ================= START ================= bot.onText(//start/, async (msg) => { const userId = msg.from.id;

await db.collection("users").doc(String(userId)).set({ username: msg.from.username || null, firstName: msg.from.first_name || null }, { merge: true });

showMainMenu(msg.chat.id, userId); });

// ================= MAIN MENU ================= async function showMainMenu(chatId, userId) { const buttons = [ [{ text: "🛠 Rent Tool", callback_data: "rent" }] ];

if (isAdmin(userId)) { buttons.push([{ text: "⚙️ Admin Panel", callback_data: "admin" }]); }

bot.sendMessage(chatId, "Main Menu", { reply_markup: { inline_keyboard: buttons } }); }

// ================= CALLBACK ================= bot.on("callback_query", async (q) => { const chatId = q.message.chat.id; const userId = q.from.id; const data = q.data;

if (data === "rent") { const toolsSnap = await db.collection("tools").get();

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

if (data.startsWith("tool_")) { const toolId = data.replace("tool_", ""); const status = await getToolStatus(toolId);

if (!status.available) {
  return bot.sendMessage(chatId, `Tool is full. Next available in ${status.nextAvailableIn}`);
}

userFlow[userId] = { toolId, step: "rate" };

return bot.sendMessage(chatId, "Select Rate", {
  reply_markup: {
    inline_keyboard: [
      [{ text: "6 Hours - K10", callback_data: "rate_6" }],
      [{ text: "12 Hours - K18", callback_data: "rate_12" }]
    ]
  }
});

}

if (data.startsWith("rate_")) { const hours = data === "rate_6" ? 6 : 12; userFlow[userId].rate = hours; userFlow[userId].step = "payment";

return bot.sendMessage(chatId, "Choose Payment Method", {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🏦 BSP", callback_data: "pay_bsp" }],
      [{ text: "📱 CellMoni", callback_data: "pay_cell" }]
    ]
  }
});

}

if (data === "pay_bsp" || data === "pay_cell") { const method = data === "pay_bsp" ? "BSP" : "CellMoni"; userFlow[userId].payment = method; userFlow[userId].step = "receipt";

const details = method === "BSP"
  ? "Account#: 0001196222"
  : "Number: 74703925";

return bot.sendMessage(chatId, `Send receipt after payment:\n\n${details}`);

} });

// ================= RECEIPT HANDLER ================= bot.on("message", async (msg) => { const userId = msg.from.id; const chatId = msg.chat.id;

if (msg.photo && userFlow[userId]?.step === "receipt") { const fileId = msg.photo[msg.photo.length - 1].file_id; const flow = userFlow[userId];

await db.collection("bookings").doc(String(userId)).set({
  userId,
  tool: flow.toolId,
  rate: flow.rate,
  payment: flow.payment,
  status: "pending",
  createdAt: Date.now()
});

const caption = `Receipt\nUser: ${userId}\nTool: ${flow.toolId}\nPayment: ${flow.payment}`;

bot.sendPhoto(ADMIN_ID, fileId, {
  caption,
  reply_markup: {
    inline_keyboard: [
      [{ text: "Approve", callback_data: `approve_${userId}` }],
      [{ text: "Reject", callback_data: `reject_${userId}` }]
    ]
  }
});

try {
  await bot.sendPhoto(CHANNEL, fileId, { caption });
} catch (e) {}

bot.sendMessage(chatId, "Receipt received, awaiting approval");

delete userFlow[userId];

} });

// ================= APPROVAL ================= bot.on("callback_query", async (q) => { const data = q.data; const chatId = q.message.chat.id; const adminId = q.from.id;

if (!isAdmin(adminId)) return;

if (data.startsWith("approve_")) { const userId = data.split("_")[1]; const booking = await db.collection("bookings").doc(userId).get(); const d = booking.data();

const duration = d.rate === 6 ? 6 : 12;
const expiresAt = Date.now() + duration * 3600000;

await db.collection("bookings").doc(userId).update({
  status: "active",
  expiresAt
});

bot.sendMessage(userId, "Approved. Your session is now active.");
bot.sendMessage(chatId, "Approved");

await bot.sendMessage(CHANNEL, `Approved User: ${userId}`);

}

if (data.startsWith("reject_")) { const userId = data.split("_")[1]; await db.collection("bookings").doc(userId).update({ status: "rejected" });

bot.sendMessage(userId, "Rejected");
bot.sendMessage(chatId, "Rejected");

} });

// ================= AUTO EXPIRY ================= setInterval(async () => { const snap = await db.collection("bookings").where("status", "==", "active").get(); const now = Date.now();

snap.forEach(async doc => { const d = doc.data();

if (d.expiresAt && now > d.expiresAt) {
  await doc.ref.update({ status: "expired" });
  bot.sendMessage(d.userId, "Your session has expired.");
}

}); }, 60000);
