// server.js
import express from "express";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js"; // Supabase admin client

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase admin client
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Ton processOnce adapté ===
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

async function processOnce() {
  const now = new Date().toISOString();

  // 🔹 On ne prend QUE les séquences prêtes ET pas déjà en cours
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
    // 🔒 On verrouille immédiatement la séquence
    const { error: lockError } = await supabaseAdmin
      .from("email_sequences")
      .update({ status: "sending" })
      .eq("id", sequence.id)
      .eq("status", "pending"); // évite les collisions si 2 workers tournent

    if (lockError) {
      console.error(`Lock error for seq #${sequence.id}:`, lockError.message);
      continue;
    }

    // Double-check : si la séquence n'a pas été lockée (déjà prise ailleurs), on skip
    const { data: lockedSeq } = await supabaseAdmin
      .from("email_sequences")
      .select("status")
      .eq("id", sequence.id)
      .single();

    if (!lockedSeq || lockedSeq.status !== "sending") {
      continue;
    }

    // 📩 On récupère les destinataires
    const { data: recipients, error: recError } = await supabaseAdmin
      .from("sequence_recipients")
      .select("to_email")
      .eq("sequence_id", sequence.id);

    if (recError || !recipients?.length) {
      console.warn(`No recipients for seq #${sequence.id}`);
      continue;
    }

    // 🚀 Envoi des mails
    for (const r of recipients) {
      const to = r.to_email;
      if (!to || !to.includes("@")) continue;

      const { data: inserted } = await supabaseAdmin
        .from("emails_sent")
        .insert({ sequence_id: sequence.id, to_email: to })
        .select()
        .single();

      const html = `${sequence.body}<br><br><img src="https://tondomaine.com/api/open?id=${inserted.id}" width="1" height="1" />`;

      try {
        await transporter.sendMail({
          from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
          to,
          subject: sequence.subject,
          html,
        });
        sentCount++;
        await new Promise(r => setTimeout(r, 200)); // petit delay anti-spam
      } catch (e) {
        console.error("Send error to", to, e?.message);
      }
    }

    // 🗓️ Mise à jour récurrence ou fin
    if (sequence.recurrence === "once") {
      await supabaseAdmin
        .from("email_sequences")
        .update({ status: "completed" })
        .eq("id", sequence.id);
    } else {
      const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
      if (nextDate) {
        await supabaseAdmin
          .from("email_sequences")
          .update({ scheduled_at: nextDate, status: "pending" })
          .eq("id", sequence.id);
      }
    }
  }

  return { sent: sentCount };
}

// Route Cron
app.get("/cron/run", async (req, res) => {
  try {
    const result = await processOnce();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Cron error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});