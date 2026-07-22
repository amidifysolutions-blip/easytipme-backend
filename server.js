require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');   // ← السطر الثالث ✔

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// The publishable key the customer tip page must use. It MUST match the mode
// (test/live) of STRIPE_SECRET_KEY above — set both together on Render. The
// frontend asks the backend for this so the two can never drift out of sync
// (a mismatch makes Stripe refuse to render the card field). Public by design.
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
// Connect endpoints can use a SEPARATE key (e.g. a TEST key) so we can test
// staff bank onboarding without touching live payments. If unset, falls back
// to the main (live) key — which is what production will use.
const connectStripe = process.env.STRIPE_CONNECT_SECRET_KEY ? new Stripe(process.env.STRIPE_CONNECT_SECRET_KEY) : stripe;

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
// New worker — account was created for them; email their login + temporary password.
function inviteCredsHtml(name, shopName, loginEmail, tempPass, shopCode, staffLink) {
  const who = escapeHtml(name || 'there');
  const shop = escapeHtml(shopName || 'your workplace');
  const link = staffLink || (APP_URL + '/staff.html');
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Welcome to ${shop} &#128075;</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 14px;">Hi ${who}, your tipping account is ready. Log in with the details below — you'll set your own password on first sign-in.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f9;border-radius:14px;margin:0 0 18px;">
      <tr><td style="padding:16px 18px;font-size:14px;color:#333;line-height:1.9;text-align:left;">
        ${shopCode ? `<div><span style="color:#8a8a90;">Workplace code:</span> <b style="letter-spacing:.06em;">${escapeHtml(shopCode)}</b></div>` : ''}
        <div><span style="color:#8a8a90;">Login email:</span> <b>${escapeHtml(loginEmail)}</b></div>
        <div><span style="color:#8a8a90;">Temporary password:</span> <b style="font-family:monospace;font-size:15px;letter-spacing:.04em;">${escapeHtml(tempPass)}</b></div>
      </td></tr>
    </table>
    <a href="${link}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:12px;">Open the app &amp; log in</a>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:18px 0 0;">For your security, you'll be asked to choose a new password and confirm your email the first time you log in. If you didn't expect this, you can ignore this email.</p>
  </div>`);
}
// Existing worker — they already have an EasyTipMe account; just notify they were added.
function addedToShopHtml(name, shopName, shopCode, staffLink) {
  const who = escapeHtml(name || 'there');
  const shop = escapeHtml(shopName || 'a workplace');
  const link = staffLink || (APP_URL + '/staff.html');
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">You've been added to ${shop}</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 14px;">Hi ${who}, <b>${shop}</b> added you on EasyTipMe. Just log in with your existing email and password — no new account needed.</p>
    ${shopCode ? `<div style="font-size:14px;color:#333;margin:0 0 16px;">Workplace code: <b style="letter-spacing:.06em;">${escapeHtml(shopCode)}</b></div>` : ''}
    <a href="${link}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:12px;">Open the app</a>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:18px 0 0;">If this wasn't expected, you can ignore this email.</p>
  </div>`);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'EasyTipMe API' });
});
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { businessId, staffId, tipCents, currency, amount } = req.body;

    // ---- Legacy / team path -------------------------------------------------
    // When we don't have a single recipient to route to (e.g. a team/multi tip,
    // which we split in a later phase), fall back to a plain charge on the
    // platform so tipping still works. No split happens here.
    if (!businessId || !staffId || !tipCents) {
      const pi = await stripe.paymentIntents.create({
        amount: amount || tipCents,
        currency: (currency || 'cad').toLowerCase(),
        payment_method_types: ['card'],
      });
      return res.json({ clientSecret: pi.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY });
    }

    // ---- Direct-to-worker split (the real model) ----------------------------
    if (!adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const tip = Math.round(Number(tipCents));
    if (!(tip > 0)) return res.status(400).json({ error: 'bad-amount' });

    const bizSnap = await adminDb.collection('businesses').doc(businessId).get();
    if (!bizSnap.exists) return res.status(404).json({ error: 'shop-not-found' });
    const biz = bizSnap.data();
    if (biz.blocked) return res.status(403).json({ error: 'shop-unavailable' });
    const cur = (currency || biz.currency || 'cad').toLowerCase();

    // Station 1: platform commission — a % of the tip PLUS a small fixed fee,
    // both ADDED ON TOP of the tip. The fixed part covers Stripe's fixed
    // per-transaction cost (~$0.30) so even small tips stay profitable
    // (industry standard, e.g. TackPay charges "5% + £0.25").
    // Priority for each value: per-shop → global default (config/platform) → fallback.
    let cfgData = {};
    try { const cfg = await adminDb.collection('config').doc('platform').get(); if (cfg.exists) cfgData = cfg.data() || {}; } catch (_) {}

    let commPct = null;
    if (biz.commissionPercent != null && !isNaN(Number(biz.commissionPercent))) commPct = Number(biz.commissionPercent);
    else if (cfgData.commissionPercent != null) commPct = Number(cfgData.commissionPercent);
    if (commPct == null || !(commPct >= 0)) commPct = 7;

    let commFixed = null;   // in the tip's currency units (e.g. 0.30 = $0.30)
    if (biz.commissionFixed != null && !isNaN(Number(biz.commissionFixed))) commFixed = Number(biz.commissionFixed);
    else if (cfgData.commissionFixed != null) commFixed = Number(cfgData.commissionFixed);
    if (commFixed == null || !(commFixed >= 0)) commFixed = 0.30;

    // Flat amounts (fixed fee, $2 monthly fee) only make sense in currencies of a
    // similar scale. We apply them for the launch currencies (USD/CAD/EUR/GBP);
    // exotic-value currencies get the percentage only until we add per-currency
    // amounts. This keeps a "2"-sized flat fee from being nonsense elsewhere.
    const MAJOR_CUR = ['usd', 'cad', 'eur', 'gbp'];
    const isMajor = MAJOR_CUR.includes(cur);
    if (!isMajor) commFixed = 0;

    const commission = Math.round(tip * commPct / 100) + Math.round(commFixed * 100);  // cents; platform keeps this
    const total = tip + commission;                                                     // customer pays this

    const stfSnap = await adminDb.collection('businesses').doc(businessId).collection('staff').doc(staffId).get();
    if (!stfSnap.exists) return res.status(404).json({ error: 'staff-not-found' });
    const staff = stfSnap.data();
    // SECURITY: the worker's Connect account is looked up server-side from their
    // staff record — never trust an account id sent by the browser.
    const workerAcct = staff.connectAccountId;

    // Is the worker ready to RECEIVE money directly? For a destination charge the
    // recipient needs the `transfers` capability active (they only receive — they
    // are not a card-processing merchant, so charges_enabled may be false).
    let ready = false;
    if (workerAcct) {
      try {
        const acct = await stripe.accounts.retrieve(workerAcct);
        const transfersActive = acct.capabilities && acct.capabilities.transfers === 'active';
        ready = !!(transfersActive || acct.payouts_enabled);
      } catch (_) { ready = false; }
    }

    if (ready) {
      // Direct destination charge (standard tipping-platform model). The platform
      // is the merchant of record; the worker only needs the `transfers`
      // capability (which they have) to RECEIVE.
      //   transfer_data.amount = tip  → the worker gets EXACTLY the tip ($50),
      //   shown as one clean transfer. The platform keeps the remainder (the
      //   commission), out of which Stripe's processing fee is taken.
      // We set transfer_data.amount explicitly (instead of application_fee_amount)
      // so the worker's account shows a clean $50 — not "$53.50 minus a fee".
      // (No on_behalf_of — that would require the worker to have `card_payments`.)

      // --- Monthly active-account fee ($2) ---------------------------------
      // Fair, VOLUME-based: taken at most once per 30 days, and only once the
      // worker has EARNED more than $20 in tips in the last 30 days (this tip
      // included). Only deducted from a tip >= $3 so the worker still nets from
      // it — if the tip that crosses $20 is smaller, we wait for the next tip
      // >= $3 in the cycle. Deducted from the worker's transfer; the customer's
      // total is unchanged.
      const FEE_CENTS = 200;            // $2 monthly fee
      const FEE_MIN_EARNED = 2000;      // only after > $20 earned in the cycle
      const FEE_MIN_TIP = 300;          // only deduct from a tip >= $3
      let monthlyFeeCents = 0;
      try {
        const now = Date.now();
        const WINDOW = 30 * 24 * 60 * 60 * 1000;
        const lastMs = staff.lastFeeTakenAt ? Date.parse(staff.lastFeeTakenAt) : 0;
        const feeRecently = lastMs && (now - lastMs) < WINDOW;   // already charged this cycle
        if (isMajor && !feeRecently && tip >= FEE_MIN_TIP) {
          const winStart = now - WINDOW;
          const tipsSnap = await adminDb.collection('businesses').doc(businessId).collection('tips').where('staffId', '==', staffId).get();
          let earnedCents = tip;   // include the tip being paid now
          tipsSnap.forEach(d => { const x = d.data(); const ms = (x.createdAt && x.createdAt.toMillis) ? x.createdAt.toMillis() : 0; if (ms >= winStart) earnedCents += Math.round(Number(x.tip || 0) * 100); });
          if (earnedCents > FEE_MIN_EARNED) {   // earned more than $20 this cycle
            monthlyFeeCents = FEE_CENTS;
            // Mark now (optimistic) so a second tip can't double-charge the cycle.
            try { await stfSnap.ref.update({ lastFeeTakenAt: new Date().toISOString() }); } catch (_) {}
          }
        }
      } catch (_) {}
      const workerTransfer = tip - monthlyFeeCents;

      const pi = await stripe.paymentIntents.create({
        amount: total,
        currency: cur,
        payment_method_types: ['card'],
        transfer_data: { destination: workerAcct, amount: workerTransfer },
        metadata: { businessId, staffId, tip: String(tip), commission: String(commission), commissionPercent: String(commPct), commissionFixed: String(commFixed), monthlyFee: String(monthlyFeeCents), held: '0' },
      });
      return res.json({
        clientSecret: pi.client_secret,
        publishableKey: STRIPE_PUBLISHABLE_KEY,
        breakdown: { tip, commission, total, currency: cur, commissionPercent: commPct, commissionFixed: commFixed, monthlyFee: monthlyFeeCents },
        held: false,
      });
    }

    // Worker not ready yet → accept the tip, but hold the worker's share safely
    // (recorded against their staff id) until they finish connecting, then it's
    // released to them. The platform still keeps its commission. Money is only
    // ever held for a not-yet-ready worker — never siphoned.
    const pi = await stripe.paymentIntents.create({
      amount: total,
      currency: cur,
      payment_method_types: ['card'],
      metadata: { businessId, staffId, tip: String(tip), commission: String(commission), commissionPercent: String(commPct), commissionFixed: String(commFixed), held: '1' },
    });
    return res.json({
      clientSecret: pi.client_secret,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      breakdown: { tip, commission, total, currency: cur, commissionPercent: commPct, commissionFixed: commFixed },
      held: true,
    });
  } catch (error) {
    console.error('create-payment-intent', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Lightweight config for the customer tip page (mode-correct publishable key).
app.get('/stripe-config', (req, res) => {
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY });
});

