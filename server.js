"use strict";

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const axios = require("axios");
const OAuth = require("oauth-1.0a");
const FormData = require("form-data");
const sharp = require("sharp");

const app = express();

app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

/*
  Required env
  PORT, set by Railway
  WEBHOOK_AUTH, Helius Authorization header secret
  WEBHOOK_PATH, default /webhooks/helius

  X OAuth 1.0a user context, bot account
  X_API_KEY
  X_API_KEY_SECRET
  X_ACCESS_TOKEN
  X_ACCESS_TOKEN_SECRET

  Optional behavior
  POST_TO_X, true or false, default true
  ALERT_ENABLED, true or false, default true
  ALERT_URL_BASE, for tweet link and overlay link, example https://your-railway-domain.up.railway.app

  Optional filters
  NC_MINT, if you want to only react to NC token transfers
  MIN_NC_AMOUNT, minimum token amount to trigger
  COOLDOWN_SECONDS, default 20
  STRICT_FILTER, true or false
*/

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_PATH = (process.env.WEBHOOK_PATH || "/webhooks/helius").trim();
const WEBHOOK_AUTH = (process.env.WEBHOOK_AUTH || "").trim();

const POST_TO_X = String(process.env.POST_TO_X || "true").toLowerCase() === "true";
const ALERT_ENABLED = String(process.env.ALERT_ENABLED || "true").toLowerCase() === "true";

const ALERT_URL_BASE = (process.env.ALERT_URL_BASE || "").trim().replace(/\/$/, "");

const NC_MINT = (process.env.NC_MINT || "").trim();
const MIN_NC_AMOUNT = Number(process.env.MIN_NC_AMOUNT || 0);
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || 20);
const STRICT_FILTER = String(process.env.STRICT_FILTER || "false").toLowerCase() === "true";

const X_API_KEY = (process.env.X_API_KEY || "").trim();
const X_API_KEY_SECRET = (process.env.X_API_KEY_SECRET || "").trim();
const X_ACCESS_TOKEN = (process.env.X_ACCESS_TOKEN || "").trim();
const X_ACCESS_TOKEN_SECRET = (process.env.X_ACCESS_TOKEN_SECRET || "").trim();

const hasXCreds = Boolean(X_API_KEY && X_API_KEY_SECRET && X_ACCESS_TOKEN && X_ACCESS_TOKEN_SECRET);

/*
  In memory state
*/
const seenSignatures = new Set();
let lastPostAt = 0;

let lastAlert = null;
/*
  lastAlert shape:
  {
    id,
    signature,
    createdAt,
    text,
    imagePath, (buffer served by /alert/image)
    txUrl,
    amount,
    mint
  }
*/
let lastAlertImageBuffer = null;

function nowMs() {
  return Date.now();
}

function makeId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

