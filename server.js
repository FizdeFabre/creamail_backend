import express from "express";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function calculateNextDate(current, recurrence) {
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
    auth: { user: process.env.FROM_EMAIL, pass: process.env.EMAIL_PASS },
  });
}

async function processOnce(batchSize = 50) {
  const now = new Date().toISOString();

  // On récupère les séquences prêtes
  const { data: sequences, error: seqError } = await supabaseAdmin
    .from("email_sequences")
    .select("*")
    .lte("scheduled_at", now)
    .eq("status", "pending");

  if (seqError) throw new Error("Fetch sequences error: " + seqError.message);
  if (!sequences?.length) return { sent: 0, info: "No sequences to send" };

  const transporter = buildTransporter();
  let sentCount = 0;

  for (const sequence of sequences) {
    // Lock la séquence
    const { error: lockError } = await supabaseAdmin
      .from("email_sequences")
      .update({ status: "sending" })
      .eq("id", sequence.id)
      .eq("status", "pending");

    if (lockError) continue;

    // Récupère les destinataires
    const { data: recipients, error: recError } = await supabaseAdmin
      .from("sequence_recipients")
      .select("to_email")
      .eq("sequence_id", sequence.id);

    if (recError || !recipients?.length) continue;

    // On envoie les mails par batch
    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);

      await Promise.all(batch.map(async r => {
        const to = r.to_email;
        if (!to?.includes("@")) return;

        const { data: inserted } = await supabaseAdmin
          .from("emails_sent")
          .insert({ sequence_id: sequence.id, to_email: to })
          .select()
          .single();

        if (!inserted) return;

        const html = `${sequence.body}<br><img src="https://tondomaine.com/api/open?id=${inserted.id}" width="1" height="1" />`;

        try {
          await transporter.sendMail({
            from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
            to,
            subject: sequence.subject,
            html,
          });
        } catch (e) {
          console.error("Send error to", to);
        }
      }));

      // Petite pause pour éviter de spammer Gmail
      await new Promise(r => setTimeout(r, 200));
    }

    // Mise à jour récurrence ou completion
    if (sequence.recurrence === "once") {
      await supabaseAdmin.from("email_sequences").update({ status: "completed" }).eq("id", sequence.id);
    } else {
      const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
      if (nextDate) {
        await supabaseAdmin.from("email_sequences").update({ scheduled_at: nextDate, status: "pending" }).eq("id", sequence.id);
      }
    }

    sentCount += recipients.length;
  }

  return { sent: sentCount };
}

// Route Cron
app.get("/cron/run", async (req, res) => {
  try {
    const result = await processOnce();
    res.json({ ok: true, sent: result.sent });
  } catch (err) {
    console.error("Cron error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serveur Express
app.get("/", (req, res) => res.send("Backend EchoNotes OK 🚀"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));