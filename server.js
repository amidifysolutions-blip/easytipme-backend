require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');   // ← السطر الثالث ✔

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Firebase Admin (optional) — used to generate branded email-verification links
// that we deliver via Brevo (reliable, on-brand) instead of Firebase's default sender.
let adminAuth = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require('firebase-admin');
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (svc.private_key && svc.private_key.includes('\\n')) svc.private_key = svc.private_key.replace(/\\n/g, '\n');
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(svc) });
    adminAuth = admin.auth();
    console.log('Firebase Admin initialized.');
  } else {
    console.log('FIREBASE_SERVICE_ACCOUNT not set — /send-verification disabled.');
  }
} catch (e) { console.error('Firebase Admin init failed:', e.message); }

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }))
app.use(express.json());

// ---- Branded email helpers (shared by tip + welcome emails) ----
const LOGO_URL = 'https://www.easytipme.com/logo.png';
const APP_URL = 'https://www.easytipme.com';
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function emailShell(bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f2;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
        <tr><td align="center" style="padding:24px 24px 8px;">
          <img src="${LOGO_URL}" width="52" height="52" alt="EasyTipMe" style="display:block;border-radius:13px;">
          <div style="color:#0a0a0a;font-size:18px;font-weight:700;letter-spacing:-.02em;padding-top:9px;">EasyTipMe</div>
        </td></tr>
        <tr><td style="padding:20px 26px 26px;">${bodyHtml}</td></tr>
        <tr><td align="center" style="padding:16px 26px 26px;border-top:1px solid #f0f0f2;color:#9a9aa0;font-size:12px;">Powered by EasyTipMe &middot; Amidify Solutions Inc.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
function tipEmailHtml(name, cur, amt, shopName, fromName) {
  const who = escapeHtml(name || 'there');
  const shop = shopName ? (' at ' + escapeHtml(shopName)) : '';
  const from = fromName ? escapeHtml(fromName) : '';
  const topLabel = from ? ('You just received a tip from ' + from) : 'You just received a tip';
  const lead = from ? (from + ' just left you a tip') : 'A customer just left you a tip';
  return emailShell(`<div style="text-align:center">
    <div style="font-size:15px;color:#6e6e73;margin-bottom:6px;">${topLabel}</div>
    <div style="font-size:40px;font-weight:800;color:#0a0a0a;letter-spacing:-.03em;line-height:1;">${escapeHtml(cur)} ${escapeHtml(amt)}</div>
    <div style="display:inline-block;margin-top:14px;font-size:14px;color:#1f9d55;background:#eef7ee;border-radius:20px;padding:6px 14px;">&#127881; Nice work${shop}</div>
    <p style="font-size:15px;color:#333;line-height:1.5;margin:20px 0 18px;">Hi ${who}, ${lead}. Open your EasyTipMe app to see your earnings.</p>
    <a href="${APP_URL}/staff.html" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:12px;">Open my tips</a>
  </div>`);
}
function welcomeEmailHtml(name, shopName, staffLink) {
  const who = escapeHtml(name || 'there');
  const shop = escapeHtml(shopName || 'your workplace');
  const link = staffLink || (APP_URL + '/staff.html');
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Welcome to EasyTipMe &#128075;</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 6px;">Hi ${who}, <b>${shop}</b> added you to EasyTipMe so you can receive and track your tips.</p>
    <p style="font-size:14px;color:#6e6e73;line-height:1.6;margin:0 0 18px;">Tap below, then create your account using <b>this same email address</b>.</p>
    <a href="${link}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:12px;">Set up my account</a>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:18px 0 0;">If the button doesn't work, open this link:<br><span style="color:#0071e3;word-break:break-all;">${escapeHtml(link)}</span></p>
  </div>`);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'EasyTipMe API' });
});
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,        // مثال: 1000 = $10.00
      currency: currency || 'cad',
      // Card only — this removes Link, Klarna, and all extra methods from the
      // Payment Element. Apple Pay / Google Pay are card-based, so the Express
      // Checkout Element still shows the wallet buttons.
      payment_method_types: ['card'],
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
    const { recipients, amount, currency, shopName, fromName } = req.body;
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
        subject: (fromName ? (fromName + ' sent you a tip! 🎉') : 'You received a tip! 🎉'),
        htmlContent: tipEmailHtml(r.name, cur, amt, shopName, fromName)
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

// Send a branded welcome/invite email when an owner adds a staff member
app.post('/notify-welcome', async (req, res) => {
  try {
    const { email, name, shopName, staffLink } = req.body;
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'noreply@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (!apiKey) return res.json({ sent: 0, note: 'BREVO_API_KEY not set' });
    if (!email) return res.json({ sent: 0, note: 'no email' });
    const payload = {
      sender: { name: senderName, email: senderEmail },
      to: [{ email, name: name || '' }],
      subject: `${shopName ? shopName + ' invited you to ' : 'Welcome to '}EasyTipMe 🎉`,
      htmlContent: welcomeEmailHtml(name, shopName, staffLink)
    };
    try {
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify(payload)
      });
      return res.json({ sent: resp.ok ? 1 : 0 });
    } catch (e) {
      console.error('brevo welcome error', e.message);
      return res.json({ sent: 0, error: e.message });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

function verifyEmailHtml(name, link) {
  const who = escapeHtml(name || 'there');
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Confirm your email</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 6px;">Hi ${who}, tap below to confirm your email and activate your EasyTipMe account.</p>
    <a href="${link}" style="display:inline-block;margin-top:12px;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:12px;">Confirm my email</a>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:20px 0 0;">This link is valid for a limited time. If it expires, just request a new one from the app. If you didn't sign up, you can ignore this email.</p>
  </div>`);
}

// Generate a Firebase email-verification link and deliver it via Brevo (branded, reliable)
app.post('/send-verification', async (req, res) => {
  try {
    const { email, name, continueUrl } = req.body;
    if (!email) return res.json({ sent: 0, note: 'no email' });
    if (!adminAuth) return res.json({ sent: 0, note: 'admin-not-configured' });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'noreply@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (!apiKey) return res.json({ sent: 0, note: 'BREVO_API_KEY not set' });
    const addr = String(email).toLowerCase();
    let link;
    try {
      link = await adminAuth.generateEmailVerificationLink(addr, continueUrl ? { url: continueUrl, handleCodeInApp: false } : undefined);
    } catch (e) {
      // e.g. continueUrl domain not authorized — retry with Firebase's default handler
      link = await adminAuth.generateEmailVerificationLink(addr);
    }
    const payload = {
      sender: { name: senderName, email: senderEmail },
      to: [{ email: addr, name: name || '' }],
      subject: 'Confirm your EasyTipMe email',
      htmlContent: verifyEmailHtml(name, link)
    };
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.json({ sent: resp.ok ? 1 : 0 });
  } catch (error) {
    console.error('send-verification error', error.message);
    return res.json({ sent: 0, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