/*
  OAuth 1.0a client
  X supports OAuth 1.0a user context for v2 tweet create, and v1.1 media upload is commonly used for media :contentReference[oaicite:3]{index=3}
*/
function getOAuth() {
  return new OAuth({
    consumer: { key: X_API_KEY, secret: X_API_KEY_SECRET },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}

function oauthHeaders(oauth, url, method, data) {
  const token = { key: X_ACCESS_TOKEN, secret: X_ACCESS_TOKEN_SECRET };
  const authData = oauth.authorize({ url, method, data }, token);
  return oauth.toHeader(authData);
}

/*
  Best effort buy detection from Helius enhanced payload
  We treat a "buy" as: tokenTransfers includes NC_MINT, and tokenAmount >= MIN_NC_AMOUNT
  If NC_MINT is empty, we fall back to: any token transfer event triggers, not recommended for production.
*/
function extractBuyFromHeliusItem(item) {
  const signature = item.signature || item.transactionSignature || item.txSignature || null;
  const type = item.type || item.transactionType || "UNKNOWN";
  const description = item.description || item.summary || "";

  const tokenTransfers = Array.isArray(item.tokenTransfers) ? item.tokenTransfers : [];

  let matched = null;

  for (const t of tokenTransfers) {
    const mint = (t.mint || "").trim();
    const amt = safeNum(t.tokenAmount ?? t.amount ?? 0);

    if (NC_MINT) {
      if (mint !== NC_MINT) continue;
      if (amt < MIN_NC_AMOUNT) continue;
      matched = { mint, amount: amt };
      break;
    } else {
      if (amt <= 0) continue;
      matched = { mint: mint || "UNKNOWN_MINT", amount: amt };
      break;
    }
  }

  if (!matched && STRICT_FILTER) return null;

  return {
    signature,
    type,
    description,
    amount: matched ? matched.amount : null,
    mint: matched ? matched.mint : null,
    raw: item,
  };
}

/*
  Create a clean buy image using sharp,
  no template required, generates a PNG buffer
*/
async function buildBuyImagePng({ amount, mint, signature }) {
  const title = "NINJA CAT BUY";
  const amtLine = amount != null ? `${amount.toLocaleString()} NC` : "BUY DETECTED";
  const mintLine = mint ? `Mint: ${mint.slice(0, 6)}…${mint.slice(-6)}` : "";
  const sigLine = signature ? `Tx: ${signature.slice(0, 8)}…${signature.slice(-8)}` : "";

  const svg = `
  <svg width="1200" height="675" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0b0b0f"/>
        <stop offset="50%" stop-color="#111827"/>
        <stop offset="100%" stop-color="#0b0b0f"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="6" result="coloredBlur"/>
        <feMerge>
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>

    <rect width="1200" height="675" fill="url(#bg)"/>
    <rect x="40" y="40" width="1120" height="595" rx="28" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.10)"/>

    <text x="80" y="155" font-family="Arial Black, Arial" font-size="64" fill="#ffffff" filter="url(#glow)">${title}</text>
    <text x="80" y="260" font-family="Arial Black, Arial" font-size="74" fill="#f59e0b" filter="url(#glow)">${amtLine}</text>

    <text x="80" y="330" font-family="Arial, sans-serif" font-size="26" fill="rgba(255,255,255,0.85)">${mintLine}</text>
    <text x="80" y="370" font-family="Arial, sans-serif" font-size="26" fill="rgba(255,255,255,0.85)">${sigLine}</text>

    <text x="80" y="605" font-family="Arial, sans-serif" font-size="28" fill="rgba(255,255,255,0.70)">@ninjacatbuybot</text>
  </svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png;
}

/*
  Upload media to X using v1.1 media upload
*/
async function xUploadMedia(pngBuffer) {
  const oauth = getOAuth();
  const url = "https://upload.twitter.com/1.1/media/upload.json";

  const form = new FormData();
  form.append("media", pngBuffer.toString("base64"));

  const headers = {
    ...form.getHeaders(),
    ...oauthHeaders(oauth, url, "POST", {}),
  };

  const resp = await axios.post(url, form, { headers });
  const mediaId = resp?.data?.media_id_string || resp?.data?.media_id;
  if (!mediaId) throw new Error("Media upload failed, missing media id");
  return String(mediaId);
}

/*
  Post tweet via X API v2
*/
async function xCreateTweet({ text, mediaId }) {
  const oauth = getOAuth();
  const url = "https://api.x.com/2/tweets";

  const body = mediaId
    ? { text, media: { media_ids: [String(mediaId)] } }
    : { text };

  const headers = {
    "Content-Type": "application/json",
    ...oauthHeaders(oauth, url, "POST", {}),
  };

  const resp = await axios.post(url, body, { headers });
  const tweetId = resp?.data?.data?.id;
  if (!tweetId) throw new Error("Tweet create failed, missing tweet id");
  return String(tweetId);
}

/*
  Stream alert HTML, designed for Streamlabs Browser Source
  It polls /alert/data every 1s, when id changes it shows the image and text, then hides.
*/
function alertHtml() {
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>NC Buy Alert</title>
    <style>
      html, body { margin:0; padding:0; background: transparent; overflow:hidden; }
      #wrap { position: relative; width: 100vw; height: 100vh; }
      #card {
        position: absolute;
        left: 50%;
        top: 12%;
        transform: translateX(-50%);
        width: 820px;
        border-radius: 18px;
        background: rgba(0,0,0,0.65);
        border: 1px solid rgba(255,255,255,0.18);
        padding: 14px;
        display: none;
        backdrop-filter: blur(8px);
        color: white;
        font-family: Arial, sans-serif;
      }
      #img { width: 100%; border-radius: 14px; display:block; }
      #text { margin-top: 10px; font-size: 24px; font-weight: 700; }
      #sub { margin-top: 6px; font-size: 16px; opacity: 0.8; }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="card">
        <img id="img" src="" />
        <div id="text"></div>
        <div id="sub"></div>
      </div>
    </div>

    <script>
      const card = document.getElementById("card");
      const img = document.getElementById("img");
      const text = document.getElementById("text");
      const sub = document.getElementById("sub");

      let lastId = null;
      let showing = false;

      async function tick() {
        try {
          const r = await fetch("/alert/data", { cache: "no-store" });
          const j = await r.json();

          if (!j.ok || !j.alert) return;

          if (j.alert.id && j.alert.id !== lastId && !showing) {
            lastId = j.alert.id;
            showing = true;

            img.src = "/alert/image?bust=" + Date.now();
            text.textContent = j.alert.text || "Buy detected";
            sub.textContent = j.alert.txUrl || "";

            card.style.display = "block";

            setTimeout(() => {
              card.style.display = "none";
              showing = false;
            }, 8000);
          }
        } catch (e) {
        }
      }

      setInterval(tick, 1000);
    </script>
  </body>
</html>`;
}

/*
  Routes
*/
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "nc-buyboy-v2",
    time: new Date().toISOString(),
    webhookPath: WEBHOOK_PATH,
    postToX: POST_TO_X,
    alertEnabled: ALERT_ENABLED,
    hasXCreds,
    mintFilterOn: Boolean(NC_MINT),
  });
});