// Admin alert email for a large tip (shown when a single tip total >= threshold)
function adminBigTipHtml(shopName, who, cur, amt, fromName) {
  const shop = shopName ? escapeHtml(shopName) : 'a shop';
  const to = who ? escapeHtml(who) : 'the team';
  const from = fromName ? escapeHtml(fromName) : 'A customer';
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Large tip received 💸</div>
    <div style="font-size:34px;font-weight:800;color:#0071e3;margin:14px 0 6px;">${escapeHtml(cur)} ${escapeHtml(amt)}</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:8px 0 0;">${from} tipped <b>${to}</b> at <b>${shop}</b>.</p>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:18px 0 0;">Automatic alert for tips at or above the alert threshold.</p>
  </div>`);
}

// Send an email to staff when they receive a tip (via Brevo). Also alerts the
// admin when the whole tip is large (>= ADMIN_TIP_ALERT, default 30).
app.post('/notify-tip', async (req, res) => {
  try {
    const { recipients, amount, currency, shopName, fromName, tipTotal } = req.body;
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (!apiKey) return res.json({ sent: 0, note: 'BREVO_API_KEY not set' });
    const list = (recipients || []).filter(r => r && r.email);
    const amt = Number(amount || 0).toFixed(2);
    const cur = (currency || '').toUpperCase();
    let sent = 0;
    for (const r of list) {
      const payload = {
        sender: { name: senderName, email: senderEmail },
        // name must be omitted (undefined) when empty — Brevo rejects an empty string.
        to: [{ email: r.email, name: r.name || undefined }],
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

    // Admin large-tip alert.
    const threshold = Number(process.env.ADMIN_TIP_ALERT || 30);
    const total = Number(tipTotal != null ? tipTotal : amount || 0);
    const adminEmail = process.env.ADMIN_EMAIL || 'amidifysolutions@gmail.com';
    if (total >= threshold && adminEmail) {
      const who = (list[0] && list[0].name) || (recipients && recipients[0] && recipients[0].name) || '';
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({
            sender: { name: senderName, email: senderEmail },
            to: [{ email: adminEmail }],
            subject: `💸 Large tip: ${cur} ${total.toFixed(2)}${shopName ? ' at ' + shopName : ''}`,
            htmlContent: adminBigTipHtml(shopName, who, cur, total.toFixed(2), fromName)
          })
        });
      } catch (e) { console.error('admin alert send error', e.message); }
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
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (!apiKey) return res.json({ sent: 0, note: 'BREVO_API_KEY not set' });
    if (!email) return res.json({ sent: 0, note: 'no email' });
    const payload = {
      sender: { name: senderName, email: senderEmail },
      to: [{ email, name: name || undefined }],
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

// Owner invites a staff member: create their Firebase account with a TEMPORARY
// password (or link an existing account), then email them their login details.
// The worker never types their name/email — the owner already did. Verified
// against the owner's ID token (uid must equal the business id).
app.post('/staff/invite', async (req, res) => {
  try {
    const { idToken, bid, staffId, email, name, shopName, shopCode, staffLink } = req.body;
    if (!idToken || !bid || !staffId || !email) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (decoded.uid !== bid) return res.status(403).json({ error: 'not-your-business' });
    const addr = String(email).toLowerCase();
    let uid = null, created = false, tempPass = null;
    try { const u = await adminAuth.getUserByEmail(addr); uid = u.uid; } catch (_) { /* no account yet */ }
    if (!uid) {
      tempPass = require('crypto').randomBytes(4).toString('hex'); // 8 hex chars, e.g. f8b6d3a6
      const u = await adminAuth.createUser({ email: addr, password: tempPass, emailVerified: false, displayName: name || undefined });
      uid = u.uid; created = true;
    }
    // Link the staff record to this account; flag first-login only when WE created it.
    const ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
    await ref.set({ claimedUid: uid, email: addr, mustChangePassword: created, invitedAt: new Date().toISOString() }, { merge: true });
    // Deliver the email (credentials for new workers, a heads-up for existing ones).
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    let sent = 0;
    if (apiKey) {
      const html = created
        ? inviteCredsHtml(name, shopName, addr, tempPass, shopCode, staffLink)
        : addedToShopHtml(name, shopName, shopCode, staffLink);
      const subject = created
        ? `Your ${shopName || 'EasyTipMe'} login`
        : `You've been added to ${shopName || 'a workplace'} on EasyTipMe`;
      try {
        const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: addr, name: name || undefined }], subject, htmlContent: html })
        });
        sent = resp.ok ? 1 : 0;
      } catch (e) { console.error('invite email', e.message); }
    }
    res.json({ created, sent });
  } catch (e) { console.error('staff invite', e.message); res.status(500).json({ error: e.message }); }
});

