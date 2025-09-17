import express from "express";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

// --- Config ---
const app = express();
const PORT = process.env.PORT || 3000;
const CRON_KEY = process.env.CRON_KEY;

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Utils ---
function calculateNextDateUTC(current, recurrence) {
  const d = new Date(current);
  switch (recurrence) {
    case "daily":   d.setUTCDate(d.getUTCDate() + 1); break;
    case "weekly":  d.setUTCDate(d.getUTCDate() + 7); break;
    case "monthly": d.setUTCMonth(d.getUTCMonth() + 1); break;
    case "yearly":  d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: return null;
  }
  return d.toISOString();
}

function buildTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.FROM_EMAIL,
      pass: process.env.EMAIL_PASS,
    },
  });
}

// --- Cron logic ---
async function processOnce(batchSize = 50) {
  const now = new Date().toISOString();
  console.log("🔹 CRON START", now);

  const { data: sequences, error: seqError } = await supabaseAdmin
    .from("email_sequences")
    .select("*")
    .lte("scheduled_at", now)
    .eq("status", "pending");

  if (seqError) {
    console.error("❌ Fetch sequences error:", seqError.message);
    return { sent: 0, error: seqError.message };
  }

  console.log("📬 Sequences found:", sequences?.length || 0);
  if (!sequences?.length) return { sent: 0, info: "No sequences to send" };

  const transporter = buildTransporter();
  let sentCount = 0;

  for (const sequence of sequences) {
    console.log("➡️ Processing sequence:", sequence.sequence_id, sequence.subject);

    // Lock sequence
    const { error: lockError } = await supabaseAdmin
      .from("email_sequences")
      .update({ status: "sending" })
      .eq("sequence_id", sequence.sequence_id)
      .eq("status", "pending");

    if (lockError) {
      console.warn("⚠️ Could not lock sequence:", sequence.sequence_id, lockError.message);
      continue;
    }

    // Récupérer les destinataires (via la table dédiée)
    const { data: recipients, error: recError } = await supabaseAdmin
      .from("sequence_recipients")
      .select("to_email")
      .eq("sequence_id", sequence.sequence_id);

    if (recError || !recipients?.length) {
      console.warn("⚠️ No recipients or fetch error for:", sequence.sequence_id);
      continue;
    }

    console.log("👥 Recipients found:", recipients.length);

    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);

      await Promise.all(batch.map(async (r) => {
        const to = r.to_email;
        if (!to?.includes("@")) return;

        // Log email envoyé
        const { data: inserted, error: insErr } = await supabaseAdmin
          .from("emails_sent")
          .insert({
            sequence_id: sequence.sequence_id,
            to_email: to,  // ✅ on enregistre bien l'adresse
            sent_at: new Date().toISOString(),
            opened: false,
            clicked: false,
            responded: false,
            variant: "A"
          })
          .select()
          .single();

        if (insErr || !inserted) {
          console.warn("⚠️ Failed to log email for:", to, insErr?.message);
          return;
        }

        const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
        const pixelUrl = `${BASE_URL}/api/open?id=${inserted.id}`;
        const html = `${sequence.body}<br><img src="${pixelUrl}" width="1" height="1" style="display:none;" />`;

        try {
          const info = await transporter.sendMail({
            from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
            to,
            subject: sequence.subject,
            html,
          });
          console.log("✅ Mail sent:", info.messageId);
          sentCount++;
        } catch (e) {
          console.error("❌ Mail send error to", to, e?.message);
        }
      }));

      await new Promise(r => setTimeout(r, 200)); // anti-spam
    }

    // Reschedule / complete
    if (sequence.recurrence === "once") {
      await supabaseAdmin.from("email_sequences")
        .update({ status: "completed" })
        .eq("sequence_id", sequence.sequence_id);
      console.log("🟢 Sequence completed:", sequence.sequence_id);
    } else {
      const nextDate = calculateNextDateUTC(sequence.scheduled_at, sequence.recurrence);
      if (nextDate) {
        await supabaseAdmin.from("email_sequences")
          .update({ scheduled_at: nextDate, status: "pending" })
          .eq("sequence_id", sequence.sequence_id);
        console.log("🌀 Sequence rescheduled:", nextDate);
      }
    }
  }

  console.log("📈 CRON END, total emails sent:", sentCount);
  return { sent: sentCount };
}

// --- Routes ---
app.get("/", (req, res) => res.send("Backend EchoNotes OK 🚀"));

app.get("/cron/run", async (req, res) => {
  const key = req.query.key;
  if (key !== CRON_KEY) return res.status(403).json({ ok: false, error: "Forbidden: bad key" });

  try {
    const result = await processOnce();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Cron error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/testmail", async (req, res) => {
  try {
    const transporter = buildTransporter();
    const info = await transporter.sendMail({
      from: `"EchoNotes Test" <${process.env.FROM_EMAIL}>`,
      to: process.env.TEST_EMAIL,
      subject: "✅ Test Email from EchoNotes",
      text: "Coucou, ton backend fonctionne 🎉",
    });
    console.log("✅ Test mail sent:", info.messageId);
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    console.error("❌ Test mail error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Pixel route ---
app.get("/api/open", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing email id");

  try {
    const { error } = await supabaseAdmin
      .from("emails_sent")
      .update({ opened: true })
      .eq("id", id);  // ✅ update par id unique

    if (error) {
      console.error("❌ Error updating opened:", error.message);
      return res.status(500).send("DB error");
    }

    res.set("Content-Type", "image/png");
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8HwQACfsD/QkEZHcAAAAASUVORK5CYII=",
      "base64"
    );
    res.send(pixel);
  } catch (e) {
    console.error("❌ Pixel route error:", e.message);
    res.status(500).send("Server error");
  }
});

// --- Start server ---
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));