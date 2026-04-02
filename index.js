// index.js - PNGToolzRent Telegram Bot (Updated for Render)
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');

// ====================== ENVIRONMENT VARIABLES ======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);           // Single admin for simplicity
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT; // JSON string

if (!BOT_TOKEN || !ADMIN_ID || !FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ Missing required environment variables: BOT_TOKEN, ADMIN_ID, or FIREBASE_SERVICE_ACCOUNT");
  process.exit(1);
}

// Convert service account JSON string to object
let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT. Make sure it's a valid JSON string.");
  process.exit(1);
}

// ====================== FIREBASE SETUP ======================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
    // No need for databaseURL if using Firestore only
  });
}

const db = admin.firestore();
const toolsRef = db.collection('tools');
const bookingsRef = db.collection('bookings');
const usersRef = db.collection('users');

const bot = new Telegraf(BOT_TOKEN);

// ====================== INITIALIZE TOOLS ======================
async function initializeTools() {
  const toolSnapshot = await toolsRef.get();
  if (toolSnapshot.empty) {
    console.log("🔧 Initializing default tools...");
    await toolsRef.doc('unlocktool').set({
      name: "UnlockTool",
      maxSlots: 5,
      description: "Professional Phone Unlock Tool"
    });
    console.log("✅ UnlockTool created with 5 slots");
  }
}

// ====================== HELPER FUNCTIONS ======================
async function getUser(userId, ctx) {
  const userDoc = await usersRef.doc(userId.toString()).get();
  if (!userDoc.exists) {
    const userData = {
      userId: userId.toString(),
      username: ctx.from.username || '',
      firstName: ctx.from.first_name || '',
      registeredAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await usersRef.doc(userId.toString()).set(userData);
    return userData;
  }
  return userDoc.data();
}

async function getActiveSessions(toolId = 'unlocktool') {
  const now = admin.firestore.Timestamp.now();
  const snapshot = await bookingsRef
    .where('tool', '==', toolId)
    .where('status', '==', 'active')
    .where('expiresAt', '>', now)
    .get();
  return snapshot.size;
}

async function getNextAvailableTime(toolId = 'unlocktool') {
  const now = admin.firestore.Timestamp.now();
  const snapshot = await bookingsRef
    .where('tool', '==', toolId)
    .where('status', '==', 'active')
    .orderBy('expiresAt')
    .get();

  if (snapshot.empty) return null;

  let earliest = null;
  snapshot.forEach(doc => {
    const data = doc.data();
    if (!earliest || data.expiresAt.toMillis() < earliest.toMillis()) {
      earliest = data.expiresAt;
    }
  });

  if (earliest) {
    const minutesLeft = Math.ceil((earliest.toMillis() - Date.now()) / 60000);
    return minutesLeft > 0 ? minutesLeft : 1;
  }
  return null;
}

// ====================== MAIN MENU ======================
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔓 Rent UnlockTool', 'rent_tool')],
    [Markup.button.callback('👤 My Sessions', 'my_sessions')],
    [Markup.button.callback('ℹ️ Help', 'help')]
  ]);
}

// ====================== BOT COMMANDS ======================
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await getUser(userId, ctx);

  await ctx.reply(
    `👋 Welcome to *PNGToolzRent*!\n\n` +
    `Rent access to professional unlocking tools.\n` +
    `Limited slots • Secure • PNG friendly payments\n\n` +
    `Choose an option below:`,
    { parse_mode: 'Markdown', ...mainMenu() }
  );
});

