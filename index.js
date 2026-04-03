const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");

// ================= EXPRESS =================
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Running"));
app.listen(PORT);

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID);
const SERVICE = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!BOT_TOKEN || !ADMIN_ID || !SERVICE) throw new Error("Missing ENV");

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(SERVICE))
});
const db = admin.firestore();

// ================= BOT =================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const CHANNEL = "@ptr_records";
const TOOL_ID = "unlocktool";

// ================= HELPERS =================
const isAdmin = (id) => String(id) === ADMIN_ID;

// ================= INIT (SELF HEALING) =================
async function ensureDB() {
  const toolRef = db.collection("tools").doc(TOOL_ID);
  const tool = await toolRef.get();

  if (!tool.exists) {
    await toolRef.set({ name: "UnlockTool" });
  }

  const slotsRef = db.collection("slots");
  const snap = await slotsRef.get();

  if (snap.empty) {
    console.log("Creating slots...");
    for (let i = 1; i <= 5; i++) {
      await slotsRef.doc(`slot${i}`).set({
        toolId: TOOL_ID,
        userId: null,
        expiresAt: null
      });
    }
  }
}
ensureDB();

// ================= SLOT LOGIC =================
async function getSlots() {
  const snap = await db.collection("slots")
    .where("toolId", "==", TOOL_ID)
    .get();

  const slots = [];
  snap.forEach(d => slots.push({ id: d.id, ...d.data() }));
  return slots;
}

async function findFreeSlot() {
  const slots = await getSlots();
  return slots.find(s => !s.userId) || null;
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const id = msg.from.id;

  await db.collection("users").doc(String(id)).set({
    username: msg.from.username || null
  }, { merge: true });

  bot.sendMessage(id, "👋 Welcome to PNGToolzRent", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛠 Rent Tool", callback_data: "rent" }],
        [{ text: "📊 My Session", callback_data: "mysession" }],
        isAdmin(id) ? [{ text: "⚙️ Admin Panel", callback_data: "admin" }] : []
      ]
    }
  });
});

// ================= CALLBACK =================
bot.on("callback_query", async (q) => {
  const id = q.from.id;
  const data = q.data;
  bot.answerCallbackQuery(q.id);

  // ===== RENT =====
  if (data === "rent") {
    const slot = await findFreeSlot();

    if (!slot) return bot.sendMessage(id, "❌ All slots full.");

    await db.collection("requests").doc(String(id)).set({
      userId: id,
      toolId: TOOL_ID,
      slotId: slot.id,
      status: "pending",
      createdAt: Date.now()
    });

    return bot.sendMessage(id, "Choose duration:", {
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
    const rate = data === "rate_6" ? 6 : 12;

    await db.collection("requests").doc(String(id)).update({ rate });

    return bot.sendMessage(id, "Choose payment:", {
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

    await db.collection("requests").doc(String(id)).update({ payment: method });

    const text = method === "BSP"
      ? "🏦 BSP\nAccount#: 0001196222\n\nSend receipt."
      : "📱 CellMoni\nNumber: 74703925\n\nSend receipt.";

    return bot.sendMessage(id, text);
  }

  // ===== MY SESSION =====
  if (data === "mysession") {
    const slots = await getSlots();
    const slot = slots.find(s => String(s.userId) === String(id));

    if (!slot) return bot.sendMessage(id, "No active session.");

    const remaining = Math.max(0, slot.expiresAt - Date.now());
    const mins = Math.floor(remaining / 60000);

    bot.sendMessage(id, `⏳ Time remaining: ${mins} minutes`);
  }

  // ===== ADMIN PANEL =====
  if (data === "admin" && isAdmin(id)) {
    const slots = await getSlots();

    const text = slots.map(s => {
      if (!s.userId) return `${s.id} - FREE`;

      const mins = Math.floor((s.expiresAt - Date.now()) / 60000);
      return `${s.id} - ${s.userId} (${mins}m)`;
    }).join("\n");

    bot.sendMessage(id, `⚙️ Slots:\n\n${text}`);
  }

  // ===== APPROVE =====
  if (data.startsWith("approve_") && isAdmin(id)) {
    const uid = data.split("_")[1];

    const req = (await db.collection("requests").doc(uid).get()).data();

    const expiresAt = Date.now() + (req.rate * 3600000);

    await db.collection("slots").doc(req.slotId).update({
      userId: uid,
      expiresAt
    });

    await db.collection("requests").doc(uid).update({ status: "approved" });

    bot.sendMessage(uid, "✅ Approved. Admin will send login.");
  }

  // ===== REJECT =====
  if (data.startsWith("reject_") && isAdmin(id)) {
    const uid = data.split("_")[1];

    await db.collection("requests").doc(uid).update({ status: "rejected" });

    bot.sendMessage(uid, "❌ Payment rejected.");
  }
});

// ================= RECEIPTS =================
bot.on("message", async (msg) => {
  if (!msg.photo) return;

  const id = msg.from.id;

  const reqDoc = await db.collection("requests").doc(String(id)).get();
  if (!reqDoc.exists) return;

  const req = reqDoc.data();
  const fileId = msg.photo.pop().file_id;

  bot.sendPhoto(ADMIN_ID, fileId, {
    caption: `User: ${id}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "Approve", callback_data: `approve_${id}` }],
        [{ text: "Reject", callback_data: `reject_${id}` }]
      ]
    }
  });

  try {
    await bot.sendPhoto(CHANNEL, fileId, {
      caption: `User: ${id}\nStatus: pending`
    });
  } catch {}

  bot.sendMessage(id, "📩 Receipt sent. Await approval.");
});

// ================= AUTO EXPIRY =================
setInterval(async () => {
  const snap = await db.collection("slots").get();

  snap.forEach(async doc => {
    const s = doc.data();

    if (s.userId && s.expiresAt && Date.now() > s.expiresAt) {
      await doc.ref.update({ userId: null, expiresAt: null });

      try {
        bot.sendMessage(s.userId, "⏳ Session expired.");
      } catch {}
    }
  });
}, 60000);
