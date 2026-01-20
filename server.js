// server.js
"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();

/**
 * Config
 */
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhooks/helius";
const WEBHOOK_AUTH = process.env.WEBHOOK_AUTH || ""; // must match Authorization header
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 50);

// Optional filters, leave empty to accept all
const NC_MINT = (process.env.NC_MINT || "").trim(); // token mint to focus on
const WATCH_WALLET = (process.env.WATCH_WALLET || "").trim(); // wallet to focus on

/**
 * In memory event store and SSE clients
 */
const recentEvents = [];
const sseClients = new Set();

function pushEvent(evt) {
  recentEvents.unshift(evt);
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;

  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (e) {
      // ignore, cleanup happens on close
    }
  }
}

/**
 * Middleware
 */
app.set("trust proxy", true);

// Helius posts JSON
app.use(express.json({ limit: "2mb" }));

/**
 * Static overlay
 */
app.use(express.static(path.join(__dirname, "public")));

/**
 * Health
 */
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    name: "nc-buyboy-v2",
    time: new Date().toISOString(),
    webhookPath: WEBHOOK_PATH,
    eventCount: recentEvents.length,
  });
});

/**
 * Get recent events
 */
app.get("/events", (req, res) => {
  res.status(200).json({
    ok: true,
    count: recentEvents.length,
    events: recentEvents,
  });
});

/**
 * SSE stream for overlays
 */
app.get("/events/stream", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Tell client we are alive
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  // Send a snapshot
  res.write(`event: snapshot\ndata: ${JSON.stringify(recentEvents)}\n\n`);

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

/**
 * Helper, tries to extract a meaningful "buy" signal from Helius enhanced payloads,
 * but also works fine as a generic event logger.
 */
function normalizeHeliusItem(item) {
  // Helius enhanced webhook items often include fields like:
  // signature, type, description, timestamp, tokenTransfers, nativeTransfers, accountData, events, etc.
  const signature = item.signature || item.transactionSignature || item.txSignature || null;
  const type = item.type || item.transactionType || "UNKNOWN";
  const description = item.description || item.summary || null;

  const timestamp =
    item.timestamp ||
    item.blockTime ||
    (item.slot ? null : null) ||
    Math.floor(Date.now() / 1000);

  // Token and SOL movement best effort
  let ncTokenDelta = null;
  let solDelta = null;

  const tokenTransfers = Array.isArray(item.tokenTransfers) ? item.tokenTransfers : [];
  const nativeTransfers = Array.isArray(item.nativeTransfers) ? item.nativeTransfers : [];

  // Optional filtering by mint and wallet
  const mintFilterOn = Boolean(NC_MINT);
  const walletFilterOn = Boolean(WATCH_WALLET);

  // Token delta, sum amounts for the mint, optionally scoped to wallet
  if (tokenTransfers.length) {
    let sum = 0;
    let found = false;

    for (const t of tokenTransfers) {
      const mint = (t.mint || "").trim();
      if (mintFilterOn && mint !== NC_MINT) continue;

      const from = (t.fromUserAccount || t.fromTokenAccount || "").trim();
      const to = (t.toUserAccount || t.toTokenAccount || "").trim();

      if (walletFilterOn && from !== WATCH_WALLET && to !== WATCH_WALLET) continue;

      const amt = Number(t.tokenAmount ?? t.amount ?? 0);
      if (!Number.isFinite(amt) || amt === 0) continue;

      // If WATCH_WALLET is set, treat incoming as positive, outgoing as negative
      if (walletFilterOn) {
        if (to === WATCH_WALLET) sum += amt;
        if (from === WATCH_WALLET) sum -= amt;
      } else {
        // No wallet context, just sum absolute movement
        sum += Math.abs(amt);
      }

      found = true;
    }

    if (found) ncTokenDelta = sum;
  }

  // SOL delta, sum lamports for wallet if provided, otherwise sum absolute movement
  if (nativeTransfers.length) {
    let sumSol = 0;
    let found = false;

    for (const n of nativeTransfers) {
      const from = (n.fromUserAccount || "").trim();
      const to = (n.toUserAccount || "").trim();

      if (walletFilterOn && from !== WATCH_WALLET && to !== WATCH_WALLET) continue;

      const lamports = Number(n.amount ?? 0);
      if (!Number.isFinite(lamports) || lamports === 0) continue;

      const sol = lamports / 1e9;

      if (walletFilterOn) {
        if (to === WATCH_WALLET) sumSol += sol;
        if (from === WATCH_WALLET) sumSol -= sol;
      } else {
        sumSol += Math.abs(sol);
      }

      found = true;
    }

    if (found) solDelta = sumSol;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    receivedAt: new Date().toISOString(),
    signature,
    type,
    description,
    timestamp,
    ncTokenDelta,
    solDelta,
    raw: item, // keep full payload for debugging
  };
}

/**
 * Helius webhook receiver
 * Verification method: set a secret value as the Authorization header when creating the webhook,
 * Helius echoes it back to your endpoint, verify it here. :contentReference[oaicite:1]{index=1}
 */
app.post(WEBHOOK_PATH, (req, res) => {
  if (WEBHOOK_AUTH) {
    const auth = req.get("Authorization") || "";
    if (auth !== WEBHOOK_AUTH) {
      return res.status(401).json({ ok: false, error: "Unauthorized webhook" });
    }
  }

  const body = req.body;

  const items = Array.isArray(body) ? body : [body];

  // Normalize and optionally filter out empty items
  let accepted = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const evt = normalizeHeliusItem(item);

    // If you want strict filtering, enable it by setting NC_MINT or WATCH_WALLET
    // and require at least one meaningful delta.
    const strict = String(process.env.STRICT_FILTER || "").toLowerCase() === "true";
    if (strict && NC_MINT && evt.ncTokenDelta === null) continue;
    if (strict && WATCH_WALLET && evt.solDelta === null && evt.ncTokenDelta === null) continue;

    pushEvent(evt);
    accepted += 1;
  }

  res.status(200).json({ ok: true, accepted });
});

/**
 * Start
 */
app.listen(PORT, () => {
  console.log(`nc-buyboy-v2 listening on port ${PORT}`);
  console.log(`Webhook path: ${WEBHOOK_PATH}`);
});