bot.action('rent_tool', async (ctx) => {
  await ctx.answerCbQuery();
  const toolDoc = await toolsRef.doc('unlocktool').get();
  const tool = toolDoc.data();

  const activeSlots = await getActiveSessions('unlocktool');
  const isFull = activeSlots >= tool.maxSlots;

  let statusText = `\( {tool.name} ( \){activeSlots}/${tool.maxSlots})`;
  if (isFull) {
    const nextAvailable = await getNextAvailableTime('unlocktool');
    statusText += nextAvailable ? ` - Full (Next in \~${nextAvailable} min)` : ` - Full`;
  }

  const keyboard = isFull 
    ? Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'main_menu')]])
    : Markup.inlineKeyboard([
        [Markup.button.callback('6 Hours - K10', 'select_rate_6')],
        [Markup.button.callback('12 Hours - K18', 'select_rate_12')],
        [Markup.button.callback('🔙 Back', 'main_menu')]
      ]);

  await ctx.editMessageText(
    `🔓 *Tool Rental*\n\n${statusText}\n\nChoose rental duration:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
});

// Rate Selection
bot.action('select_rate_6', (ctx) => handleRateSelection(ctx, 6, 10));
bot.action('select_rate_12', (ctx) => handleRateSelection(ctx, 12, 18));

async function handleRateSelection(ctx, hours, price) {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  global.pendingBookings = global.pendingBookings || {};
  global.pendingBookings[userId] = {
    tool: 'unlocktool',
    durationHours: hours,
    price: price,
    paymentMethod: null
  };

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💰 BSP Mobile Banking', 'payment_bsp')],
    [Markup.button.callback('📱 Digicel CellMoni', 'payment_cellmoni')],
    [Markup.button.callback('🔙 Back', 'rent_tool')]
  ]);

  await ctx.editMessageText(
    `⏱️ *\( {hours} Hours Rental*\n💰 Price: K \){price}\n\nChoose payment method:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

// Payment Methods
bot.action('payment_bsp', (ctx) => handlePaymentMethod(ctx, 'BSP Mobile Banking', '0001196222'));
bot.action('payment_cellmoni', (ctx) => handlePaymentMethod(ctx, 'Digicel CellMoni', '74703925'));

async function handlePaymentMethod(ctx, method, account) {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const pending = global.pendingBookings?.[userId];

  if (!pending) {
    return ctx.reply("Session expired. Please start again with /start");
  }

  pending.paymentMethod = method;

  await ctx.editMessageText(
    `💳 *Payment Instructions*\n\n` +
    `Method: ${method}\n` +
    `Amount: K${pending.price}\n\n` +
    `Send payment to:\n\`${account}\`\n\n` +
    `After paying, upload a clear screenshot of the receipt.`,
    { parse_mode: 'Markdown' }
  );
}

// Handle Receipt Upload
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const pending = global.pendingBookings?.[userId];

  if (!pending) {
    return ctx.reply("No active booking found. Please start a new rental with /start");
  }

  const photo = ctx.message.photo.pop();
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);

  const bookingData = {
    userId: userId.toString(),
    username: ctx.from.username || ctx.from.first_name,
    tool: pending.tool,
    durationHours: pending.durationHours,
    price: pending.price,
    paymentMethod: pending.paymentMethod,
    receiptUrl: fileLink.href,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const bookingRef = await bookingsRef.add(bookingData);

  // Notify Admin
  const adminMessage = 
    `🔔 *New Payment Pending*\n\n` +
    `User: @${bookingData.username} (ID: ${userId})\n` +
    `Tool: UnlockTool\n` +
    `Duration: ${pending.durationHours} hours\n` +
    `Amount: K${pending.price}\n` +
    `Payment: ${pending.paymentMethod}\n\nReceipt:`;

  try {
    await ctx.telegram.sendPhoto(ADMIN_ID, photo.file_id, {
      caption: adminMessage,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve', `approve_${bookingRef.id}`)],
        [Markup.button.callback('❌ Reject', `reject_${bookingRef.id}`)]
      ])
    });
  } catch (e) {
    console.error("Failed to notify admin:", e);
  }

  // Optional: Send to channel
  try {
    await ctx.telegram.sendPhoto('@ptr_records', photo.file_id, { caption: adminMessage, parse_mode: 'Markdown' });
  } catch (e) {}

  delete global.pendingBookings[userId];

  await ctx.reply(`✅ Receipt received!\nYour booking is now **pending approval**. You will be notified soon.`, { parse_mode: 'Markdown' });
});

