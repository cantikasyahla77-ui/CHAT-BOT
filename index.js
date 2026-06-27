/**
 * ============================================================
 *  VOICETA WhatsApp Bot Server
 *  Engine : Baileys (WebSocket — tanpa Puppeteer/Chromium)
 *  Hosting : Railway / Render (free tier)
 * ============================================================
 *
 *  ENDPOINT:
 *    GET  /qr          → buka di browser untuk scan QR ← BARU
 *    POST /send        → kirim pesan WA
 *    POST /send-batch  → kirim pesan ke banyak nomor sekaligus
 *    GET  /health      → cek status koneksi
 *    GET  /status      → info lengkap server
 * ============================================================
 */

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
const QRCode  = require("qrcode");          // ← tambahan baru

// ── Konfigurasi ──────────────────────────────────────────────
const CONFIG = {
  PORT            : process.env.PORT             || 3000,
  APPS_SCRIPT_URL : process.env.APPS_SCRIPT_URL  || "",
  API_SECRET      : process.env.API_SECRET       || "rahasia123",
  AUTH_DIR        : "./auth_info",
  RECONNECT_DELAY : 5000,
};

// ── State global ─────────────────────────────────────────────
let sock           = null;
let isConnected    = false;
let latestQR       = null;              // ← simpan string QR terbaru
let reconnectTimer = null;

const logger = pino({ level: "warn" });

// ── Express App ──────────────────────────────────────────────
const app = express();
app.use(express.json());

function requireSecret(req, res, next) {
  const secret = req.headers["x-api-secret"] || req.query.secret;
  if (secret !== CONFIG.API_SECRET) {
    return res.status(401).json({ error: "Unauthorized — API secret salah." });
  }
  next();
}

function toJid(phone) {
  let num = String(phone).replace(/[^0-9]/g, "");
  if (num.startsWith("0")) num = "62" + num.slice(1);
  return num + "@s.whatsapp.net";
}

// ── Koneksi ke WhatsApp ───────────────────────────────────────
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
    printQRInTerminal          : false,   // matikan log terminal, pakai /qr endpoint
    generateHighQualityLinkPreview: false,
    browser: ["VOICETA-Bot", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = qr;                      // ← simpan QR string
      console.log("⬜ QR baru tersedia — buka /qr di browser untuk scan.");
    }

    if (connection === "open") {
      isConnected = true;
      latestQR    = null;                 // hapus QR setelah connected
      console.log("✅ WhatsApp terhubung!");
    }

    if (connection === "close") {
      isConnected = false;
      const code  = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`⚠️  Koneksi terputus (${code}). ${loggedOut ? "Sudah logout." : "Reconnect..."}`);
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
      console.log(`📩 Pesan masuk dari ${from}`);

      if (CONFIG.APPS_SCRIPT_URL) {
        await axios.post(CONFIG.APPS_SCRIPT_URL, {
          type      : "incoming_message",
          from,
          body,
          timestamp : new Date().toISOString(),
        }, { timeout: 10000 }).catch(err => console.error("Forward error:", err.message));
        maxRedirects : 0,          // ← tambahkan ini
  validateStatus: (s) => s < 400 || s === 302,
})
      }
    }
  });
}

