require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');   // ← السطر الثالث ✔

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }))
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'EasyTipMe API' });
});
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,        // مثال: 1000 = $10.00
      currency: currency || 'cad',
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Send an email to staff when they receive a tip (via Brevo)
app.post('/notify-tip', async (req, res) => {
  try {
    const { recipients, amount, currency, shopName } = req.body;
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'noreply@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (!apiKey) return res.json({ sent: 0, note: 'BREVO_API_KEY not set' });
    const list = (recipients || []).filter(r => r && r.email);
    const amt = Number(amount || 0).toFixed(2);
    const cur = (currency || '').toUpperCase();
    let sent = 0;
    for (const r of list) {
      const payload = {
        sender: { name: senderName, email: senderEmail },
        to: [{ email: r.email, name: r.name || '' }],
        subject: 'You received a tip! 🎉',
        htmlContent: `<div style="font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
          <h2 style="margin:0 0 8px">You just got a tip 🎉</h2>
          <p style="font-size:16px;color:#333">Hi ${r.name || 'there'}, you received a tip of <b>${cur} ${amt}</b>${shopName ? ' at ' + shopName : ''}.</p>
          <p style="color:#999;font-size:12px;margin-top:24px">Powered by EasyTipMe · Amidify Solutions Inc.</p>
        </div>`
      };
      try {
        const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (resp.ok) sent++;
      } catch (e) { console.error('brevo send error', e.message); }
    }
    res.json({ sent });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