// Worker finished the forced first-login password change — clear the flag.
app.post('/staff/activate', async (req, res) => {
  try {
    const { idToken, bid, staffId } = req.body;
    if (!idToken || !bid || !staffId) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'staff-not-found' });
    if (snap.data().claimedUid !== decoded.uid) return res.status(403).json({ error: 'not-your-record' });
    await ref.update({ mustChangePassword: false, passwordSetAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { console.error('staff activate', e.message); res.status(500).json({ error: e.message }); }
});

// Owner FULLY deletes a staff member: removes the Firestore record AND the
// worker's Firebase login account — but ONLY if that account isn't the owner's
// own account and isn't linked to another workplace. Verified against the
// owner's ID token (uid must equal the business id).
app.post('/staff/delete', async (req, res) => {
  try {
    const { idToken, bid, staffId } = req.body;
    if (!idToken || !bid || !staffId) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (decoded.uid !== bid) return res.status(403).json({ error: 'not-your-business' });
    const ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
    const snap = await ref.get();
    const claimedUid = snap.exists ? (snap.data().claimedUid || null) : null;
    // 1) remove the staff record for this shop
    await ref.delete();
    // 2) decide whether the login account can be fully removed
    let authDeleted = false;
    if (claimedUid && claimedUid !== bid) {
      let usedElsewhere = false;
      try {
        // any OTHER staff doc (in any shop) still linked to this account?
        const others = await adminDb.collectionGroup('staff').where('claimedUid', '==', claimedUid).limit(1).get();
        usedElsewhere = !others.empty; // we already deleted this shop's doc, so any match = another workplace
      } catch (_) { usedElsewhere = false; } // no index/err → current single-workplace model, safe to remove
      // never delete an account that is itself a business owner
      let isOwner = false;
      try { const b = await adminDb.collection('businesses').doc(claimedUid).get(); isOwner = b.exists; } catch (_) {}
      if (!usedElsewhere && !isOwner) {
        try { await adminAuth.deleteUser(claimedUid); authDeleted = true; } catch (e) { console.error('deleteUser', e.message); }
        try { await adminDb.collection('emailCodes').doc(claimedUid).delete(); } catch (_) {}
      }
    }
    res.json({ ok: true, authDeleted });
  } catch (e) { console.error('staff delete', e.message); res.status(500).json({ error: e.message }); }
});

// Business owner changes their own login email. Their Stripe payout account is
// linked by account id (not email), so the connection stays intact. Verified
// against the owner's ID token (uid must equal the business id).
app.post('/owner/change-email', async (req, res) => {
  try {
    const { idToken, bid, newEmail } = req.body;
    if (!idToken || !bid || !newEmail) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (decoded.uid !== bid) return res.status(403).json({ error: 'not-your-business' });
    const addr = String(newEmail).toLowerCase();
    const oldEmail = String(decoded.email || '').toLowerCase();
    try {
      await adminAuth.updateUser(bid, { email: addr, emailVerified: false });
    } catch (e) {
      if (/already-exists|email-already/i.test(e.message || e.code || '')) return res.status(409).json({ error: 'email-in-use' });
      throw e;
    }
    try { await adminDb.collection('businesses').doc(bid).update({ email: addr }); } catch (_) {}
    // Security notifications to BOTH the old and new address.
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (apiKey) {
      const send = (to, toOld) => fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: to }], subject: 'Your EasyTipMe email was changed', htmlContent: emailChangedHtml(addr, toOld) })
      }).catch(() => {});
      if (oldEmail && oldEmail !== addr) await send(oldEmail, true);
      await send(addr, false);
    }
    res.json({ ok: true });
  } catch (e) { console.error('owner change-email', e.message); res.status(500).json({ error: e.message }); }
});

