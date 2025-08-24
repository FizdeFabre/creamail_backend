import express from "express";
import { processOnce } from "./cron.js";

const app = express();

app.get("/", (req, res) => {
  res.send("Backend EchoNotes OK 🚀");
});

app.get("/cron/send-emails", async (req, res) => {
  if (process.env.CRON_SECRET) {
    const provided = req.headers["x-cron-secret"];
    if (provided !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const result = await processOnce();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("Cron fatal:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Backend running on port", port));