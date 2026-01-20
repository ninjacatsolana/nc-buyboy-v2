const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

let lastEvent = null;

app.get("/health", (req, res) => {
  res.status(200).send("ok-v2");
});



app.get("/overlay", (req, res) => {
  res.status(200).send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>NC Overlay</title>
        <style>
          body {
            margin: 0;
            background: transparent;
            overflow: hidden;
            font-family: Arial, sans-serif;
          }
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
          }
        </style>
      </head>
      <body>
        <div id="box"></div>

        <script>
          async function poll() {
            try {
              const res = await fetch("/event");
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

app.get("/event", (req, res) => {
  if (lastEvent) {
    const e = lastEvent;
    lastEvent = null;
    return res.json(e);
  }
  res.json(null);
});

// test trigger
app.get("/test-alert", (req, res) => {
  lastEvent = { text: "Test Buy Detected" };
  res.send("ok");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NC BUYBOT V2 LIVE on port ${PORT}`);
});