// ---- Our own email verification via a 6-digit code (Brevo) ----
// Bypasses Firebase's generateEmailVerificationLink, which gets rate-limited
// (TOO_MANY_ATTEMPTS) under heavy use. We store the code, email it via Brevo,
// and on match set emailVerified=true ourselves (updateUser is not throttled).
function emailCodeHtml(name, code) {
  const who = escapeHtml(name || 'there');
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Confirm your email</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 10px;">Hi ${who}, enter this code in the app to confirm your email:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0071e3;background:#f2f7ff;border-radius:14px;padding:16px 0;margin:0 0 10px;">${escapeHtml(code)}</div>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:10px 0 0;">This code expires in 15 minutes. If you didn't request it, you can ignore this email.</p>
  </div>`);
}
app.post('/send-code', async (req, res) => {
  try {
    const { idToken, name } = req.body;
    if (!idToken) return res.status(400).json({ sent: 0, error: 'missing idToken' });
    if (!adminAuth || !adminDb) return res.json({ sent: 0, error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const addr = String(decoded.email || '').toLowerCase();
    if (!addr) return res.json({ sent: 0, error: 'no-email' });
    const ref = adminDb.collection('emailCodes').doc(uid);
    const now = Date.now();
    const cur = await ref.get();
    if (cur.exists && cur.data().lastSentMs && (now - cur.data().lastSentMs) < 25000) {
      return res.json({ sent: 0, error: 'slow-down' });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await ref.set({ code, email: addr, expMs: now + 15 * 60000, tries: 0, lastSentMs: now });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    let sent = 0;
    if (apiKey) {
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: addr, name: name || undefined }], subject: 'Your EasyTipMe confirmation code', htmlContent: emailCodeHtml(name, code) })
      });
      sent = resp.ok ? 1 : 0;
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        console.error('send-code brevo failed', resp.status, detail);
        return res.json({ sent: 0, error: 'send-failed', status: resp.status, detail: String(detail).slice(0, 300) });
      }
    } else {
      return res.json({ sent: 0, error: 'no-brevo-key' });
    }
    res.json({ sent });
  } catch (e) { console.error('send-code', e.message); res.json({ sent: 0, error: e.message }); }
});
app.post('/verify-code', async (req, res) => {
  try {
    const { idToken, code } = req.body;
    if (!idToken || !code) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const ref = adminDb.collection('emailCodes').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'no-code' });
    const d = snap.data();
    if (Date.now() > d.expMs) { await ref.delete(); return res.status(400).json({ error: 'expired' }); }
    if ((d.tries || 0) >= 5) return res.status(429).json({ error: 'too-many' });
    if (String(code).trim() !== String(d.code)) { await ref.update({ tries: (d.tries || 0) + 1 }); return res.status(400).json({ error: 'wrong-code' }); }
    await adminAuth.updateUser(uid, { emailVerified: true });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { console.error('verify-code', e.message); res.status(500).json({ error: e.message }); }
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
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
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
      to: [{ email: addr, name: name || undefined }],
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

function resetEmailHtml(name, link) {
  const who = escapeHtml(name || 'there');
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Reset your password</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 6px;">Hi ${who}, we received a request to reset your EasyTipMe password. Tap below to choose a new one.</p>
    <a href="${link}" style="display:inline-block;margin-top:12px;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:12px;">Reset my password</a>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:20px 0 0;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
  </div>`);
}

