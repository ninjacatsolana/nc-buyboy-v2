const express = require("express");
const path = require("path");

const app = express();

// middleware
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// static (safe to keep)
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

let lastEvent = null;

// health
app.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  return res.status(200).send("ok-v3");
});

// simple ping
app.get("/ping-v3", (req, res) => {
  return res.status(200).send("pong-v3");
});

// sanity route
app.get("/routes-check", (req, res) => {
  return res.status(200).send("routes ok v3");
});

// THIS should stop the browser "Cannot GET /webhook/buy"
app.get("/webhook/buy", (req, res) => {
  return res.status(200).send("buy route is here");
});

// debug echo
app.post("/webhook/buy-test", (req, res) => {
  console.log("HIT /webhook/buy-test", req.headers["content-type"], req.body);
  return res.status(200).json({ ok: true, got: req.body });
});

// webhook trigger
app.post("/webhook/buy", (req, res) => {
  const amount = req.body?.amount;

  if (amount === undefined || amount === null) {
    return res.status(400).send("missing amount");
  }

  const formatted = Number(amount).toLocaleString();

  lastEvent = {
    text: `Bought ${formatted} NC , The Dojo Grows`,
  };

  return res.status(200).send("ok");
});

// event poll (returns once, then clears)
app.get("/event", (req, res) => {
  if (lastEvent) {
    const e = lastEvent;
    lastEvent = null;
    return res.json(e);
  }
  return res.json(null);
});

// manual test trigger
app.get("/test-alert", (req, res) => {
  lastEvent = { text: "Test Buy Detected" };
  return res.send("ok");
});

// overlay page
app.get("/overlay", (req, res) => {
  return res.status(200).send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>NC Overlay</title>
    <style>
      body { margin: 0; background: transparent; overflow: hidden; font-family: Arial, sans-serif; }
      #box {
        position: absolute;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        padding: 20px 32px;
        border-radius: 12px;
        background: rgba(0,0,0,0.75);
        color: white;
        font-size: 42px;
        display: none;
        white-space: nowrap;
      }
    </style>
  </head>
  <body>
    <div id="box"></div>
    <script>
      async function poll() {
        try {
          const res = await fetch("/event", { cache: "no-store" });
          const data = await res.json();

          if (data && data.text) {
            const box = document.getElementById("box");
            box.textContent = data.text;
            box.style.display = "block";

            setTimeout(() => {
              box.style.display = "none";
            }, 5000);
          }
        } catch (e) {}

        setTimeout(poll, 1000);
      }

      poll();
    </script>
  </body>
</html>
  `);
});

// listen (ONLY ONCE, AT BOTTOM)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NC BUYBOT V2 LIVE on port ${PORT}`);
});