// Admin Approval / Rejection
bot.action(/approve_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Unauthorized");

  const bookingId = ctx.match[1];
  const bookingRef = bookingsRef.doc(bookingId);
  const bookingSnap = await bookingRef.get();

  if (!bookingSnap.exists) return ctx.answerCbQuery("Booking not found");

  const booking = bookingSnap.data();
  const expiresAt = new Date(Date.now() + booking.durationHours * 60 * 60 * 1000);

  await bookingRef.update({
    status: 'active',
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    approvedBy: ADMIN_ID
  });

  await ctx.answerCbQuery("✅ Approved");
  await ctx.editMessageCaption(ctx.callbackQuery.message.caption + "\n\n✅ *APPROVED*", { parse_mode: 'Markdown' });

  try {
    await bot.telegram.sendMessage(booking.userId,
      `🎉 *Your UnlockTool rental is APPROVED!*\n\n` +
      `Duration: ${booking.durationHours} hours\n` +
      `Expires: ${expiresAt.toLocaleString()}\n\nEnjoy!`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {}
});

bot.action(/reject_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Unauthorized");

  const bookingId = ctx.match[1];
  const bookingRef = bookingsRef.doc(bookingId);
  const bookingSnap = await bookingRef.get();

  if (!bookingSnap.exists) return ctx.answerCbQuery("Booking not found");

  await bookingRef.update({ status: 'rejected' });

  await ctx.answerCbQuery("❌ Rejected");
  await ctx.editMessageCaption(ctx.callbackQuery.message.caption + "\n\n❌ *REJECTED*", { parse_mode: 'Markdown' });

  try {
    await bot.telegram.sendMessage(bookingSnap.data().userId, 
      `❌ Your rental request was rejected.\nPlease try again or contact support.`
    );
  } catch (e) {}
});

// My Sessions
bot.action('my_sessions', async (ctx) => {
  const userId = ctx.from.id.toString();
  const snapshot = await bookingsRef
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .get();

  if (snapshot.empty) return ctx.reply("You have no rentals yet.");

  let text = "📋 *Your Rentals*\n\n";
  snapshot.forEach(doc => {
    const b = doc.data();
    const status = b.status === 'active' 
      ? `✅ Active until ${new Date(b.expiresAt.toMillis()).toLocaleString()}`
      : b.status.toUpperCase();
    text += `• \( {b.durationHours}h - K \){b.price} | ${status}\n`;
  });

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// Auto Expiry System (every 60 seconds)
setInterval(async () => {
  const now = admin.firestore.Timestamp.now();
  const expired = await bookingsRef
    .where('status', '==', 'active')
    .where('expiresAt', '<=', now)
    .get();

  for (const doc of expired.docs) {
    await doc.ref.update({ status: 'expired' });
    try {
      await bot.telegram.sendMessage(doc.data().userId,
        `⏰ Your UnlockTool session has expired.\nThank you for using PNGToolzRent!`
      );
    } catch (e) {}
  }
}, 60000);

// Other actions
bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`👋 Welcome back to *PNGToolzRent*!`, {
    parse_mode: 'Markdown',
    ...mainMenu()
  });
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `📘 *PNGToolzRent Help*\n\n` +
    `• Limited concurrent slots\n` +
    `• Pay via BSP or CellMoni\n` +
    `• Admin manually approves receipts\n` +
    `• Sessions expire automatically`,
    { parse_mode: 'Markdown' }
  );
});

// ====================== LAUNCH BOT ======================
async function startBot() {
  await initializeTools();
  await bot.launch();
  console.log('🚀 PNGToolzRent Bot started successfully on Render!');
  console.log(`👤 Admin ID: ${ADMIN_ID}`);
}

startBot();

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