// Generate a Firebase password-reset link and deliver it via Brevo (branded, not spammy)
app.post('/send-reset', async (req, res) => {
  try {
    const { email, name, continueUrl } = req.body;
    if (!email) return res.json({ sent: 0, note: 'no email' });
    if (!adminAuth) return res.json({ sent: 0, note: 'admin-not-configured' });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (!apiKey) return res.json({ sent: 0, note: 'BREVO_API_KEY not set' });
    const addr = String(email).toLowerCase();
    let link;
    try {
      link = await adminAuth.generatePasswordResetLink(addr, continueUrl ? { url: continueUrl } : undefined);
    } catch (e) {
      link = await adminAuth.generatePasswordResetLink(addr);
    }
    const payload = {
      sender: { name: senderName, email: senderEmail },
      to: [{ email: addr, name: name || undefined }],
      subject: 'Reset your EasyTipMe password',
      htmlContent: resetEmailHtml(name, link)
    };
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.json({ sent: resp.ok ? 1 : 0 });
  } catch (error) {
    console.error('send-reset error', error.message);
    return res.json({ sent: 0, error: error.message });
  }
});

// ---- Stripe Connect (staff payouts) — onboarding scaffolding ----
// Creates an Express connected account for a staff member and returns a Stripe
// onboarding link so they can add their bank details. Money movement
// (transfers/instant payouts + tiered fees) is intentionally NOT enabled here
// yet — that is added AFTER Connect is enabled in the dashboard and tested.
const adminDb = adminAuth ? require('firebase-admin').firestore() : null;

