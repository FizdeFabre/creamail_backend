import fetch from 'node-fetch';
import 'dotenv/config';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY!;
const FROM = 'echonotes2@gmail.com'; // ton sender validé
const TO = 'joris0ingargiola@gmail.com'; // ton mail perso

async function sendMail() {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${SENDGRID_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            personalizations: [
                {
                    to: [{ email: TO }],
                    subject: '🧪 Test EchoNotes',
                },
            ],
            from: { email: FROM },
            content: [
                {
                    type: 'text/plain',
                    value: 'Ceci est un test d’envoi via SendGrid. Si tu le lis, la magie opère ! 🧙‍♂️',
                },
            ],
        }),
    });

    console.log(`📬 Statut : ${res.status}`);
    const txt = await res.text();
    console.log(`🔍 Réponse SendGrid : ${txt}`);
    console.log(`✅ Mail bien envoyé à ${TO}`);
}

sendMail().catch(console.error);