require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");
const dayjs = require("dayjs");

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const bot = new Telegraf(BOT_TOKEN);

// ---------------- INIT DATABASE ----------------
async function initializeDatabase() {
  const configRef = db.collection("system").doc("config");
  const config = await configRef.get();

  if (config.exists && config.data().initialized) return;

  const tools = [
    { tool_id: "tool1", name: "UnlockTool", total_slots: 3 }
  ];

  for (const tool of tools) {
    await db.collection("tools").doc(tool.tool_id).set(tool);

    for (let i = 1; i <= tool.total_slots; i++) {
      await db.collection("slots").doc(`${tool.tool_id}_slot_${i}`).set({
        tool_id: tool.tool_id,
        slot_number: `SLOT ${i}`,
        is_active: false,
        assigned_to: null,
        expires_at: null,
        reserved_by: null,
        reserved_until: null
      });
    }
  }

  await configRef.set({ initialized: true });
  console.log("🔥 Database initialized");
}

// ---------------- HELPERS ----------------
function formatTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// ---------------- START ----------------
bot.start(async (ctx) => {
  const toolsSnap = await db.collection("tools").get();

  const buttons = toolsSnap.docs.map(doc =>
    [Markup.button.callback(doc.data().name, `tool_${doc.id}`)]
  );

  ctx.reply("Select a tool:", Markup.inlineKeyboard(buttons));
});

// ---------------- TOOL SELECT ----------------
bot.action(/tool_(.+)/, async (ctx) => {
  const tool_id = ctx.match[1];

  const slotsSnap = await db.collection("slots")
    .where("tool_id", "==", tool_id)
    .get();

  const available = [];
  let earliest = null;

  slotsSnap.forEach(doc => {
    const s = doc.data();

    if (!s.is_active && (!s.reserved_until || s.reserved_until < Date.now())) {
      available.push({ id: doc.id, ...s });
    }

    if (s.is_active && s.expires_at) {
      if (!earliest || s.expires_at < earliest) {
        earliest = s.expires_at;
      }
    }
  });

  // CASE A: available
  if (available.length > 0) {
    const buttons = available.map(s =>
      [Markup.button.callback(s.slot_number, `slot_${s.id}`)]
    );

    return ctx.reply("🟢 Available Slots:", Markup.inlineKeyboard(buttons));
  }

  // CASE B: none available
  if (earliest) {
    const timeLeft = earliest - Date.now();

    return ctx.reply(
      `🔴 All slots busy\n⏳ Next free in: ${formatTime(timeLeft)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Refresh", `tool_${tool_id}`)]
      ])
    );
  }

  ctx.reply("No slots found.");
});

// ---------------- SLOT SELECT ----------------
bot.action(/slot_(.+)/, async (ctx) => {
  const slotId = ctx.match[1];
  const userId = ctx.from.id;

  const slotRef = db.collection("slots").doc(slotId);

  await db.runTransaction(async (t) => {
    const doc = await t.get(slotRef);
    const data = doc.data();

    if (data.is_active) throw new Error("Slot taken");

    t.update(slotRef, {
      reserved_by: userId,
      reserved_until: Date.now() + 5 * 60 * 1000
    });
  });

  ctx.reply(
    "✅ Slot reserved (5 min)\nSelect duration:",
    Markup.inlineKeyboard([
      [Markup.button.callback("6 Hours", `dur_${slotId}_6`)],
      [Markup.button.callback("12 Hours", `dur_${slotId}_12`)]
    ])
  );
});

// ---------------- DURATION ----------------
bot.action(/dur_(.+)_(\d+)/, async (ctx) => {
  const slotId = ctx.match[1];
  const duration = ctx.match[2];

  ctx.reply(
    "Choose payment:",
    Markup.inlineKeyboard([
      [Markup.button.callback("BSP", `pay_${slotId}_${duration}_BSP`)],
      [Markup.button.callback("CellMoni", `pay_${slotId}_${duration}_CELL`)]
    ])
  );
});

// ---------------- PAYMENT ----------------
bot.action(/pay_(.+)_(\d+)_(.+)/, async (ctx) => {
  const [_, slotId, duration, method] = ctx.match;

  ctx.session = {
    slotId,
    duration,
    method
  };

  ctx.reply("📸 Send payment receipt image");
});

// ---------------- RECEIVE RECEIPT ----------------
bot.on("photo", async (ctx) => {
  if (!ctx.session) return;

  const fileId = ctx.message.photo.pop().file_id;
  const user = ctx.from;

  const orderRef = await db.collection("orders").add({
    user_id: user.id,
    username: user.username || "",
    slot_id: ctx.session.slotId,
    duration: ctx.session.duration,
    payment_method: ctx.session.method,
    receipt: fileId,
    status: "pending",
    created_at: Date.now()
  });

  await bot.telegram.sendMessage(
    ADMIN_ID,
    `📥 New Order\nUser: @${user.username}\nDuration: ${ctx.session.duration}h`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Approve", `approve_${orderRef.id}`)],
      [Markup.button.callback("❌ Reject", `reject_${orderRef.id}`)]
    ])
  );

  ctx.reply("⏳ Waiting for admin approval");
  ctx.session = null;
});

// ---------------- APPROVE ----------------
bot.action(/approve_(.+)/, async (ctx) => {
  if (ctx.from.id != ADMIN_ID) return;

  const orderId = ctx.match[1];
  const orderRef = db.collection("orders").doc(orderId);
  const order = (await orderRef.get()).data();

  const slotRef = db.collection("slots").doc(order.slot_id);

  await slotRef.update({
    is_active: true,
    assigned_to: order.user_id,
    expires_at: Date.now() + order.duration * 3600000,
    reserved_by: null,
    reserved_until: null
  });

  await orderRef.update({ status: "approved" });

  await bot.telegram.sendMessage(order.user_id,
    "✅ Approved!\nAdmin will send login shortly.");

  ctx.reply("Approved. Send login manually.");
});

// ---------------- REJECT ----------------
bot.action(/reject_(.+)/, async (ctx) => {
  if (ctx.from.id != ADMIN_ID) return;

  const orderId = ctx.match[1];
  const orderRef = db.collection("orders").doc(orderId);
  const order = (await orderRef.get()).data();

  await db.collection("slots").doc(order.slot_id).update({
    reserved_by: null,
    reserved_until: null
  });

  await orderRef.update({ status: "rejected" });

  await bot.telegram.sendMessage(order.user_id,
    "❌ Payment rejected");

  ctx.reply("Rejected");
});

// ---------------- CLEANUP JOB ----------------
setInterval(async () => {
  const now = Date.now();

  const snap = await db.collection("slots")
    .where("is_active", "==", true)
    .get();

  snap.forEach(doc => {
    const s = doc.data();

    if (s.expires_at && s.expires_at < now) {
      doc.ref.update({
        is_active: false,
        assigned_to: null,
        expires_at: null
      });
    }
  });

}, 60000);

// ---------------- START BOT ----------------
(async () => {
  await initializeDatabase();
  bot.launch();
  console.log("🤖 Bot running");
})();