app.post('/connect/create-account', async (req, res) => {
  try {
    const { bid, staffId, email, country, firstName, lastName, phone } = req.body;
    if (!bid || !staffId) return res.status(400).json({ error: 'missing bid/staffId' });
    let accountId = null, ref = null;
    if (adminDb) {
      ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
      const snap = await ref.get();
      accountId = snap.exists && snap.data().connectAccountId;
    }
    if (!accountId) {
      // Pre-fill what we know so the staff member skips the business/industry questions —
      // they're an individual receiving tips, not a merchant setting up a store.
      const individual = {};
      if (email) individual.email = email;
      if (firstName) individual.first_name = String(firstName).slice(0, 40);
      if (lastName) individual.last_name = String(lastName).slice(0, 40);
      let ph = String(phone || '').replace(/[^\d+]/g, '');
      if (ph && !ph.startsWith('+')) { ph = ph.length === 10 ? '+1' + ph : ''; }
      if (ph) individual.phone = ph;
      const acct = await connectStripe.accounts.create({
        type: 'express',
        country: (country || 'CA'),
        email: email || undefined,
        business_type: 'individual',
        // Pre-set the category & description so Stripe doesn't ask the worker "select your industry".
        business_profile: { mcc: '7299', url: 'https://www.easytipme.com', product_description: 'Tips and gratuities received through EasyTipMe.' },
        individual: Object.keys(individual).length ? individual : undefined,
        capabilities: { transfers: { requested: true } },
        metadata: { bid, staffId }
      });
      accountId = acct.id;
      if (ref) await ref.set({ connectAccountId: accountId, connectStatus: 'created', connectAt: new Date().toISOString() }, { merge: true });
    }
    res.json({ accountId });
  } catch (e) { console.error('connect create', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/connect/onboarding-link', async (req, res) => {
  try {
    const { accountId, returnUrl } = req.body;
    if (!accountId) return res.status(400).json({ error: 'missing accountId' });
    const base = returnUrl || (APP_URL + '/staff.html');
    const sep = base.includes('?') ? '&' : '?';
    const link = await connectStripe.accountLinks.create({
      account: accountId,
      refresh_url: base + sep + 'connect=refresh',
      return_url: base + sep + 'connect=done',
      type: 'account_onboarding'
    });
    res.json({ url: link.url });
  } catch (e) { console.error('connect link', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/connect/status', async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.json({ connected: false });
    const acct = await connectStripe.accounts.retrieve(accountId);
    res.json({
      connected: !!acct.payouts_enabled,
      details_submitted: !!acct.details_submitted,
      payouts_enabled: !!acct.payouts_enabled,
      charges_enabled: !!acct.charges_enabled
    });
  } catch (e) { console.error('connect status', e.message); res.json({ connected: false, error: e.message }); }
});

// Real Stripe balance + recent payouts for a connected account.
// Stripe is the single source of truth for money — the dashboards show THESE
// numbers, never our own tallies, so a worker never sees two different amounts.
app.post('/connect/balance', async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'missing accountId' });
    const hdr = { stripeAccount: accountId };
    const bal = await connectStripe.balance.retrieve(hdr);
    const sum = (arr) => (arr || []).reduce((t, b) => t + (b.amount || 0), 0);
    const pick = (arr) => {
      // group by currency; return the largest bucket's currency as the primary
      const m = {}; (arr || []).forEach(b => { m[b.currency] = (m[b.currency] || 0) + b.amount; });
      const cur = Object.keys(m).sort((a, c) => m[c] - m[a])[0] || 'cad';
      return cur;
    };
    const currency = pick(bal.available.length ? bal.available : bal.pending) || 'cad';
    const avail = sum(bal.available.filter(b => b.currency === currency));
    const pend = sum(bal.pending.filter(b => b.currency === currency));
    const instant = sum((bal.instant_available || []).filter(b => b.currency === currency));
    let payouts = [];
    try {
      const pl = await connectStripe.payouts.list({ limit: 8 }, hdr);
      payouts = pl.data.map(p => ({
        amount: p.amount / 100, currency: p.currency, status: p.status,
        method: p.method, arrival_date: p.arrival_date, created: p.created,
        auto: p.automatic === true
      }));
    } catch (_) {}
    res.json({
      currency,
      available: avail / 100,
      pending: pend / 100,
      instantAvailable: instant / 100,
      payouts
    });
  } catch (e) { console.error('connect balance', e.message); res.status(500).json({ error: e.message }); }
});

