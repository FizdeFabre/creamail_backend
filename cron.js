import nodemailer from "nodemailer";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { randomUUID } from "crypto";  // génère un ID unique avant insertion

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
      pass: process.env.EMAIL_PASS // ⚠️ mot de passe d’application Gmail
    },
  });
}

export async function processOnce(batchSize = 50) {
  const now = new Date().toISOString();

  const { data: sequences, error: seqError } = await supabaseAdmin
    .from("email_sequences")
    .select("*")
    .lte("scheduled_at", now)
    .eq("status", "pending");

  if (seqError) throw new Error("Fetch sequences error: " + seqError.message);
  if (!sequences?.length) return { sent: 0, info: "No sequences" };

  const transporter = buildTransporter();
  let sentCount = 0;

  for (const sequence of sequences) {
    // 🔒 Lock
    const { error: lockError } = await supabaseAdmin
      .from("email_sequences")
      .update({ status: "sending" })
      .eq("sequence_id", sequence.id)
      .eq("status", "pending");

    if (lockError) continue;

    const { data: recipients } = await supabaseAdmin
      .from("sequence_recipients")
      .select("to_email")
      .eq("sequence_id", sequence.id);

    if (!recipients?.length) continue;

    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);

      await Promise.all(batch.map(async r => {
        const to = r.to_email;
        if (!to?.includes("@")) return;

        // ⚡ Génère un ID unique pour l'email
        const emailId = randomUUID();

        // Pixel tracker basé sur l’ID
        const pixelUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/open?id=${emailId}`;
        const html = `${sequence.body}<br><img src="${pixelUrl}" width="1" height="1" style="display:none;" />`;

        try {
          // 1️⃣ Envoi du mail
          await transporter.sendMail({
            from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
            to,
            subject: sequence.subject,
            html,
          });

          // 2️⃣ Si succès → insérer en DB
          const { error: insertError } = await supabaseAdmin
            .from("emails_sent")
            .insert({
              id: emailId,          // on impose l’UUID
              sequence_id: sequence.id,
              to_email: to,
              sent_at: new Date().toISOString(),
              opened: false,
              clicked: false,
              responded: false,
              variant: "A",
            });

          if (insertError) {
            console.error("Insert error for", to, insertError.message);
          } else {
            sentCount++;
          }
        } catch (e) {
          console.error("Mail error:", e.message);
        }
      }));

      await new Promise(r => setTimeout(r, 200)); // pause anti-spam
    }

    // 🌀 Update récurrence
    if (sequence.recurrence === "once") {
      await supabaseAdmin.from("email_sequences").update({ status: "completed" }).eq("sequence_id", sequence.id);
    } else {
      const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
      if (nextDate) {
        await supabaseAdmin
          .from("email_sequences")
          .update({ scheduled_at: nextDate, status: "pending" })
          .eq("sequence_id", sequence.id);
      }
    }
  }

  return { sent: sentCount };
}