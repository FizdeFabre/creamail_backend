import nodemailer from "nodemailer";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

const BATCH_SIZE = 50;

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
    auth: { 
      user: process.env.FROM_EMAIL, 
      pass: process.env.EMAIL_PASS 
    },
  });
}

export async function processOnce() {
  const now = new Date().toISOString();

  // 1️⃣ Récupère les séquences prêtes
  const { data: sequences, error: seqError } = await supabaseAdmin
    .from("email_sequences")
    .select("id, subject, body, recurrence, scheduled_at")
    .lte("scheduled_at", now)
    .eq("status", "pending");

  if (seqError) throw new Error("Fetch sequences error: " + seqError.message);
  if (!sequences?.length) return { sent: 0, info: "No sequences to send" };

  const transporter = buildTransporter();
  let sentCount = 0;

  for (const sequence of sequences) {
    // 2️⃣ Verrouille la séquence
    const { error: lockError } = await supabaseAdmin
      .from("email_sequences")
      .update({ status: "sending" })
      .eq("id", sequence.id)
      .eq("status", "pending");

    if (lockError) continue;

    // 3️⃣ Récupère les destinataires
    const { data: recipients, error: recError } = await supabaseAdmin
      .from("sequence_recipients")
      .select("to_email")
      .eq("sequence_id", sequence.id);

    if (recError || !recipients?.length) continue;

    // 4️⃣ Envoie par batch
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async r => {
        const to = r.to_email;
        if (!to?.includes("@")) return;

        try {
          // Insert log email envoyé
          const { data: inserted } = await supabaseAdmin
            .from("emails_sent")
            .insert({ sequence_id: sequence.id, to_email: to })
            .select()
            .single();

          // Envoi mail
          const html = `${sequence.body}<br><br><img src="https://tondomaine.com/api/open?id=${inserted.id}" width="1" height="1" />`;
          await transporter.sendMail({
            from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
            to,
            subject: sequence.subject,
            html,
          });

          sentCount++;
        } catch (e) {
          // Pas de log massif, juste un warning minimal
          console.warn(`Failed sending to ${to}`);
        }
      }));

      // Petit délai anti-spam / pour ne pas saturer Gmail
      await new Promise(r => setTimeout(r, 200));
    }

    // 5️⃣ Mise à jour récurrence ou fin
    if (sequence.recurrence === "once") {
      await supabaseAdmin.from("email_sequences").update({ status: "completed" }).eq("id", sequence.id);
    } else {
      const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
      if (nextDate) {
        await supabaseAdmin.from("email_sequences").update({ scheduled_at: nextDate, status: "pending" }).eq("id", sequence.id);
      }
    }
  }

  return { sent: sentCount };
}