// Release tips that were held while a worker hadn't finished connecting their
// bank. Called by the worker's app once their Connect account is ready. Finds
// every held+unreleased tip recorded against this worker and transfers the
// worker's share to their account, then marks it released. Idempotent per tip.
app.post('/staff/release-held', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'missing idToken' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;

    // Every staff record this worker owns (invited workers are linked by claimedUid).
    const staffDocs = [];
    try {
      const g = await adminDb.collectionGroup('staff').where('claimedUid', '==', uid).get();
      g.forEach(d => staffDocs.push(d));
    } catch (e) { console.error('release-held staff lookup', e.message); }

    let released = 0, totalCents = 0, currency = null;
    for (const sd of staffDocs) {
      const staff = sd.data();
      const acctId = staff.connectAccountId;
      if (!acctId) continue;
      // Must actually be able to receive (transfers capability) before we move money.
      let ok = false;
      try { const a = await stripe.accounts.retrieve(acctId); ok = !!((a.capabilities && a.capabilities.transfers === 'active') || a.payouts_enabled); } catch (_) { ok = false; }
      if (!ok) continue;
      const bizRef = sd.ref.parent.parent;   // businesses/{bid}
      if (!bizRef) continue;
      const staffId = sd.id;
      // Held tips for this worker (single-field query → no composite index needed).
      let tipsSnap;
      try { tipsSnap = await bizRef.collection('tips').where('staffId', '==', staffId).get(); }
      catch (e) { console.error('release-held tips query', e.message); continue; }
      for (const t of tipsSnap.docs) {
        const td = t.data();
        if (td.held !== true || td.released === true) continue;
        const owed = Math.round(Number(td.staffShare != null ? td.staffShare : td.tip) * 100);
        const cur = (td.currency || 'cad').toLowerCase();
        if (!(owed > 0)) { await t.ref.update({ released: true, releasedAt: new Date().toISOString(), releaseNote: 'zero-amount' }); continue; }
        try {
          const tr = await stripe.transfers.create({
            amount: owed, currency: cur, destination: acctId,
            metadata: { kind: 'held-release', businessId: bizRef.id, staffId, tipId: t.id }
          }, { idempotencyKey: 'release_' + t.id });
          await t.ref.update({ released: true, releasedAt: new Date().toISOString(), transferId: tr.id });
          released++; totalCents += owed; currency = cur;
        } catch (e) {
          // Leave released:false so it retries next time (e.g. balance not yet available).
          console.error('release transfer failed', t.id, e.message);
        }
      }
    }
    res.json({ ok: true, released, amount: totalCents / 100, currency });
  } catch (e) { console.error('release-held', e.message); res.status(500).json({ error: e.message }); }
});

