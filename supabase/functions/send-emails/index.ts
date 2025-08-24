// supabase/functions/send-emails/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import "https://deno.land/x/dotenv/load.ts";

console.log("📡 Supabase Edge Function ready to send emails");

const supabase = createClient(
    Deno.env.get("NEXT_PUBLIC_SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async () => {
    const now = new Date().toISOString();

    const { data: emails, error } = await supabase
        .from("email_sequences")
        .select("*")
        .lte("scheduled_at", now)
        .eq("status", "pending");

    if (error) return new Response(`❌ Error: ${error.message}`, { status: 500 });

    if (!emails || emails.length === 0) {
        return new Response("✅ Aucun mail à envoyer", { status: 200 });
    }

    for (const email of emails) {
        if (!email.to_email || !email.to_email.includes("@")) continue;

        const { data: inserted, error: insertError } = await supabase
            .from("emails_sent")
            .insert({
                sequence_id: email.id,
                to_email: email.to_email,
            })
            .select()
            .single();

        if (insertError || !inserted) continue;

        const pixelUrl = `https://tondomaine.com/api/open?id=${inserted.id}`;
        const trackingPixel = `<img src="${pixelUrl}" alt="" width="1" height="1" />`;
        const emailHtmlBody = `${email.body}<br><br>${trackingPixel}`;

        // Ici, il faut envoyer l’email via un provider **externe**
        // Tu ne peux pas utiliser nodemailer dans Deno : utilise un webhook ou un service externe ici
        // Exemple : requête vers un serveur tiers / SendGrid / Resend API etc.

        // Mise à jour du statut
        if (email.recurrence === "once") {
            await supabase.from("email_sequences").delete().eq("id", email.id);
        } else {
            const nextDate = calculateNextDate(email.scheduled_at, email.recurrence);
            if (nextDate) {
                await supabase
                    .from("email_sequences")
                    .update({ scheduled_at: nextDate, status: "pending" })
                    .eq("id", email.id);
            }
        }

        await supabase
            .from("email_sequences")
            .update({ status: "sent" })
            .eq("id", email.id);
    }

    return new Response("✅ Envois traités", { status: 200 });
});

function calculateNextDate(current: string, recurrence: string): string | null {
    const date = new Date(current);
    switch (recurrence) {
        case "daily":
            date.setUTCDate(date.getUTCDate() + 1);
            break;
        case "weekly":
            date.setUTCDate(date.getUTCDate() + 7);
            break;
        case "monthly":
            date.setUTCMonth(date.getUTCMonth() + 1);
            break;
        case "yearly":
            date.setUTCFullYear(date.getUTCFullYear() + 1);
            break;
        default:
            return null;
    }
    return date.toISOString();
}