app.get("/alert", (req, res) => {
  if (!ALERT_ENABLED) return res.status(404).send("alerts disabled");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(alertHtml());
});

app.get("/alert/data", (req, res) => {
  if (!ALERT_ENABLED) return res.status(404).json({ ok: false });
  res.json({ ok: true, alert: lastAlert });
});

app.get("/alert/image", (req, res) => {
  if (!ALERT_ENABLED) return res.status(404).send("alerts disabled");
  if (!lastAlertImageBuffer) return res.status(404).send("no image yet");
  res.setHeader("Content-Type", "image/png");
  res.status(200).send(lastAlertImageBuffer);
});

/*
  The webhook receiver
  Verify Helius by matching the Authorization header you set in the webhook config :contentReference[oaicite:4]{index=4}
*/
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    if (WEBHOOK_AUTH) {
      const auth = req.get("Authorization") || "";
      if (auth !== WEBHOOK_AUTH) {
        return res.status(401).json({ ok: false, error: "Unauthorized webhook" });
      }
    }

    const body = req.body;
    const items = Array.isArray(body) ? body : [body];

    let accepted = 0;
    let triggered = 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const buy = extractBuyFromHeliusItem(item);
      if (!buy) continue;

      accepted += 1;

      const sig = buy.signature || null;
      if (sig && seenSignatures.has(sig)) continue;

      const elapsed = (nowMs() - lastPostAt) / 1000;
      if (elapsed < COOLDOWN_SECONDS) continue;

      const amount = buy.amount;
      const mint = buy.mint;

      if (NC_MINT && mint && mint !== NC_MINT) continue;
      if (MIN_NC_AMOUNT && amount != null && amount < MIN_NC_AMOUNT) continue;

      if (sig) {
        seenSignatures.add(sig);
        if (seenSignatures.size > 5000) {
          // simple cap, drop oldest by recreating the set
          const arr = Array.from(seenSignatures).slice(-2500);
          seenSignatures.clear();
          for (const x of arr) seenSignatures.add(x);
        }
      }

      const txUrl = sig ? `https://solscan.io/tx/${sig}` : "";
      const overlayUrl = ALERT_URL_BASE ? `${ALERT_URL_BASE}/alert` : "";

      const textParts = [];
      if (amount != null) textParts.push(`NC BUY: ${amount.toLocaleString()} NC`);
      else textParts.push("NC BUY DETECTED");
      if (txUrl) textParts.push(txUrl);
      if (overlayUrl) textParts.push(`Live alert: ${overlayUrl}`);

      const postText = textParts.join("\n");

      // Build image and store alert state for Streamlabs
      const png = await buildBuyImagePng({ amount, mint, signature: sig });
      lastAlertImageBuffer = png;

      lastAlert = {
        id: makeId(),
        signature: sig,
        createdAt: new Date().toISOString(),
        text: amount != null ? `NC BUY: ${amount.toLocaleString()} NC` : "NC BUY DETECTED",
        txUrl,
        amount,
        mint,
      };

      // Post to X
      if (POST_TO_X) {
        if (!hasXCreds) {
          console.log("X creds missing, skipping X post");
        } else {
          const mediaId = await xUploadMedia(png);
          const tweetId = await xCreateTweet({ text: postText, mediaId });
          console.log("Posted to X, tweet id:", tweetId);
        }
      }

      lastPostAt = nowMs();
      triggered += 1;
    }

    return res.status(200).json({ ok: true, accepted, triggered });
  } catch (err) {
    console.error("webhook error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

app.listen(PORT, () => {
  console.log(`nc-buyboy-v2 listening on ${PORT}`);
  console.log(`Webhook path: ${WEBHOOK_PATH}`);
});
