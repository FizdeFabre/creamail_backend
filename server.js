import express from "express";
import { processOnce } from "./cronJob.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Backend EchoNotes OK 🚀"));

app.get("/cron/run", async (req, res) => {
  try {
    const result = await processOnce();
    res.json({ ok: true, sent: result.sent });
  } catch (err) {
    console.error("Cron error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));