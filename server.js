import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import express from "express";
import QRCode from "qrcode";
import P from "pino";
import fetch from "node-fetch";
import cors from "cors";

/* =========================
   BASIC SETUP
========================= */
const app = express();
app.use(express.json());
app.use(cors());

let sock;
let latestQR = null;

// 🔗 n8n RAG Webhook
const N8N_WEBHOOK_URL =
  "https://pinjarin8n.app.n8n.cloud/webhook/whatsapp-rag";

// 🤖 Bot display names (lowercase, exactly as contact name)
const BOT_NAMES = [
  "yesbank bot",
  "yes bank bot",
  "ai response",
];

// 🤖 Optional number fallbacks WhatsApp may inject
const BOT_NUMBER_FALLBACKS = [
  "65559051915364", // example from your logs
];

// 🤖 Command triggers
const BOT_COMMANDS = ["/bot", "!bot"];

/* =========================
   ENTERPRISE QUEUE (FIFO)
========================= */

// Per-chat queues
const chatQueues = new Map();

// Track busy chats (for “Please wait” message)
const chatBusy = new Set();

async function processInQueue(remoteJid, taskFn) {
  const lastPromise = chatQueues.get(remoteJid) || Promise.resolve();

  const nextPromise = lastPromise
    .catch(() => {}) // ignore previous errors
    .then(taskFn)
    .finally(() => {
      if (chatQueues.get(remoteJid) === nextPromise) {
        chatQueues.delete(remoteJid);
        chatBusy.delete(remoteJid);
      }
    });

  chatQueues.set(remoteJid, nextPromise);
  return nextPromise;
}

/* =========================
   START WHATSAPP
========================= */
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Windows", "Chrome", "10"],
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  /* =========================
     CONNECTION STATUS
  ========================= */
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = await QRCode.toDataURL(qr);
      console.log("📲 Scan QR → http://localhost:3000/qr");
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Disconnected:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔁 Reconnecting...");
        startWhatsApp();
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED");
      latestQR = null;
    }
  });

  /* =========================
     📩 INCOMING MESSAGES
  ========================= */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith("@g.us");

    /* =========================
       📝 MESSAGE TEXT (ALL TYPES)
    ========================= */
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      "";

    if (!text) return;

    const lowerText = text.toLowerCase();

    console.log("🔍 Incoming:", lowerText);

    /* =========================
       🤖 ENTERPRISE TRIGGER LOGIC
    ========================= */

    // 1️⃣ Name-based @BotName
    const nameMentioned = BOT_NAMES.some(name =>
      lowerText.includes("@" + name)
    );

    // 2️⃣ Number-based @number
    const numberMentioned = BOT_NUMBER_FALLBACKS.some(num =>
      lowerText.includes("@" + num)
    );

    // 3️⃣ Command-based (/bot, !bot)
    const commandTriggered = BOT_COMMANDS.some(cmd =>
      lowerText.startsWith(cmd)
    );

    const isBotTriggered =
      nameMentioned || numberMentioned || commandTriggered;

    // 🚫 Group rule
    if (isGroup && !isBotTriggered) {
      console.log("⏭️ Group message ignored (bot not triggered)");
      return;
    }

    /* =========================
       🧹 CLEAN MESSAGE
    ========================= */
    let cleanText = text;

    // Remove @mentions
    cleanText = cleanText.replace(/@\S+/g, "");

    // Remove commands
    BOT_COMMANDS.forEach(cmd => {
      const regex = new RegExp("^" + cmd, "i");
      cleanText = cleanText.replace(regex, "");
    });

    cleanText = cleanText.trim();
    if (!cleanText) return;

    console.log("🤖 Accepted query:", cleanText);

    /* =========================
       ⏳ QUEUE + PLEASE WAIT
    ========================= */

    if (chatBusy.has(remoteJid)) {
      await sock.sendMessage(remoteJid, {
        text: "⏳ Please wait, I’m processing your previous request…",
      });
    }

    chatBusy.add(remoteJid);

    await processInQueue(remoteJid, async () => {
      try {
        await sock.sendPresenceUpdate("composing", remoteJid);

        const response = await fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: cleanText,
            isGroup,
          }),
        });

        const data = await response.json();
        const replyText = data.reply || data.output;

        if (replyText) {
          await sock.sendMessage(remoteJid, { text: replyText });
        }
      } catch (err) {
        console.error("❌ n8n Error:", err.message);
        await sock.sendMessage(remoteJid, {
          text: "⚠️ Sorry, something went wrong. Please try again.",
        });
      }
    });
  });
}

startWhatsApp();

/* =========================
   EXPRESS ROUTES
========================= */

// View QR
app.get("/qr", (req, res) => {
  if (!latestQR) {
    return res.send("✅ WhatsApp already connected");
  }
  res.send(`<img src="${latestQR}" />`);
});

// Send personal message
app.post("/send", async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({ error: "number & message required" });
    }

    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: message });

    res.json({ status: "Message sent successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send group message
app.post("/send-group", async (req, res) => {
  try {
    const { groupId, message } = req.body;
    if (!groupId || !message) {
      return res.status(400).json({ error: "groupId & message required" });
    }

    await sock.sendMessage(groupId, { text: message });
    res.json({ status: "Group message sent successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List groups
app.get("/groups", async (req, res) => {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const result = Object.entries(groups).map(([id, data]) => ({
      id,
      name: data.subject,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