// Owner (business) connects THEIR OWN payout account — destination for their
// admin fee (and, in the collect model, the whole pool). Verified against the
// owner's ID token (uid must equal the business id).
app.post('/connect/create-owner-account', async (req, res) => {
  try {
    const { idToken, bid, email, country } = req.body;
    if (!idToken || !bid) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (decoded.uid !== bid) return res.status(403).json({ error: 'not-your-business' });
    const ref = adminDb.collection('businesses').doc(bid);
    const snap = await ref.get();
    let accountId = snap.exists && snap.data().ownerConnectAccountId;
    if (!accountId) {
      const acct = await connectStripe.accounts.create({
        type: 'express',
        country: (country || 'CA'),
        email: email || decoded.email || undefined,
        business_profile: { mcc: '7299', url: 'https://www.easytipme.com', product_description: 'Tips and administrative fees collected through EasyTipMe.' },
        capabilities: { transfers: { requested: true } },
        metadata: { bid, role: 'owner' }
      });
      accountId = acct.id;
      await ref.set({ ownerConnectAccountId: accountId, ownerConnectStatus: 'created', ownerConnectAt: new Date().toISOString() }, { merge: true });
    }
    res.json({ accountId });
  } catch (e) { console.error('connect owner create', e.message); res.status(500).json({ error: e.message }); }
});

function emailChangedHtml(newEmail, toOld) {
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Your email was ${toOld ? 'changed' : 'updated'}</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 8px;">The email on your EasyTipMe account was ${toOld ? 'changed to' : 'set to'} <b>${escapeHtml(newEmail)}</b>.</p>
    ${toOld
      ? `<p style="font-size:13.5px;color:#b23b3b;line-height:1.6;">If you didn't make this change, contact your workplace right away — someone may have access to your account.</p>`
      : `<p style="font-size:13.5px;color:#6e6e73;line-height:1.6;">You can now sign in with this email. If this wasn't you, contact your workplace.</p>`}
  </div>`);
}

// Staff self-service email change: the client changes the Firebase Auth email
// (after re-auth), then calls this to sync the staff record. We verify the
// caller's ID token and that they own the record (claimedUid) before updating.
app.post('/staff/change-email', async (req, res) => {
  try {
    const { idToken, bid, staffId, newEmail } = req.body;
    if (!idToken || !bid || !staffId || !newEmail) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'staff-not-found' });
    if (snap.data().claimedUid !== uid) return res.status(403).json({ error: 'not-your-record' });
    const addr = String(newEmail).toLowerCase();
    try {
      await adminAuth.updateUser(uid, { email: addr, emailVerified: false });
    } catch (e) {
      if (/already-exists|email-already/i.test(e.message || e.code || '')) return res.status(409).json({ error: 'email-in-use' });
      throw e;
    }
    const oldEmail = String(snap.data().email || decoded.email || '').toLowerCase();
    await ref.update({ email: addr });
    // Security notification to BOTH the old and new address that the email changed.
    try {
      const apiKey = process.env.BREVO_API_KEY;
      const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
      const senderName = process.env.SENDER_NAME || 'EasyTipMe';
      if (apiKey) {
        const send = (to, subject, html) => fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: to }], subject, htmlContent: html })
        }).catch(() => {});
        if (oldEmail && oldEmail !== addr) await send(oldEmail, 'Your EasyTipMe email was changed', emailChangedHtml(addr, true));
        await send(addr, 'Your EasyTipMe email was updated', emailChangedHtml(addr, false));
      }
    } catch (_) {}
    return res.json({ ok: 1 });
  } catch (e) { console.error('change-email', e.message); return res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