// ════════════════════════════════════════════════════════════
//  ENDPOINT BARU: /qr — tampilkan QR code di browser
// ════════════════════════════════════════════════════════════
app.get("/qr", async (_req, res) => {
  if (isConnected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
        <h2 style="color:#25D366">✅ WhatsApp sudah terhubung!</h2>
        <p>Tidak perlu scan QR. Bot sudah aktif.</p>
      </body></html>
    `);
  }

  if (!latestQR) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
        <h2>⏳ Menunggu QR...</h2>
        <p>Halaman ini akan otomatis refresh setiap 3 detik.</p>
        <p style="color:#888;font-size:13px">Pastikan server sudah running dan belum pernah login sebelumnya.</p>
      </body></html>
    `);
  }

  try {
    // Generate QR sebagai gambar PNG → embed langsung di HTML
    const qrImageUrl = await QRCode.toDataURL(latestQR, {
      width          : 300,
      margin         : 2,
      color          : { dark: "#000000", light: "#ffffff" },
    });

    res.send(`
      <html><head><meta http-equiv="refresh" content="30"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
        <h2>📱 Scan QR ini dengan WhatsApp</h2>
        <p style="color:#555">Buka WhatsApp → Linked Devices → Link a Device → scan gambar di bawah</p>
        <img src="${qrImageUrl}" style="border:4px solid #25D366;border-radius:12px;margin:16px auto;display:block"/>
        <p style="color:#888;font-size:12px">QR ini expired dalam ~60 detik. Halaman auto-refresh setiap 30 detik.</p>
        <p style="color:#888;font-size:12px">Kalau QR expired, <a href="/qr">refresh manual</a> atau tunggu QR baru muncul.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send("Gagal generate QR: " + err.message);
  }
});

// ════════════════════════════════════════════════════════════
//  ENDPOINT: Kirim satu pesan
// ════════════════════════════════════════════════════════════
app.post("/send", requireSecret, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "Field 'phone' dan 'message' wajib diisi." });
  if (!isConnected || !sock) return res.status(503).json({ error: "WhatsApp belum terhubung. Buka /qr untuk scan." });

  try {
    const jid = toJid(phone);
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Pesan terkirim ke ${phone}`);
    return res.json({ success: true, to: phone });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  ENDPOINT: Kirim batch
// ════════════════════════════════════════════════════════════
app.post("/send-batch", requireSecret, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "'messages' harus array yang tidak kosong." });
  if (!isConnected || !sock) return res.status(503).json({ error: "WhatsApp belum terhubung." });

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

// ════════════════════════════════════════════════════════════
//  ENDPOINT: Health check
// ════════════════════════════════════════════════════════════
app.get("/health", (_req, res) => {
  res.json({
    status    : isConnected ? "connected" : "disconnected",
    hasQR     : !!latestQR,
    qrUrl     : latestQR ? "/qr" : null,
    timestamp : new Date().toISOString(),
  });
});

app.get("/status", requireSecret, (_req, res) => {
  res.json({
    service   : "VOICETA WhatsApp Bot Server",
    connected : isConnected,
    hasQR     : !!latestQR,
    uptime    : process.uptime(),
    timestamp : new Date().toISOString(),
  });
});

// ─────────────────────────────────────────
// ENDPOINT: Admin panel
// ─────────────────────────────────────────
app.get("/admin", requireSecret, (_req, res) => {
  res.send(`
    <html>
    <head>
      <title>VOICETA Admin</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; text-align: center; padding: 40px; background: #f5f5f5; }
        h1 { color: #25D366; }
        .card { background: white; border-radius: 12px; padding: 24px; margin: 16px auto; max-width: 400px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .status { font-size: 18px; margin: 8px 0; }
        .btn { display: inline-block; margin: 8px; padding: 12px 24px; border-radius: 8px; font-size: 16px; cursor: pointer; text-decoration: none; border: none; }
        .btn-green { background: #25D366; color: white; }
        .btn-red { background: #e53935; color: white; }
        .btn-blue { background: #1976D2; color: white; }
      </style>
    </head>
    <body>
      <h1>🤖 VOICETA Bot Admin</h1>
      <div class="card">
        <p class="status">Status: <b>${isConnected ? '🟢 Connected' : '🔴 Disconnected'}</b></p>
        <p class="status">QR Available: <b>${!!latestQR ? 'Ya' : 'Tidak'}</b></p>
      </div>
      <div class="card">
        <a href="/qr?secret=bismillah123" class="btn btn-green">📷 Scan QR</a>
        <a href="/status?secret=bismillah123" class="btn btn-blue">📊 Status</a>
        <button class="btn btn-red" onclick="logout()">🚪 Logout WA</button>
      </div>
      <div class="card">
        <h3 style="margin-top:0">🔗 Quick Links</h3>
        <a href="https://www.notion.so/studevhimabista/VOICETA-bd8b13e3d27f8243893d816e67066681" target="_blank" class="btn btn-blue">📋 Notion DB</a>
        <a href="https://docs.google.com/spreadsheets/d/1gSszu1BzTOgyfVO3U2EbBi4Iun5bq3Ij5edXKauDj0o" target="_blank" class="btn btn-blue">📊 Spreadsheet</a>
        <a href="https://script.google.com/u/0/home/projects/1xMk96tNJCAk0NzE1SwOoiAdPo-X8f1AtoK6cuVd6_NIRxXVWsGxtJLPg/edit" target="_blank" class="btn btn-blue">⚙️ Apps Script</a>
        <a href="https://railway.app/project/392c6f90-49f1-4f02-af87-a8bed1f702da/service/c699eae9-4e30-4cfa-9695-0c6e373377ff" target="_blank" class="btn btn-blue">🚂 Railway</a>
        <a href="https://github.com/studevhimabista-creator/voiceta-wa-server" target="_blank" class="btn btn-blue">🐱 GitHub</a>
      </div>
      <script>
        function logout() {
          if (!confirm('Yakin mau logout WhatsApp?')) return;
          fetch('/logout', {
            method: 'POST',
            headers: { 'x-api-secret': 'bismillah123' }
          }).then(r => r.json()).then(d => {
            alert(d.message || 'Logged out!');
            location.reload();
          });
        }
      </script>
    </body>
    </html>
  `);
});

// ─────────────────────────────────────────
// ENDPOINT: Logout WhatsApp
// ─────────────────────────────────────────
app.post("/logout", requireSecret, async (_req, res) => {
  try {
    if (sock) await sock.logout();
    const fs = require("fs");
    fs.rmSync("./auth_info", { recursive: true, force: true });
    isConnected = false;
    latestQR = null;
    sock = null;
    res.json({ success: true, message: "Logged out. Buka /qr untuk scan ulang." });
    setTimeout(() => connectWhatsApp(), 3000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Keep-alive ping setiap 10 menit ──────────────────────────
setInterval(() => {
  const http = require("http");
  http.get(`http://localhost:${CONFIG.PORT}/health`, () => {});
}, 10 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => console.log(`🚀 Server jalan di port ${CONFIG.PORT}. Buka /qr untuk scan WhatsApp.`));
connectWhatsApp().catch(err => { console.error("Fatal:", err); process.exit(1); });
