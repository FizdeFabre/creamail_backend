import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function calculateNextDate(current, recurrence) {
  const d = new Date(current);
  switch (recurrence) {
    case "daily": d.setUTCDate(d.getUTCDate() + 1); break;
    case "weekly": d.setUTCDate(d.getUTCDate() + 7); break;
    case "monthly": d.setUTCMonth(d.getUTCMonth() + 1); break;
    case "yearly": d.setUTCFullYear(d.getUTCFullYear() + 1); break;
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

export async function GET() {
  try {
    const now = new Date().toISOString();
    const { data: sequences } = await supabaseAdmin
      .from("email_sequences")
      .select("*")
      .lte("scheduled_at", now)
      .eq("status", "pending");

    if (!sequences?.length) {
      return new Response(JSON.stringify({ sent: 0, info: "No sequences" }), { status: 200 });
    }

    const transporter = buildTransporter();
    let sentCount = 0;

    for (const sequence of sequences) {
      const { data: recipients } = await supabaseAdmin
        .from("sequence_recipients")
        .select("to_email")
        .eq("sequence_id", sequence.id);

      for (const r of recipients || []) {
        try {
          await transporter.sendMail({
            from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
            to: r.to_email,
            subject: sequence.subject,
            html: sequence.body,
          });
          sentCount++;
        } catch (e) {
          console.error("Mail error:", e.message);
        }
      }

      // Update sequence status
      if (sequence.recurrence === "once") {
        await supabaseAdmin
          .from("email_sequences")
          .update({ status: "completed" })
          .eq("id", sequence.id);
      } else {
        const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
        await supabaseAdmin
          .from("email_sequences")
          .update({ scheduled_at: nextDate, status: "pending" })
          .eq("id", sequence.id);
      }
    }

    return new Response(JSON.stringify({ ok: true, sent: sentCount }), { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
}