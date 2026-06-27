"use strict";

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require("@whiskeysockets/baileys");

const pino    = require("pino");
const express = require("express");
const axios   = require("axios");
const QRCode  = require("qrcode");

const CONFIG = {
  PORT            : process.env.PORT             || 3000,
  APPS_SCRIPT_URL : process.env.APPS_SCRIPT_URL  || "",
  API_SECRET      : process.env.API_SECRET       || "rahasia123",
  AUTH_DIR        : "./auth_info",
  RECONNECT_DELAY : 5000,
};

let sock           = null;
let isConnected    = false;
let latestQR       = null;
let reconnectTimer = null;

const logger = pino({ level: "warn" });
const app    = express();
app.use(express.json());

function requireSecret(req, res, next) {
  const secret = req.headers["x-api-secret"] || req.query.secret;
  if (secret !== CONFIG.API_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

function toJid(phone) {
  let num = String(phone).replace(/[^0-9]/g, "");
  if (num.startsWith("0")) num = "62" + num.slice(1);
  return num + "@s.whatsapp.net";
}

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal             : false,
    generateHighQualityLinkPreview: false,
    browser: ["VOICETA-Bot", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = qr;
      console.log("QR baru tersedia — buka /qr di browser.");
    }
    if (connection === "open") {
      isConnected = true;
      latestQR    = null;
      console.log("WhatsApp terhubung!");
    }
    if (connection === "close") {
      isConnected = false;
      const code      = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log("Koneksi terputus (" + code + "). " + (loggedOut ? "Logout." : "Reconnect..."));
      if (!loggedOut) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWhatsApp, CONFIG.RECONNECT_DELAY);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;

      const from = msg.key.remoteJid.replace("@s.whatsapp.net", "");
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || "";

      if (!body) continue;
      console.log("Pesan masuk dari " + from);

      if (CONFIG.APPS_SCRIPT_URL) {
        await axios.post(CONFIG.APPS_SCRIPT_URL, {
          type      : "incoming_message",
          from,
          body,
          timestamp : new Date().toISOString(),
        }, {
          timeout      : 15000,
          maxRedirects : 5,
        }).catch(err => console.error("Forward error:", err.message));
      }
    }
  });
}

// ── /qr ──────────────────────────────────────────────────────
app.get("/qr", async (_req, res) => {
  if (isConnected) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2 style="color:#25D366">✅ WhatsApp sudah terhubung!</h2></body></html>`);
  }
  if (!latestQR) {
    return res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>⏳ Menunggu QR...</h2><p>Auto-refresh setiap 3 detik.</p></body></html>`);
  }
  try {
    const qrImageUrl = await QRCode.toDataURL(latestQR, { width: 300, margin: 2 });
    res.send(`<html><head><meta http-equiv="refresh" content="30"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
      <h2>📱 Scan QR ini dengan WhatsApp</h2>
      <img src="${qrImageUrl}" style="border:4px solid #25D366;border-radius:12px;margin:16px auto;display:block"/>
      <p style="color:#888;font-size:12px">Auto-refresh 30 detik. <a href="/qr">Refresh manual</a></p>
      </body></html>`);
  } catch (err) {
    res.status(500).send("Gagal generate QR: " + err.message);
  }
});

// ── /send ─────────────────────────────────────────────────────
app.post("/send", requireSecret, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone dan message wajib." });
  if (!isConnected || !sock) return res.status(503).json({ error: "WA belum terhubung." });
  try {
    await sock.sendMessage(toJid(phone), { text: message });
    return res.json({ success: true, to: phone });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── /send-batch ───────────────────────────────────────────────
app.post("/send-batch", requireSecret, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages harus array." });
  if (!isConnected || !sock) return res.status(503).json({ error: "WA belum terhubung." });
  const results = [];
  for (const item of messages) {
    try {
      await sock.sendMessage(toJid(item.phone), { text: item.message });
      results.push({ phone: item.phone, status: "sent" });
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      results.push({ phone: item.phone, status: "failed", error: err.message });
    }
  }
  return res.json({ results });
});

// ── /health ───────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status    : isConnected ? "connected" : "disconnected",
    hasQR     : !!latestQR,
    qrUrl     : latestQR ? "/qr" : null,
    timestamp : new Date().toISOString(),
  });
});

// ── /status ───────────────────────────────────────────────────
app.get("/status", requireSecret, (_req, res) => {
  res.json({
    service   : "VOICETA WhatsApp Bot Server",
    connected : isConnected,
    hasQR     : !!latestQR,
    uptime    : process.uptime(),
    timestamp : new Date().toISOString(),
  });
});

// ── /logout ───────────────────────────────────────────────────
app.post("/logout", requireSecret, async (_req, res) => {
  try {
    if (sock) await sock.logout();
    const fs = require("fs");
    fs.rmSync("./auth_info", { recursive: true, force: true });
    isConnected = false;
    latestQR    = null;
    sock        = null;
    res.json({ success: true, message: "Logged out." });
    setTimeout(() => connectWhatsApp(), 3000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Keep-alive ────────────────────────────────────────────────
setInterval(() => {
  const http = require("http");
  http.get("http://localhost:" + CONFIG.PORT + "/health", () => {});
}, 10 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => console.log("Server jalan di port " + CONFIG.PORT));
connectWhatsApp().catch(err => { console.error("Fatal:", err); process.exit(1); });
