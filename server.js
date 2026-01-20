const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.get("/overlay", (req, res) => {
  res.status(200).send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>NC Overlay</title>
        <style>
          body { margin: 0; background: transparent; overflow: hidden; }
          .wrap { font-family: Arial, sans-serif; font-size: 48px; color: white; padding: 20px; }
        </style>
      </head>
      <body>
        <div class="wrap">Overlay is live ✅</div>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

