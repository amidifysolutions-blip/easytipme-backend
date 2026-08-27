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

    // ---- Legacy fallback ----------------------------------------------------
    // Only when we truly can't route: no business, no amount, and NEITHER a
    // single recipient (staffId) NOR an explicit multi-select list (poolStaffIds).
    // A manual multi-select sends businessId + tipCents + poolStaffIds (no single
    // staffId) and must fall through to the split logic below — NOT here.
    const splitIds = Array.isArray(req.body.poolStaffIds) ? req.body.poolStaffIds.filter(x => typeof x === 'string' && x) : [];
    if (!businessId || !tipCents || (!staffId && splitIds.length === 0)) {
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

    // The owner's administrative fee is a PRO feature. Honor it only when BOTH
    // (a) the owner turned it on (tipShareEnabled) AND (b) the owning account —
    // the head office for a branch — is actually on a paid plan right now. This
    // backend gate protects against a stale tipShareEnabled flag after Pro lapses.
    let ownerPro = false;
    try {
      let od = biz;
      if (biz.orgOwnerUid) { const os = await adminDb.collection('businesses').doc(biz.orgOwnerUid).get(); od = os.exists ? os.data() : {}; }
      ownerPro = od.proActive === true || od.businessTierActive === true || od.businessProActive === true || od.ownerAnalyticsEnabled === true;
    } catch (_) {}

    // Station 1: platform commission — a % of the tip PLUS a small fixed fee,
    // both ADDED ON TOP of the tip. The fixed part covers Stripe's fixed
    // per-transaction cost (~$0.30) so even small tips stay profitable
    // (industry standard, e.g. TackPay charges "5% + £0.25").
    // Priority for each value: per-shop → global default (config/platform) → fallback.
    let cfgData = {};
    try { const cfg = await adminDb.collection('config').doc('platform').get(); if (cfg.exists) cfgData = cfg.data() || {}; } catch (_) {}

    // Minimum / maximum tip. Both live in config/platform and are enforced HERE,
    // server-side, so the limit holds no matter what the browser sends. A tip
    // below the minimum can cost more in Stripe fees than the commission earns
    // (especially in currencies that get no fixed fee — see MAJOR_CUR below).
    // The minimum is per CURRENCY: "3" means $3 in CAD/USD, but 3 AED is under a
    // dollar and still loses money after Stripe's fixed fee. Currencies without
    // our fixed fee (see MAJOR_CUR below) therefore need a higher floor. Set
    // config/platform.minTipByCurrency = { aed: 12, sar: 12, ... } to override.
    const curKey = String(cur || '').toLowerCase();
    const minByCur = (cfgData.minTipByCurrency && typeof cfgData.minTipByCurrency === 'object') ? cfgData.minTipByCurrency : {};
    const MINOR_CUR_DEFAULT = { aed: 12, sar: 12, qar: 12, lbp: 300000, egp: 150 };
    let minTipUnits;
    if (minByCur[curKey] != null && !isNaN(Number(minByCur[curKey]))) minTipUnits = Number(minByCur[curKey]);
    else if (MINOR_CUR_DEFAULT[curKey] != null) minTipUnits = MINOR_CUR_DEFAULT[curKey];
    else minTipUnits = (cfgData.minTip != null && !isNaN(Number(cfgData.minTip))) ? Number(cfgData.minTip) : 1;
    const maxTipUnits = (cfgData.maxTip != null && !isNaN(Number(cfgData.maxTip))) ? Number(cfgData.maxTip) : 1000;
    if (tip < Math.round(minTipUnits * 100)) return res.status(400).json({ error: 'tip-too-small', minTip: minTipUnits });
    if (tip > Math.round(maxTipUnits * 100)) return res.status(400).json({ error: 'tip-too-large', maxTip: maxTipUnits });

    // Floor: a per-shop rate may be raised for a shop, but never dropped below the
    // platform minimum (default 10%), so no shop can be configured into a loss —
    // whether by mistake in the admin panel or by a stale/legacy shop record.
    let MIN_COMM_PCT = 10;
    if (cfgData.minCommissionPercent != null && !isNaN(Number(cfgData.minCommissionPercent))) MIN_COMM_PCT = Number(cfgData.minCommissionPercent);

    let commPct = null;
    if (biz.commissionPercent != null && !isNaN(Number(biz.commissionPercent))) commPct = Number(biz.commissionPercent);
    else if (cfgData.commissionPercent != null) commPct = Number(cfgData.commissionPercent);
    if (commPct == null || !(commPct >= 0)) commPct = MIN_COMM_PCT;
    if (commPct < MIN_COMM_PCT) commPct = MIN_COMM_PCT;

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

    // ---- Tip POOL: the owner splits every tip EQUALLY among the on-shift team ----
    // Owner-set workplace policy. We take a plain charge here (platform is merchant
    // of record) and split it among the on-shift, payout-ready workers AFTER the
    // charge succeeds via /settle-pool (Stripe transfers on the SAME charge) — the
    // money is divided at source, never moved between workers' settled balances.
    const poolIds = Array.isArray(req.body.poolStaffIds) ? req.body.poolStaffIds.filter(x => typeof x === 'string' && x).slice(0, 50) : [];
    // Split the tip equally when EITHER the owner's auto Tip-Pool is on (single
    // pick, pool=true) OR the customer manually multi-selected the team
    // (split=true). Both settle via /settle-pool on the same charge.
    if (poolIds.length && (req.body.split === true || (biz.tipPoolEnabled === true && req.body.pool === true))) {
      let ownerShare = 0;
      if (biz.tipShareEnabled === true && ownerPro) { const sp = Math.min(15, Math.max(0, Number(biz.tipSharePercent) || 0)); ownerShare = Math.round(tip * sp / 100); }
      const pi = await stripe.paymentIntents.create({
        amount: total,
        currency: cur,
        payment_method_types: ['card'],
        metadata: { businessId, staffId: staffId || '', tip: String(tip), commission: String(commission), commissionPercent: String(commPct), commissionFixed: String(commFixed), ownerShare: String(ownerShare), pool: '1', poolStaffIds: poolIds.join(',') },
      });
      return res.json({
        clientSecret: pi.client_secret,
        publishableKey: STRIPE_PUBLISHABLE_KEY,
        breakdown: { tip, commission, total, currency: cur, commissionPercent: commPct, commissionFixed: commFixed, ownerShare, pool: true },
        held: false, pool: true,
      });
    }

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
        // Honor the worker's REAL Pro status (source of truth = workers/{uid}), not
        // just this shop's staff-record mirror, so a Pro worker is always waived.
        let workerIsPro = staff.workerProActive === true;
        if (!workerIsPro && staff.claimedUid) { try { const w = await adminDb.collection('workers').doc(staff.claimedUid).get(); if (w.exists && w.data().workerProActive === true) workerIsPro = true; } catch (_) {} }
        if (isMajor && !feeRecently && tip >= FEE_MIN_TIP && !workerIsPro) {
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
      // --- Station 2: owner's administrative fee -----------------------------
      // A % of the tip the BUSINESS retains (set in the dashboard, gated behind
      // Pro). It is deducted from the worker's share here and routed to the
      // owner's connected account after the charge succeeds (/settle-owner-fee).
      // When the fee is off (the default), ownerShare is 0 and nothing changes.
      let ownerShare = 0;
      if (biz.tipShareEnabled === true && ownerPro) {
        const sp = Math.min(15, Math.max(0, Number(biz.tipSharePercent) || 0));
        ownerShare = Math.round(tip * sp / 100);
      }
      const workerTransfer = tip - ownerShare - monthlyFeeCents;

      const pi = await stripe.paymentIntents.create({
        amount: total,
        currency: cur,
        payment_method_types: ['card'],
        transfer_data: { destination: workerAcct, amount: workerTransfer },
        metadata: { businessId, staffId, tip: String(tip), commission: String(commission), commissionPercent: String(commPct), commissionFixed: String(commFixed), monthlyFee: String(monthlyFeeCents), ownerShare: String(ownerShare), held: '0' },
      });
      return res.json({
        clientSecret: pi.client_secret,
        publishableKey: STRIPE_PUBLISHABLE_KEY,
        breakdown: { tip, commission, total, currency: cur, commissionPercent: commPct, commissionFixed: commFixed, monthlyFee: monthlyFeeCents, ownerShare },
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

// ---- Pro subscriptions (Stripe Billing) — Phase 1 foundation ----------------
// Owner Pro ($19.99/mo) and Worker Pro ($4.99/mo). Prices are created lazily on
// first use and cached in config/billing (per test/live mode) so there is no
// manual Stripe setup. The subscription is a normal platform charge (the owner/
// worker pays EasyTipMe) — separate from the Connect tip flow.
const STRIPE_IS_LIVE = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live');
const PLAN_INFO = {
  owner:       { keyBase: 'ownerPrice',       amount: 1999, name: 'EasyTipMe Pro' },
  worker:      { keyBase: 'workerPrice',      amount: 499,  name: 'EasyTipMe Pro' },
  business:    { keyBase: 'businessPrice',    amount: 4999, name: 'EasyTipMe Business — up to 10 locations' },
  businesspro: { keyBase: 'businessProPrice', amount: 9999, name: 'EasyTipMe Business Pro — up to 25 locations' }
};
// Max branches allowed by the active multi-location plan.
const BRANCH_LIMITS = { business: 10, businesspro: 25 };
function branchLimitFor(b) {
  if (b && b.businessProActive === true) return BRANCH_LIMITS.businesspro;
  if (b && b.businessTierActive === true) return BRANCH_LIMITS.business;
  return 0;
}
async function getProPriceId(plan) {
  const info = PLAN_INFO[plan] || PLAN_INFO.owner;
  const ref = adminDb.collection('config').doc('billing');
  const snap = await ref.get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const key = info.keyBase + (STRIPE_IS_LIVE ? '_live' : '_test');
  if (data[key]) return data[key];
  const price = await stripe.prices.create({
    currency: 'usd',
    unit_amount: info.amount,
    recurring: { interval: 'month' },
    product_data: { name: info.name }
  });
  await ref.set({ [key]: price.id }, { merge: true });
  return price.id;
}

// Start a Pro subscription: returns a Stripe Checkout URL to redirect the user to.
app.post('/billing/create-checkout', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, plan, bid, staffId } = req.body;
    if (!idToken || !PLAN_INFO[plan]) return res.status(400).json({ error: 'bad-request' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const backTo = plan === 'worker' ? (APP_URL + '/staff.html') : (APP_URL + '/dashboard.html');
    const price = await getProPriceId(plan);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: decoded.email || undefined,
      metadata: { plan, uid: decoded.uid, bid: bid || '', staffId: staffId || '' },
      success_url: backTo + ((plan === 'business' || plan === 'businesspro') ? '?biz=success' : '?pro=success') + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: backTo + ((plan === 'business' || plan === 'businesspro') ? '?biz=cancel' : '?pro=cancel')
    });
    res.json({ url: session.url });
  } catch (e) { console.error('create-checkout', e.message); res.status(500).json({ error: e.message }); }
});

// Confirm a completed checkout (called after redirect) and flip the Pro flag.
app.post('/billing/confirm', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, sessionId } = req.body;
    if (!idToken || !sessionId) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session && (session.payment_status === 'paid' || session.status === 'complete');
    if (!paid) return res.json({ ok: false, active: false });
    const md = session.metadata || {};
    if (md.uid && md.uid !== decoded.uid) return res.status(403).json({ error: 'mismatch' });
    if (md.plan === 'owner' || md.plan === 'business' || md.plan === 'businesspro') {
      // The three owner-side plans are MUTUALLY EXCLUSIVE — only one active at a
      // time. Buying any of them cancels the other two subscriptions (no double
      // charge) and switches the active plan. Higher plans include lower ones.
      const ref = adminDb.collection('businesses').doc(decoded.uid);
      const cur = await ref.get();
      const cd = cur.exists ? (cur.data() || {}) : {};
      const newSub = session.subscription || '';
      const others = [];
      if (md.plan !== 'owner') others.push(cd.proSubId);
      if (md.plan !== 'business') others.push(cd.businessTierSubId);
      if (md.plan !== 'businesspro') others.push(cd.businessProSubId);
      for (const s of others) { if (s && s !== newSub) { try { await stripe.subscriptions.cancel(s); } catch (_) {} } }
      await ref.set({
        proActive: md.plan === 'owner',
        proSubId: md.plan === 'owner' ? newSub : '',
        businessTierActive: md.plan === 'business',
        businessTierSubId: md.plan === 'business' ? newSub : '',
        businessProActive: md.plan === 'businesspro',
        businessProSubId: md.plan === 'businesspro' ? newSub : '',
        planSince: new Date().toISOString()
      }, { merge: true });
    } else {
      // Worker Pro applies to the PERSON. Update the exact staff record from the
      // checkout metadata FIRST (robust — no collection-group index needed), then
      // best-effort tag any other records they've claimed. Cancel any previous
      // worker subscription so a repeat subscribe never double-bills.
      const newSub = session.subscription || '';
      const since = new Date().toISOString();
      const oldSubs = new Set();
      // SOURCE OF TRUTH: the worker's OWN account doc. This survives being removed
      // from any/all shops, so their Pro status — and the ability to cancel it —
      // is never orphaned when an owner deletes their staff record.
      try {
        const wref = adminDb.collection('workers').doc(decoded.uid);
        const w = await wref.get();
        const prev = w.exists ? (w.data().workerProSubId || '') : '';
        if (prev && prev !== newSub) oldSubs.add(prev);
        await wref.set({ workerProActive: true, workerProSince: since, workerProSubId: newSub }, { merge: true });
      } catch (e) { console.error('worker confirm workers-doc', e.message); }
      const tag = async (ref, data) => {
        if (data && data.workerProSubId && data.workerProSubId !== newSub) oldSubs.add(data.workerProSubId);
        await ref.set({ workerProActive: true, workerProSince: since, workerProSubId: newSub }, { merge: true });
      };
      if (md.bid && md.staffId) {
        try { const ref = adminDb.collection('businesses').doc(md.bid).collection('staff').doc(md.staffId); const s = await ref.get(); if (s.exists) await tag(ref, s.data()); } catch (e) { console.error('worker confirm direct', e.message); }
      }
      try {
        const g = await adminDb.collectionGroup('staff').where('claimedUid', '==', decoded.uid).get();
        for (const d of g.docs) { await tag(d.ref, d.data()); }
      } catch (e) { console.error('worker confirm cg', e.message); }
      for (const s of oldSubs) { try { await stripe.subscriptions.cancel(s); } catch (_) {} }
    }
    res.json({ ok: true, active: true });
  } catch (e) { console.error('billing confirm', e.message); res.status(500).json({ error: e.message }); }
});

// Cancel a Pro subscription (owner or worker) — the account owner cancels their own.
app.post('/billing/cancel', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, plan } = req.body;
    if (!idToken) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (plan === 'worker') {
      // SOURCE OF TRUTH: the worker's own account doc — always readable, no index,
      // and it survives removal from every shop, so they can ALWAYS cancel.
      const wref = adminDb.collection('workers').doc(decoded.uid);
      let subId = '';
      try { const w = await wref.get(); if (w.exists) subId = w.data().workerProSubId || ''; } catch (_) {}
      // Fallbacks for older subscribers whose sub id is only on a staff record.
      if (!subId) {
        const { bid, staffId } = req.body;
        const email = (decoded.email || '').toLowerCase();
        if (bid && staffId) {
          try { const s = await adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId).get(); if (s.exists && (s.data().claimedUid === decoded.uid || (s.data().email || '').toLowerCase() === email)) subId = s.data().workerProSubId || ''; } catch (_) {}
        }
        if (!subId) { const docs = await workerStaffDocs(decoded.uid); for (const d of docs) { if (!subId && d.data().workerProSubId) subId = d.data().workerProSubId; } }
      }
      if (subId) { try { await stripe.subscriptions.cancel(subId); } catch (_) {} }
      // Clear the flag on the worker's own doc, then best-effort on their staff records.
      try { await wref.set({ workerProActive: false, workerProCancelledAt: new Date().toISOString() }, { merge: true }); } catch (_) {}
      try { const docs = await workerStaffDocs(decoded.uid); if (docs.length) { const batch = adminDb.batch(); docs.forEach(d => batch.set(d.ref, { workerProActive: false, workerProCancelledAt: new Date().toISOString() }, { merge: true })); await batch.commit(); } } catch (_) {}
    } else if (plan === 'businesspro') {
      const ref = adminDb.collection('businesses').doc(decoded.uid);
      const snap = await ref.get();
      const subId = snap.exists ? snap.data().businessProSubId : '';
      if (subId) { try { await stripe.subscriptions.cancel(subId); } catch (_) {} }
      await ref.set({ businessProActive: false, businessProCancelledAt: new Date().toISOString() }, { merge: true });
    } else if (plan === 'business') {
      const ref = adminDb.collection('businesses').doc(decoded.uid);
      const snap = await ref.get();
      const subId = snap.exists ? snap.data().businessTierSubId : '';
      if (subId) { try { await stripe.subscriptions.cancel(subId); } catch (_) {} }
      await ref.set({ businessTierActive: false, businessTierCancelledAt: new Date().toISOString() }, { merge: true });
    } else {
      const ref = adminDb.collection('businesses').doc(decoded.uid);
      const snap = await ref.get();
      const subId = snap.exists ? snap.data().proSubId : '';
      if (subId) { try { await stripe.subscriptions.cancel(subId); } catch (_) {} }
      await ref.set({ proActive: false, proCancelledAt: new Date().toISOString() }, { merge: true });
    }
    res.json({ ok: true });
  } catch (e) { console.error('billing cancel', e.message); res.status(500).json({ error: e.message }); }
});

// Delete a BUSINESS account — the owner permanently removes their own shop.
// Removes the business doc, its staff/tips/consents, its shop code, cancels any
// Pro subscription, and deletes the owner's Firebase login. Workers' own accounts
// and bank connections are NOT touched (they may belong to other shops).
// Step 1: request a 6-digit deletion code, emailed to the owner's own address.
function deleteCodeHtml(code) {
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Confirm account deletion</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 10px;">You asked to permanently delete your EasyTipMe business account. Enter this code in the app to confirm:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#e5484d;background:#fff2f2;border-radius:14px;padding:16px 0;margin:0 0 10px;">${escapeHtml(code)}</div>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:10px 0 0;">This code expires in 15 minutes. If you didn't request this, ignore this email — your account stays exactly as it is.</p>
  </div>`);
}
// Before a business is wiped, pay out any money that was HELD for its workers
// (pool shares kept back while a worker hadn't finished connecting their bank).
// For each staff with a ready Connect account, transfer their held+unreleased
// shares so nothing is silently deleted. Idempotent per tip (release_<tipId>).
// Held shares for workers who never connected simply can't be paid and are
// reported back so the caller/admin knows. Never throws — deletion continues.
async function releaseHeldForBusiness(bizRef) {
  const out = { released: 0, amountCents: 0, unpaidHeld: 0, unpaidCents: 0, currency: null };
  try {
    const staffSnap = await bizRef.collection('staff').get();
    for (const sd of staffSnap.docs) {
      const staff = sd.data();
      const staffId = sd.id;
      const acctId = staff.connectAccountId;
      let ready = false;
      if (acctId) {
        try { const a = await stripe.accounts.retrieve(acctId); ready = !!((a.capabilities && a.capabilities.transfers === 'active') || a.payouts_enabled); } catch (_) { ready = false; }
      }
      let tipsSnap;
      try { tipsSnap = await bizRef.collection('tips').where('staffId', '==', staffId).get(); }
      catch (e) { console.error('release-before-delete tips query', e.message); continue; }
      for (const t of tipsSnap.docs) {
        const td = t.data();
        if (td.held !== true || td.released === true) continue;
        const owed = Math.round(Number(td.staffShare != null ? td.staffShare : td.tip) * 100);
        const cur = (td.currency || 'cad').toLowerCase();
        if (!(owed > 0)) { try { await t.ref.update({ released: true, releasedAt: new Date().toISOString(), releaseNote: 'zero-amount' }); } catch (_) {} continue; }
        if (!ready) { out.unpaidHeld++; out.unpaidCents += owed; out.currency = cur; continue; }
        try {
          const tr = await stripe.transfers.create({
            amount: owed, currency: cur, destination: acctId,
            metadata: { kind: 'held-release-predelete', businessId: bizRef.id, staffId, tipId: t.id }
          }, { idempotencyKey: 'release_' + t.id });
          try { await t.ref.update({ released: true, releasedAt: new Date().toISOString(), transferId: tr.id }); } catch (_) {}
          out.released++; out.amountCents += owed; out.currency = cur;
        } catch (e) { out.unpaidHeld++; out.unpaidCents += owed; out.currency = cur; console.error('release-before-delete transfer', t.id, e.message); }
      }
    }
  } catch (e) { console.error('releaseHeldForBusiness', e.message); }
  return out;
}

app.post('/business/delete-request', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.json({ sent: 0, error: 'admin-not-configured' });
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ sent: 0, error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const addr = decoded.email || '';
    if (!addr) return res.status(400).json({ sent: 0, error: 'no-email' });
    const ref = adminDb.collection('deleteCodes').doc(uid);
    const now = Date.now();
    const cur = await ref.get();
    if (cur.exists && cur.data().lastSentMs && (now - cur.data().lastSentMs) < 25000) return res.json({ sent: 1 });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await ref.set({ code, email: addr, expMs: now + 15 * 60000, tries: 0, lastSentMs: now });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (apiKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: addr }], subject: 'Your EasyTipMe account deletion code', htmlContent: deleteCodeHtml(code) })
      });
    }
    res.json({ sent: 1 });
  } catch (e) { console.error('business delete-request', e.message); res.json({ sent: 0, error: e.message }); }
});

app.post('/business/delete', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, code } = req.body;
    if (!idToken || !code) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    // Verify the emailed deletion code before doing anything destructive.
    const codeRef = adminDb.collection('deleteCodes').doc(uid);
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) return res.status(400).json({ error: 'no-code' });
    const cd = codeSnap.data();
    if (Date.now() > cd.expMs) { await codeRef.delete(); return res.status(400).json({ error: 'expired' }); }
    if ((cd.tries || 0) >= 5) return res.status(429).json({ error: 'too-many' });
    if (String(code).trim() !== String(cd.code)) { await codeRef.update({ tries: (cd.tries || 0) + 1 }); return res.status(400).json({ error: 'wrong-code' }); }
    await codeRef.delete();
    const ref = adminDb.collection('businesses').doc(uid);
    const snap = await ref.get();
    if (snap.exists && snap.data().proSubId) { try { await stripe.subscriptions.cancel(snap.data().proSubId); } catch (_) {} }
    if (snap.exists && snap.data().businessTierSubId) { try { await stripe.subscriptions.cancel(snap.data().businessTierSubId); } catch (_) {} }
    if (snap.exists && snap.data().businessProSubId) { try { await stripe.subscriptions.cancel(snap.data().businessProSubId); } catch (_) {} }
    // Clean deletion: pay out any held worker money first, so nothing is wiped
    // while a worker is still owed a pool share.
    const heldReport = { released: 0, amountCents: 0, unpaidHeld: 0, unpaidCents: 0, currency: null };
    function mergeHeld(r) { heldReport.released += r.released; heldReport.amountCents += r.amountCents; heldReport.unpaidHeld += r.unpaidHeld; heldReport.unpaidCents += r.unpaidCents; if (r.currency) heldReport.currency = r.currency; }
    try { mergeHeld(await releaseHeldForBusiness(ref)); } catch (_) {}
    // Delete any branches this head office owns (their staff/tips/consents/code).
    try {
      const brs = await adminDb.collection('businesses').where('orgOwnerUid', '==', uid).get();
      for (const br of brs.docs) {
        try { mergeHeld(await releaseHeldForBusiness(br.ref)); } catch (_) {}
        for (const sub of ['staff', 'staffPrivate', 'tips', 'consents']) {
          try { const docs = await br.ref.collection(sub).get(); let bt = adminDb.batch(), m = 0; for (const dd of docs.docs) { bt.delete(dd.ref); if (++m >= 400) { await bt.commit(); bt = adminDb.batch(); m = 0; } } if (m > 0) await bt.commit(); } catch (_) {}
        }
        try { const c = br.data().shopCode; if (c) await adminDb.collection('shopCodes').doc(c).delete(); } catch (_) {}
        try { await br.ref.delete(); } catch (_) {}
      }
    } catch (e) { console.error('delete branches', e.message); }
    for (const sub of ['staff', 'staffPrivate', 'tips', 'consents']) {
      try {
        const docs = await ref.collection(sub).get();
        let batch = adminDb.batch(), n = 0;
        for (const d of docs.docs) { batch.delete(d.ref); if (++n >= 400) { await batch.commit(); batch = adminDb.batch(); n = 0; } }
        if (n > 0) await batch.commit();
      } catch (e) { console.error('delete sub ' + sub, e.message); }
    }
    try { const codes = await adminDb.collection('shopCodes').where('bid', '==', uid).get(); const b = adminDb.batch(); codes.forEach(d => b.delete(d.ref)); await b.commit(); } catch (_) {}
    try { await ref.delete(); } catch (e) { console.error('delete biz doc', e.message); }
    try { await adminAuth.deleteUser(uid); } catch (e) { console.error('delete auth', e.message); }
    res.json({ ok: true, heldReleased: heldReport.released, heldAmount: heldReport.amountCents / 100, heldUnpaid: heldReport.unpaidHeld, heldUnpaidAmount: heldReport.unpaidCents / 100, currency: heldReport.currency });
  } catch (e) { console.error('business delete', e.message); res.status(500).json({ error: e.message }); }
});

// Admin-only: FULLY delete any business — Firestore doc + subcollections +
// branches + shop codes + subscriptions + the Firebase Auth login — so the
// owner's email is freed for reuse. Called from the admin control room. Verifies
// the caller is the platform admin (so no one else can wipe a shop).
app.post('/admin/delete-business', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, uid } = req.body;
    if (!idToken || !uid) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const ADMIN = (process.env.ADMIN_EMAIL || 'amidifysolutions@gmail.com').toLowerCase();
    if ((decoded.email || '').toLowerCase() !== ADMIN) return res.status(403).json({ error: 'not-admin' });
    const ref = adminDb.collection('businesses').doc(uid);
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data();
      for (const k of ['proSubId', 'businessTierSubId', 'businessProSubId']) { if (d[k]) { try { await stripe.subscriptions.cancel(d[k]); } catch (_) {} } }
    }
    // Clean deletion: pay out held worker money before anything is wiped.
    const heldReport = { released: 0, amountCents: 0, unpaidHeld: 0, unpaidCents: 0, currency: null };
    function mergeHeld(r) { heldReport.released += r.released; heldReport.amountCents += r.amountCents; heldReport.unpaidHeld += r.unpaidHeld; heldReport.unpaidCents += r.unpaidCents; if (r.currency) heldReport.currency = r.currency; }
    try { mergeHeld(await releaseHeldForBusiness(ref)); } catch (_) {}
    // Branches owned by this head office (their staff/tips/consents/code/doc).
    try {
      const brs = await adminDb.collection('businesses').where('orgOwnerUid', '==', uid).get();
      for (const br of brs.docs) {
        try { mergeHeld(await releaseHeldForBusiness(br.ref)); } catch (_) {}
        for (const sub of ['staff', 'staffPrivate', 'tips', 'consents']) { try { const docs = await br.ref.collection(sub).get(); let bt = adminDb.batch(), m = 0; for (const dd of docs.docs) { bt.delete(dd.ref); if (++m >= 400) { await bt.commit(); bt = adminDb.batch(); m = 0; } } if (m > 0) await bt.commit(); } catch (_) {} }
        try { const c = br.data().shopCode; if (c) await adminDb.collection('shopCodes').doc(c).delete(); } catch (_) {}
        try { await br.ref.delete(); } catch (_) {}
      }
    } catch (e) { console.error('admin delete branches', e.message); }
    for (const sub of ['staff', 'staffPrivate', 'tips', 'consents']) {
      try { const docs = await ref.collection(sub).get(); let batch = adminDb.batch(), n = 0; for (const dd of docs.docs) { batch.delete(dd.ref); if (++n >= 400) { await batch.commit(); batch = adminDb.batch(); n = 0; } } if (n > 0) await batch.commit(); } catch (e) { console.error('admin delete sub ' + sub, e.message); }
    }
    try { const codes = await adminDb.collection('shopCodes').where('bid', '==', uid).get(); const b = adminDb.batch(); codes.forEach(d => b.delete(d.ref)); await b.commit(); } catch (_) {}
    try { await ref.delete(); } catch (e) { console.error('admin delete biz doc', e.message); }
    // Free the login email (doc id == owner's Firebase uid). Fails harmlessly for a branch id.
    let authDeleted = false;
    try { await adminAuth.deleteUser(uid); authDeleted = true; } catch (e) { console.error('admin delete auth', e.message); }
    res.json({ ok: true, authDeleted, heldReleased: heldReport.released, heldAmount: heldReport.amountCents / 100, heldUnpaid: heldReport.unpaidHeld, heldUnpaidAmount: heldReport.unpaidCents / 100, currency: heldReport.currency });
  } catch (e) { console.error('admin delete-business', e.message); res.status(500).json({ error: e.message }); }
});

// Admin-only: free an email — delete its leftover Firebase login (and any orphaned
// business data still under it) so it can register again. Fixes "email already
// registered" after a test shop was removed.
app.post('/admin/free-email', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, email } = req.body;
    if (!idToken || !email) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const ADMIN = (process.env.ADMIN_EMAIL || 'amidifysolutions@gmail.com').toLowerCase();
    if ((decoded.email || '').toLowerCase() !== ADMIN) return res.status(403).json({ error: 'not-admin' });
    const target = String(email).trim().toLowerCase();
    let user;
    try { user = await adminAuth.getUserByEmail(target); } catch (e) { return res.json({ ok: false, error: 'no-such-user' }); }
    const uid = user.uid;
    // Clean any orphaned business data still under this uid, then free the login.
    try {
      const ref = adminDb.collection('businesses').doc(uid);
      const s = await ref.get();
      if (s.exists) {
        for (const sub of ['staff', 'staffPrivate', 'tips', 'consents']) { try { const docs = await ref.collection(sub).get(); let b = adminDb.batch(), n = 0; for (const dd of docs.docs) { b.delete(dd.ref); if (++n >= 400) { await b.commit(); b = adminDb.batch(); n = 0; } } if (n > 0) await b.commit(); } catch (_) {} }
        try { const code = s.data().shopCode; if (code) await adminDb.collection('shopCodes').doc(code).delete(); } catch (_) {}
        try { await ref.delete(); } catch (_) {}
      }
    } catch (_) {}
    await adminAuth.deleteUser(uid);
    res.json({ ok: true, freed: target });
  } catch (e) { console.error('free-email', e.message); res.status(500).json({ error: e.message }); }
});

// ---- Multi-location (Business tier) — branches ------------------------------
// A "head office" on the Business tier runs several branches from one login.
// Each branch is its own shop doc (own code, staff, tips) owned by the head
// office via orgOwnerUid. Managed here with the Admin SDK so NO Firestore rules
// change is needed. Customer + worker flows work unchanged (public reads).
function genCode(n) { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }
async function uniqueShopCode() {
  for (let i = 0; i < 8; i++) { const c = genCode(5); const ex = await adminDb.collection('shopCodes').doc(c).get(); if (!ex.exists) return c; }
  return genCode(7);
}

// Create a new branch (head office must be on the Business tier).
app.post('/branch/create', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, name } = req.body;
    if (!idToken) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const head = await adminDb.collection('businesses').doc(decoded.uid).get();
    const hd = head.exists ? head.data() : {};
    const limit = branchLimitFor(hd);
    if (limit <= 0) return res.status(403).json({ error: 'business-tier-required' });
    // Enforce the plan's branch cap.
    const existing = await adminDb.collection('businesses').where('orgOwnerUid', '==', decoded.uid).get();
    if (existing.size >= limit) return res.status(403).json({ error: 'branch-limit', limit });
    const branchRef = adminDb.collection('businesses').doc();
    const code = await uniqueShopCode();
    await branchRef.set({
      businessName: String(name || '').trim().slice(0, 80) || ((hd.businessName || 'Shop') + ' — Branch'),
      currency: hd.currency || 'CAD',
      country: hd.country || '',
      logo: hd.logo || '',
      orgOwnerUid: decoded.uid,
      isBranch: true,
      shopCode: code,
      createdAt: new Date().toISOString()
    });
    await adminDb.collection('shopCodes').doc(code).set({ bid: branchRef.id, createdAt: new Date().toISOString() });
    res.json({ ok: true, id: branchRef.id, shopCode: code });
  } catch (e) { console.error('branch create', e.message); res.status(500).json({ error: e.message }); }
});

// List the head office's branches with basic aggregated stats.
app.post('/branch/list', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    async function statsFor(ref, b, isMain) {
      let tipCount = 0, tipTotal = 0, ownerShare = 0, staffCount = 0;
      try { const ts = await ref.collection('tips').get(); ts.forEach(t => { const v = t.data(); if (v.poolHold === true) return; tipCount++; tipTotal += (v.tip || 0); ownerShare += (v.ownerShare || 0); }); } catch (_) {}
      try { const ss = await ref.collection('staff').get(); staffCount = ss.size; } catch (_) {}
      return { id: ref.id, name: b.businessName || (isMain ? 'Main location' : 'Branch'), isMain: !!isMain, shopCode: b.shopCode || '', currency: b.currency || 'CAD', tipCount, tipTotal, ownerShare, staffCount, createdAt: b.createdAt || '' };
    }
    const branches = [];
    // Head office's own shop is the "main location".
    const mainRef = adminDb.collection('businesses').doc(decoded.uid);
    const mainSnap = await mainRef.get();
    if (mainSnap.exists) branches.push(await statsFor(mainRef, mainSnap.data(), true));
    const g = await adminDb.collection('businesses').where('orgOwnerUid', '==', decoded.uid).get();
    for (const d of g.docs) branches.push(await statsFor(d.ref, d.data(), false));
    branches.sort((a, b) => (a.isMain ? -1 : b.isMain ? 1 : (a.createdAt < b.createdAt ? -1 : 1)));
    const limit = branchLimitFor(mainSnap.exists ? mainSnap.data() : {});
    res.json({ ok: true, branches, limit, used: g.size });
  } catch (e) { console.error('branch list', e.message); res.status(500).json({ error: e.message }); }
});

// Rename a branch (head office only, must own it).
app.post('/branch/rename', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, id, name } = req.body;
    if (!idToken || !id) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const ref = adminDb.collection('businesses').doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().orgOwnerUid !== decoded.uid) return res.status(403).json({ error: 'not-your-branch' });
    await ref.set({ businessName: String(name || '').trim().slice(0, 80) || 'Branch' }, { merge: true });
    res.json({ ok: true });
  } catch (e) { console.error('branch rename', e.message); res.status(500).json({ error: e.message }); }
});

// Delete a branch (head office only). Removes the branch shop, its staff/tips/
// consents, and its shop code. Workers' own accounts are not touched.
app.post('/branch/delete', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, id } = req.body;
    if (!idToken || !id) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const ref = adminDb.collection('businesses').doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().orgOwnerUid !== decoded.uid) return res.status(403).json({ error: 'not-your-branch' });
    for (const sub of ['staff', 'staffPrivate', 'tips', 'consents']) {
      try {
        const docs = await ref.collection(sub).get();
        let batch = adminDb.batch(), n = 0;
        for (const dd of docs.docs) { batch.delete(dd.ref); if (++n >= 400) { await batch.commit(); batch = adminDb.batch(); n = 0; } }
        if (n > 0) await batch.commit();
      } catch (e) { console.error('branch delete sub ' + sub, e.message); }
    }
    try { const code = snap.data().shopCode; if (code) await adminDb.collection('shopCodes').doc(code).delete(); } catch (_) {}
    try { await ref.delete(); } catch (e) { console.error('branch delete doc', e.message); }
    res.json({ ok: true });
  } catch (e) { console.error('branch delete', e.message); res.status(500).json({ error: e.message }); }
});

// ---- Branch team management (full management of each location) --------------
// A location is "owned" by a user if it's their own shop, or a branch whose
// orgOwnerUid is them. All of this runs via the Admin SDK so the head office can
// manage every branch's team + settings without any Firestore rules change.
async function ownsLocation(uid, id) {
  if (!id || !uid) return false;
  if (id === uid) return true;
  try { const s = await adminDb.collection('businesses').doc(id).get(); return s.exists && s.data().orgOwnerUid === uid; } catch (_) { return false; }
}
// Look up each worker's Stripe payout readiness (bank connected?). Returns a map
// { staffId: 'connected' | 'pending' | 'none' }:
//   connected = a Stripe account exists AND can receive payouts (bank linked)
//   pending   = account exists but onboarding not finished (no bank yet)
//   none      = the worker never started Stripe onboarding
// Uses the same `stripe` client the payment path reads worker accounts with.
async function bankStatusFor(staffArr) {
  const out = {};
  await Promise.all((staffArr || []).map(async (s) => {
    const sid = s.id || s._id;
    if (!sid) return;
    const acct = s.connectAccountId;
    if (!acct) { out[sid] = 'none'; return; }
    try {
      const a = await stripe.accounts.retrieve(acct);
      const ready = !!((a.capabilities && a.capabilities.transfers === 'active') || a.payouts_enabled);
      out[sid] = ready ? 'connected' : 'pending';
    } catch (_) { out[sid] = 'pending'; }
  }));
  return out;
}
// Public staff fields only — real name & phone are PRIVATE and stored in the
// protected `staffPrivate` sub-doc (never on the publicly-readable staff doc).
const STAFF_FIELDS = ['nickname', 'email', 'job', 'photo', 'schedule', 'days', 'shift1', 'shift2', 'published', 'status'];
function cleanStaff(data) {
  const out = {};
  for (const k of STAFF_FIELDS) { if (data && data[k] !== undefined) out[k] = data[k]; }
  if (out.email) out.email = String(out.email).toLowerCase().trim();
  return out;
}
// The private half (real name, phone) for the protected staffPrivate sub-doc.
function privateStaff(data) {
  const out = {};
  if (data && data.realName !== undefined) out.realName = data.realName;
  if (data && data.phone !== undefined) out.phone = data.phone;
  return out;
}

// List a location's team + basic info (owner-only).
app.post('/branch/team', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, id } = req.body;
    if (!idToken || !id) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await ownsLocation(decoded.uid, id))) return res.status(403).json({ error: 'not-your-location' });
    const bref = adminDb.collection('businesses').doc(id);
    const bsnap = await bref.get(); const b = bsnap.exists ? bsnap.data() : {};
    const ss = await bref.collection('staff').get();
    const staff = ss.docs.map(d => Object.assign({ id: d.id }, d.data()));
    const bankStatus = await bankStatusFor(staff);
    res.json({ ok: true, name: b.businessName || '', currency: b.currency || 'CAD', shopCode: b.shopCode || '', tipPresets: b.tipPresets || [5, 10, 20, ''], staff, bankStatus });
  } catch (e) { console.error('branch team', e.message); res.status(500).json({ error: e.message }); }
});

// Bank-connection status for a location's team (owner-only). The owner dashboard
// reads staff from Firestore directly but can't see live Stripe payout state,
// so it calls this to show a "bank connected / setup pending / none" badge.
app.post('/staff/bank-status', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, id } = req.body;
    if (!idToken || !id) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await ownsLocation(decoded.uid, id))) return res.status(403).json({ error: 'not-your-location' });
    const ss = await adminDb.collection('businesses').doc(id).collection('staff').get();
    const staff = ss.docs.map(d => Object.assign({ id: d.id }, d.data()));
    const bankStatus = await bankStatusFor(staff);
    res.json({ ok: true, bankStatus });
  } catch (e) { console.error('bank-status', e.message); res.status(500).json({ error: e.message }); }
});

// Add / update a team member on a location (owner-only). The invite email is
// sent separately by the client via /staff/invite (now branch-aware).
app.post('/branch/staff/save', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, id, staffId, data } = req.body;
    if (!idToken || !id || !data || !data.nickname) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await ownsLocation(decoded.uid, id))) return res.status(403).json({ error: 'not-your-location' });
    const col = adminDb.collection('businesses').doc(id).collection('staff');
    const pcol = adminDb.collection('businesses').doc(id).collection('staffPrivate');
    const clean = cleanStaff(data);
    const priv = privateStaff(data);
    if (staffId) {
      // Strip any legacy real name / phone off the public doc, keep them private.
      const admin = require('firebase-admin');
      const drop = clean.schedule !== undefined ? { days: admin.firestore.FieldValue.delete(), shift1: admin.firestore.FieldValue.delete(), shift2: admin.firestore.FieldValue.delete() } : {};
      await col.doc(staffId).set(Object.assign({}, clean, drop, { realName: admin.firestore.FieldValue.delete(), phone: admin.firestore.FieldValue.delete() }), { merge: true });
      if (Object.keys(priv).length) await pcol.doc(staffId).set(priv, { merge: true });
      return res.json({ ok: true, staffId });
    }
    clean.published = clean.published !== false;
    clean.createdAt = new Date().toISOString();
    const ref = await col.add(clean);
    if (Object.keys(priv).length) { try { await pcol.doc(ref.id).set(priv); } catch (_) {} }
    res.json({ ok: true, staffId: ref.id, created: true });
  } catch (e) { console.error('branch staff save', e.message); res.status(500).json({ error: e.message }); }
});

// Remove / restore / hard-delete a team member on a location (owner-only).
app.post('/branch/staff/remove', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, id, staffId, action } = req.body;
    if (!idToken || !id || !staffId) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await ownsLocation(decoded.uid, id))) return res.status(403).json({ error: 'not-your-location' });
    const ref = adminDb.collection('businesses').doc(id).collection('staff').doc(staffId);
    if (action === 'delete') { await ref.delete(); }
    else if (action === 'restore') { await ref.set({ status: 'active', published: true }, { merge: true }); }
    else { await ref.set({ status: 'removed', published: false }, { merge: true }); }
    res.json({ ok: true });
  } catch (e) { console.error('branch staff remove', e.message); res.status(500).json({ error: e.message }); }
});

// Move a team member from one owned location to another.
app.post('/branch/staff/move', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, fromId, toId, staffId } = req.body;
    if (!idToken || !fromId || !toId || !staffId || fromId === toId) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await ownsLocation(decoded.uid, fromId)) || !(await ownsLocation(decoded.uid, toId))) return res.status(403).json({ error: 'not-your-location' });
    const src = adminDb.collection('businesses').doc(fromId).collection('staff').doc(staffId);
    const snap = await src.get(); if (!snap.exists) return res.status(404).json({ error: 'no-staff' });
    const dst = adminDb.collection('businesses').doc(toId).collection('staff').doc();
    await dst.set(Object.assign({}, snap.data(), { movedAt: new Date().toISOString() }));
    await src.delete();
    res.json({ ok: true, newId: dst.id });
  } catch (e) { console.error('branch staff move', e.message); res.status(500).json({ error: e.message }); }
});

// Edit a location's settings (name, currency, tip presets) — owner-only.
app.post('/branch/settings', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, id, name, currency, tipPresets } = req.body;
    if (!idToken || !id) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await ownsLocation(decoded.uid, id))) return res.status(403).json({ error: 'not-your-location' });
    const upd = {};
    if (typeof name === 'string' && name.trim()) upd.businessName = name.trim().slice(0, 80);
    if (typeof currency === 'string' && currency) upd.currency = currency;
    if (Array.isArray(tipPresets)) upd.tipPresets = tipPresets.slice(0, 4).map(n => Number(n) || 0).filter(n => n > 0);
    await adminDb.collection('businesses').doc(id).set(upd, { merge: true });
    res.json({ ok: true });
  } catch (e) { console.error('branch settings', e.message); res.status(500).json({ error: e.message }); }
});

// Station 2 settlement: after a tip charge succeeds, move the owner's admin fee
// to the owner's connected account (the head office, for a branch). Idempotent —
// safe to call more than once. Does nothing when there is no admin fee.
app.post('/settle-owner-fee', async (req, res) => {
  try {
    if (!adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'missing-fields' });
    const pi = await stripe.paymentIntents.retrieve(paymentId);
    if (!pi || pi.status !== 'succeeded') return res.json({ ok: false, reason: 'not-succeeded' });
    const md = pi.metadata || {};
    const ownerShare = parseInt(md.ownerShare || '0', 10);
    const businessId = md.businessId;
    if (!(ownerShare > 0) || !businessId) return res.json({ ok: true, transferred: 0 });
    const bizSnap = await adminDb.collection('businesses').doc(businessId).get();
    const biz = bizSnap.exists ? bizSnap.data() : {};
    const ownerUid = biz.orgOwnerUid || businessId;     // branch → head office; main → itself
    let ownerData = biz;
    if (biz.orgOwnerUid) { const os = await adminDb.collection('businesses').doc(ownerUid).get(); ownerData = os.exists ? os.data() : {}; }
    const ownerAcct = ownerData.ownerConnectAccountId;
    let ready = false;
    if (ownerAcct) { try { const a = await stripe.accounts.retrieve(ownerAcct); ready = !!((a.capabilities && a.capabilities.transfers === 'active') || a.payouts_enabled); } catch (_) {} }
    if (!ready) return res.json({ ok: true, transferred: 0, held: true });
    try {
      await stripe.transfers.create({
        amount: ownerShare, currency: pi.currency, destination: ownerAcct,
        source_transaction: pi.latest_charge,
        metadata: { kind: 'owner-fee', businessId, paymentId }
      }, { idempotencyKey: 'ownerfee_' + paymentId });
      return res.json({ ok: true, transferred: ownerShare });
    } catch (e) {
      console.error('owner-fee transfer', e.message);
      return res.json({ ok: false, error: e.message, held: true });
    }
  } catch (e) { console.error('settle-owner-fee', e.message); res.status(500).json({ error: e.message }); }
});

// Settle a POOLED tip: split the worker portion EQUALLY among the on-shift,
// payout-ready workers recorded on the charge, via Stripe transfers on the same
// charge (split at source). Also routes the owner admin fee if any. Idempotent
// per worker. Called by the tip page right after a pooled payment succeeds.
app.post('/settle-pool', async (req, res) => {
  try {
    if (!adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'missing-fields' });
    const pi = await stripe.paymentIntents.retrieve(paymentId);
    if (!pi || pi.status !== 'succeeded') return res.json({ ok: false, reason: 'not-succeeded' });
    const md = pi.metadata || {};
    if (md.pool !== '1') return res.json({ ok: true, skipped: 'not-pool' });
    const businessId = md.businessId;
    const tip = parseInt(md.tip || '0', 10);
    const ownerShare = parseInt(md.ownerShare || '0', 10);
    const ids = (md.poolStaffIds || '').split(',').filter(Boolean);
    if (!businessId || !ids.length) return res.json({ ok: true, transferred: 0 });
    const poolNet = Math.max(0, tip - ownerShare);
    // EQUAL split among ALL on-shift workers. A ready worker gets their share
    // now; a not-yet-connected worker's EQUAL share is HELD (never absorbed by
    // the others) and released to them by /staff/release-held once they connect.
    const N = ids.length;
    let transferred = 0, held = 0;
    if (N > 0 && poolNet > 0) {
      const base = Math.floor(poolNet / N);
      let rem = poolNet - base * N;   // spread leftover cents across the first few
      for (const sid of ids) {
        const share = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--;
        if (share <= 0) continue;
        let acct = null, ready = false;
        try {
          const s = await adminDb.collection('businesses').doc(businessId).collection('staff').doc(sid).get();
          if (!s.exists) continue;
          acct = s.data().connectAccountId || null;
          if (acct) { const a = await stripe.accounts.retrieve(acct); ready = !!((a.capabilities && a.capabilities.transfers === 'active') || a.payouts_enabled); }
        } catch (_) {}
        if (ready && acct) {
          try {
            await stripe.transfers.create({
              amount: share, currency: pi.currency, destination: acct,
              source_transaction: pi.latest_charge,
              metadata: { kind: 'pool', businessId, paymentId, staffId: sid }
            }, { idempotencyKey: 'pool_' + paymentId + '_' + sid });
            transferred += share;
          } catch (e) { console.error('pool transfer', sid, e.message); }
        } else {
          // Not payout-ready → HOLD this worker's equal share. Deterministic doc
          // id keeps it idempotent; recipientEmails:[] so it doesn't double-show
          // (the main pooled tip already shows their share); released later by
          // /staff/release-held (finds it via staffId, pays staffShare).
          try {
            const hid = 'poolhold_' + paymentId + '_' + sid;
            await adminDb.collection('businesses').doc(businessId).collection('tips').doc(hid).set({
              staffId: sid, staffShare: share / 100, tip: 0, held: true, released: false, poolHold: true,
              recipientIds: [sid], recipientEmails: [], currency: pi.currency, paymentId,
              multiple: false, createdAt: new Date().toISOString()
            }, { merge: true });
            held += share;
          } catch (e) { console.error('pool hold', sid, e.message); }
        }
      }
    }
    // Owner administrative fee (same routing as /settle-owner-fee).
    if (ownerShare > 0) {
      try {
        const bizSnap = await adminDb.collection('businesses').doc(businessId).get();
        const biz = bizSnap.exists ? bizSnap.data() : {};
        const ownerUid = biz.orgOwnerUid || businessId;
        let ownerData = biz;
        if (biz.orgOwnerUid) { const os = await adminDb.collection('businesses').doc(ownerUid).get(); ownerData = os.exists ? os.data() : {}; }
        const ownerAcct = ownerData.ownerConnectAccountId;
        if (ownerAcct) {
          const a = await stripe.accounts.retrieve(ownerAcct);
          if ((a.capabilities && a.capabilities.transfers === 'active') || a.payouts_enabled) {
            await stripe.transfers.create({ amount: ownerShare, currency: pi.currency, destination: ownerAcct, source_transaction: pi.latest_charge, metadata: { kind: 'owner-fee', businessId, paymentId } }, { idempotencyKey: 'ownerfee_' + paymentId });
          }
        }
      } catch (e) { console.error('pool owner-fee', e.message); }
    }
    return res.json({ ok: true, transferred, held, split: ids.length, poolNet });
  } catch (e) { console.error('settle-pool', e.message); res.status(500).json({ error: e.message }); }
});

// Keep a worker's staff records in sync with their real login email. If the
// worker signed in (or changed their login) with an email that differs from the
// email on their staff record, future tips would be addressed to the old email
// and never reach them. Called by the worker app on load. Also back-fills the
// worker's own recent tips so already-received tips become visible immediately.
app.post('/staff/sync-email', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid, staffId } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const email = (decoded.email || '').toLowerCase();
    if (!email) return res.json({ ok: true, changed: 0 });
    let changed = 0, tipsFixed = 0;
    // Prefer the direct staff-doc reference (the app knows bid+staffId) to avoid a
    // collection-group index dependency; fall back to collection group otherwise.
    let docs = [];
    if (bid && staffId) {
      const ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
      const s = await ref.get();
      if (s.exists && (s.data().claimedUid === decoded.uid || (s.data().email || '').toLowerCase() === email)) docs = [s];
    }
    if (!docs.length) {
      try { const g = await adminDb.collectionGroup('staff').where('claimedUid', '==', decoded.uid).get(); docs = g.docs; } catch (e) { console.error('sync-email cg', e.message); }
    }
    for (const d of docs) {
      const s = d.data();
      const old = (s.email || '').toLowerCase();
      if (old === email) continue;
      // point the staff record at the real login email
      await d.ref.set({ email }, { merge: true });
      changed++;
      // back-fill recent tips (last 60 days) addressed to the old email so the
      // worker can see tips they already received under the old address
      try {
        const bizRef = d.ref.parent.parent; // businesses/{bid}
        const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const ts = await bizRef.collection('tips').where('recipientEmails', 'array-contains', old).get();
        let batch = adminDb.batch(), n = 0;
        for (const td of ts.docs) {
          const arr = (td.data().recipientEmails || []).map(x => String(x).toLowerCase());
          if (arr.includes(email)) continue;
          const ca = td.data().createdAt;
          if (ca && ca.toDate && ca.toDate() < cutoff) continue;
          arr.push(email);
          batch.set(td.ref, { recipientEmails: arr }, { merge: true });
          tipsFixed++;
          if (++n >= 400) { await batch.commit(); batch = adminDb.batch(); n = 0; }
        }
        if (n > 0) await batch.commit();
      } catch (e) { console.error('sync-email backfill', e.message); }
    }
    res.json({ ok: true, changed, tipsFixed });
  } catch (e) { console.error('sync-email', e.message); res.status(500).json({ error: e.message }); }
});

// Authenticated self-diagnostic — returns ONLY the caller's own tip data so we can
// see why tips may not be matching (email vs staffId). No secret params; requires
// the worker's own idToken. Safe: a worker can only ever see their own tips.
app.post('/staff/my-tips-debug', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid } = req.body || {};
    if (!idToken || !bid) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const email = (decoded.email || '').toLowerCase();
    const bref = adminDb.collection('businesses').doc(bid);
    // locate this worker's staff record
    let staffEmail = '-', staffId = '-';
    let sd = await bref.collection('staff').where('claimedUid', '==', decoded.uid).limit(1).get();
    if (sd.empty) sd = await bref.collection('staff').where('email', '==', email).limit(1).get();
    if (!sd.empty) { staffEmail = (sd.docs[0].data().email || '-'); staffId = sd.docs[0].id; }
    // how many tips match by login email vs by this staff record's id
    let byEmail = 0, byStaff = 0, recent = [];
    try { byEmail = (await bref.collection('tips').where('recipientEmails', 'array-contains', email).get()).size; } catch (e) {}
    if (staffId !== '-') {
      try {
        const st = await bref.collection('tips').where('recipientIds', 'array-contains', staffId).get();
        byStaff = st.size;
        const docs = st.docs.sort((a, b) => {
          const ta = a.data().createdAt, tb = b.data().createdAt;
          return ((tb && tb.toMillis ? tb.toMillis() : 0) - (ta && ta.toMillis ? ta.toMillis() : 0));
        }).slice(0, 6);
        recent = docs.map(d => { const t = d.data(); const ca = t.createdAt; let at = '-'; try { at = ca && ca.toDate ? ca.toDate().toISOString().slice(5, 16).replace('T', ' ') : '-'; } catch (_) {} return { at, rE: t.recipientEmails || [], from: t.fromName || '', msg: t.message || '', tip: t.tip || 0 }; });
      } catch (e) {}
    }
    res.json({ ok: true, login: email, staffEmail, staffId, byEmail, byStaff, recent });
  } catch (e) { console.error('my-tips-debug', e.message); res.status(500).json({ error: e.message }); }
});

// Contact / support form → emails the support inbox (reply-to the sender).
app.post('/contact', async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 120);
    const subject = String((req.body && req.body.subject) || '').trim().slice(0, 140);
    const message = String((req.body && req.body.message) || '').trim().slice(0, 4000);
    const role = String((req.body && req.body.role) || '').trim().slice(0, 40);
    if (!email || !/.+@.+\..+/.test(email) || !message) return res.status(400).json({ sent: 0, error: 'missing-fields' });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    const supportEmail = process.env.SUPPORT_EMAIL || 'support@easytipme.com';
    if (!apiKey) return res.json({ sent: 0, note: 'BREVO_API_KEY not set' });
    const body = emailShell(`
      <div style="font-size:18px;font-weight:800;color:#0a0a0a;margin-bottom:10px;">New contact message 📩</div>
      <table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#9a9aa0;width:90px;">Name</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(name || '—')}</td></tr>
        <tr><td style="padding:6px 0;color:#9a9aa0;">Email</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(email)}</td></tr>
        ${role ? `<tr><td style="padding:6px 0;color:#9a9aa0;">Role</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(role)}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#9a9aa0;">Subject</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(subject || '—')}</td></tr>
      </table>
      <div style="margin-top:14px;padding:14px;background:#f6f7fb;border-radius:12px;font-size:14px;color:#111;line-height:1.6;white-space:pre-wrap;">${escapeHtml(message)}</div>
      <p style="font-size:12px;color:#9a9aa0;margin-top:16px;">Reply directly to this email to respond to ${escapeHtml(name || email)}.</p>`);
    let sent = 0;
    try {
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: supportEmail }],
          replyTo: { email, name: name || undefined },
          subject: `📩 Contact: ${subject || 'New message'} — ${name || email}`,
          htmlContent: body
        })
      });
      sent = resp.ok ? 1 : 0;
    } catch (e) { console.error('contact send', e.message); }
    // Friendly auto-acknowledgement to the sender (best-effort).
    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email, name: name || undefined }],
          subject: 'We got your message — EasyTipMe',
          htmlContent: emailShell(`<div style="text-align:center"><div style="font-size:20px;font-weight:800;color:#0a0a0a;">Thanks for reaching out 🙌</div><p style="font-size:15px;color:#333;line-height:1.6;margin:12px 0 0;">We received your message and will get back to you soon. If it's urgent, just reply to this email.</p></div>`)
        })
      });
    } catch (_) {}
    res.json({ sent });
  } catch (e) { console.error('contact', e.message); res.status(500).json({ sent: 0, error: e.message }); }
});

// ---- Password reset via a 6-digit code (standard "forgot password" OTP) ----
// The user forgot their password. We email a one-time code to THEIR OWN address
// (which proves they control the account), they type the code + a new password,
// and only then do we set the new password. Same UX as our email verification.
function resetCodeHtml(code) {
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Reset your password</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 10px;">Enter this code in the app to set a new password:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0071e3;background:#f2f7ff;border-radius:14px;padding:16px 0;margin:0 0 10px;">${escapeHtml(code)}</div>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:10px 0 0;">This code expires in 15 minutes. If you didn't request it, ignore this email — your password stays unchanged.</p>
  </div>`);
}
// Step 1: request a reset code (emailed to the account's own address).
app.post('/reset-request', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.json({ sent: 0, error: 'admin-not-configured' });
    const addr = String((req.body && req.body.email) || '').toLowerCase().trim();
    if (!addr) return res.status(400).json({ sent: 0, error: 'no-email' });
    let uid = null;
    try { const u = await adminAuth.getUserByEmail(addr); uid = u.uid; } catch (_) {}
    // Respond the same whether or not the account exists (don't leak existence).
    if (!uid) return res.json({ sent: 1 });
    const ref = adminDb.collection('resetCodes').doc(uid);
    const now = Date.now();
    const cur = await ref.get();
    if (cur.exists && cur.data().lastSentMs && (now - cur.data().lastSentMs) < 25000) return res.json({ sent: 1 });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await ref.set({ code, email: addr, expMs: now + 15 * 60000, tries: 0, lastSentMs: now });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (apiKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: addr }], subject: 'Your EasyTipMe password reset code', htmlContent: resetCodeHtml(code) })
      });
    }
    res.json({ sent: 1 });
  } catch (e) { console.error('reset-request', e.message); res.json({ sent: 0, error: e.message }); }
});
// Step 2: confirm the code and set the new password.
app.post('/reset-confirm', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const addr = String((req.body && req.body.email) || '').toLowerCase().trim();
    const code = String((req.body && req.body.code) || '').trim();
    const newPassword = String((req.body && req.body.newPassword) || '');
    if (!addr || !code || !newPassword) return res.status(400).json({ error: 'missing-fields' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'weak-password' });
    let uid = null;
    try { const u = await adminAuth.getUserByEmail(addr); uid = u.uid; } catch (_) {}
    if (!uid) return res.status(400).json({ error: 'invalid' });
    const ref = adminDb.collection('resetCodes').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'no-code' });
    const d = snap.data();
    if (Date.now() > d.expMs) { await ref.delete(); return res.status(400).json({ error: 'expired' }); }
    if ((d.tries || 0) >= 5) return res.status(429).json({ error: 'too-many' });
    if (code !== String(d.code)) { await ref.update({ tries: (d.tries || 0) + 1 }); return res.status(400).json({ error: 'wrong-code' }); }
    await adminAuth.updateUser(uid, { password: newPassword });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { console.error('reset-confirm', e.message); res.status(500).json({ error: e.message }); }
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
      // "Who tipped me" (the payer's name) is a Worker Pro feature — only reveal
      // the tipper's name to Pro workers. Free workers get a neutral notification.
      const showFrom = r.pro === true ? fromName : '';
      const payload = {
        sender: { name: senderName, email: senderEmail },
        // name must be omitted (undefined) when empty — Brevo rejects an empty string.
        to: [{ email: r.email, name: r.name || undefined }],
        subject: (showFrom ? (showFrom + ' sent you a tip! 🎉') : 'You received a tip! 🎉'),
        htmlContent: tipEmailHtml(r.name, cur, amt, shopName, showFrom)
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
    if (!(await ownsLocation(decoded.uid, bid))) return res.status(403).json({ error: 'not-your-business' });
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

// Owner removes a worker from THEIR shop. This deletes only the staff record at
// this shop (public + private) — never the worker's own login/account. Verified
// against the owner's ID token (uid must equal the business id).
app.post('/staff/delete', async (req, res) => {
  try {
    const { idToken, bid, staffId } = req.body;
    if (!idToken || !bid || !staffId) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (decoded.uid !== bid) return res.status(403).json({ error: 'not-your-business' });
    // Owner removes this worker from THEIR shop ONLY: delete the staff record
    // (public doc + its private half). We NEVER delete the worker's own login /
    // account — that is theirs alone to delete from their own app. Their EasyTipMe
    // account and any OTHER workplaces stay intact; their past tips stay recorded
    // in this shop's reports. (A worker with no workplace left just sees the
    // "not connected to a workplace" screen and can join a new one.)
    const ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
    await ref.delete();
    try { await adminDb.collection('businesses').doc(bid).collection('staffPrivate').doc(staffId).delete(); } catch (_) {}
    res.json({ ok: true });
  } catch (e) { console.error('staff delete', e.message); res.status(500).json({ error: e.message }); }
});

// Notify a workplace owner (by email) that one of their workers just left the team.
// Called by the worker app right after 'Leave workplace'. Best-effort, non-blocking.
app.post('/staff/notify-leave', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid, staffId } = req.body;
    if (!idToken || !bid || !staffId) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // Confirm the staff record really belongs to the caller (claimed by them).
    const sref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
    const ssnap = await sref.get();
    if (!ssnap.exists) return res.json({ sent: 0, error: 'no-staff' });
    const staff = ssnap.data();
    if (staff.claimedUid && staff.claimedUid !== uid) return res.status(403).json({ error: 'not-your-record' });
    const worker = staff.nickname || 'A team member';
    // Business name + owner email (business doc, else the owner's auth email).
    const bsnap = await adminDb.collection('businesses').doc(bid).get();
    const biz = bsnap.exists ? bsnap.data() : {};
    const shopName = biz.businessName || 'your workplace';
    let ownerEmail = biz.email || '';
    if (!ownerEmail) { try { const ow = await adminAuth.getUser(bid); ownerEmail = ow.email || ''; } catch (_) {} }
    if (!ownerEmail) return res.json({ sent: 0, error: 'no-owner-email' });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (apiKey) {
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#1d1d1f;line-height:1.55"><h2 style="color:#0071e3;margin:0 0 12px">EasyTipMe</h2><p><b>${esc(worker)}</b> has left your team at <b>${esc(shopName)}</b>.</p><p>They no longer appear on your tip page. Their past tip history stays in your records, and you can add them again anytime from your dashboard.</p><p style="color:#6e6e73;font-size:12px;margin-top:22px">Amidify Solutions Inc.</p></div>`;
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: ownerEmail }], subject: `${worker} left your team on EasyTipMe`, htmlContent: html })
      });
    }
    res.json({ sent: 1 });
  } catch (e) { console.error('staff notify-leave', e.message); res.json({ sent: 0, error: e.message }); }
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
// Module-level handle so FieldValue works outside the functions that require()
// firebase-admin locally (increment/delete are used by the partner endpoints).
const FieldValue = adminDb ? require('firebase-admin').firestore.FieldValue : null;

// ---- One Stripe payout account per worker, reused across ALL their workplaces ----
// The account is remembered under workers/{uid}; every shop's staff doc mirrors it
// in connectAccountId, so all existing tip/payout code keeps working unchanged.
async function getWorkerAccount(uid) {
  if (!uid || !adminDb) return null;
  try { const w = await adminDb.collection('workers').doc(uid).get(); if (w.exists && w.data().connectAccountId) return w.data().connectAccountId; } catch (_) {}
  // Backfill from any staff record this worker already connected a bank on.
  try {
    const g = await adminDb.collectionGroup('staff').where('claimedUid', '==', uid).get();
    for (const d of g.docs) { const acct = d.data().connectAccountId; if (acct) { try { await adminDb.collection('workers').doc(uid).set({ connectAccountId: acct, updatedAt: new Date().toISOString() }, { merge: true }); } catch (_) {} return acct; } }
  } catch (e) { console.error('getWorkerAccount', e.message); }
  return null;
}
async function setWorkerAccount(uid, accountId) {
  if (!uid || !accountId || !adminDb) return;
  try { await adminDb.collection('workers').doc(uid).set({ connectAccountId: accountId, updatedAt: new Date().toISOString() }, { merge: true }); } catch (_) {}
}
// Find EVERY staff record a worker owns — INDEX-FREE. Primary source is the
// worker doc's `shops` map (always present, no composite index needed); for each
// shop we query that ONE collection by claimedUid (single-field index, automatic).
// A collection-group query is added only as a bonus (works only if that index
// exists). This is what makes delete-account / release-held reliable even when the
// collection-group index isn't enabled — the old code silently found nothing.
async function workerStaffDocs(uid) {
  const found = new Map(); // ref.path -> snapshot
  if (!uid || !adminDb) return [];
  try {
    const w = await adminDb.collection('workers').doc(uid).get();
    const shops = (w.exists && w.data().shops) || {};
    for (const bid of Object.keys(shops)) {
      try {
        const q = await adminDb.collection('businesses').doc(bid).collection('staff').where('claimedUid', '==', uid).get();
        q.forEach(d => found.set(d.ref.path, d));
      } catch (_) {}
    }
  } catch (_) {}
  try {
    const g = await adminDb.collectionGroup('staff').where('claimedUid', '==', uid).get();
    g.forEach(d => found.set(d.ref.path, d));
  } catch (_) {}
  return Array.from(found.values());
}

app.post('/connect/create-account', async (req, res) => {
  try {
    const { bid, staffId, email, country, firstName, lastName, phone } = req.body;
    if (!bid || !staffId) return res.status(400).json({ error: 'missing bid/staffId' });
    let accountId = null, ref = null, claimedUid = null;
    if (adminDb) {
      ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
      const snap = await ref.get();
      accountId = snap.exists && snap.data().connectAccountId;
      claimedUid = snap.exists ? snap.data().claimedUid : null;
    }
    // A remembered account must exist in the CURRENT Stripe mode. After switching
    // TEST → LIVE keys, an old test account id 404s on live and breaks bank setup
    // ("No such account"). Verify and drop anything stale so a fresh LIVE account
    // is created (or the worker's already-live shared account is reused) below.
    const acctExists = async (id) => { if (!id) return false; try { await connectStripe.accounts.retrieve(id); return true; } catch (e) { console.error('connect stale account', id, e.message); return false; } };
    if (accountId && !(await acctExists(accountId))) accountId = null;
    // Reuse the worker's existing payout account (one Stripe across all shops).
    if (!accountId && claimedUid) {
      const shared = await getWorkerAccount(claimedUid);
      if (shared && await acctExists(shared)) { accountId = shared; if (ref) await ref.set({ connectAccountId: accountId, connectStatus: 'linked', connectAt: new Date().toISOString() }, { merge: true }); }
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
        // Manual payouts: money stays in the worker's balance until THEY cash out.
        // Avoids automatic (salary-like) deposits — important for tipped workers,
        // incl. those on a closed work permit. Worker controls timing via "Cash out".
        settings: { payouts: { schedule: { interval: 'manual' } } },
        metadata: { bid, staffId }
      });
      accountId = acct.id;
      if (ref) await ref.set({ connectAccountId: accountId, connectStatus: 'created', connectAt: new Date().toISOString() }, { merge: true });
      if (claimedUid) await setWorkerAccount(claimedUid, accountId);
    }
    res.json({ accountId });
  } catch (e) { console.error('connect create', e.message); res.status(500).json({ error: e.message }); }
});

// List every workplace this worker belongs to (for the in-app switcher).
app.post('/staff/workplaces', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'missing idToken' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    // Collect candidate workplace ids: from the worker doc (index-free, primary)
    // and, as a bonus, a collection-group query (works only if that index exists).
    const bidMap = new Map(); // bid -> staffId (hint)
    let workerPro = false;
    try { const w = await adminDb.collection('workers').doc(uid).get(); if (w.exists) { const wd = w.data() || {}; workerPro = wd.workerProActive === true; const shops = wd.shops || {}; Object.keys(shops).forEach(bid => bidMap.set(bid, (shops[bid] && shops[bid].staffId) || null)); } } catch (_) {}
    try { const g = await adminDb.collectionGroup('staff').where('claimedUid', '==', uid).get(); g.forEach(d => { const b = d.ref.parent.parent; if (b) bidMap.set(b.id, d.id); }); } catch (_) {}
    const out = [];
    let foundStaffPro = false, healSub = '', healSince = '';
    for (const [bid, hintId] of bidMap) {
      try {
        const bref = adminDb.collection('businesses').doc(bid);
        const b = await bref.get(); if (!b.exists) continue;
        let sid = hintId, sd = null;
        if (sid) { const s = await bref.collection('staff').doc(sid).get(); if (s.exists) sd = s.data(); }
        if (!sd) { const q = await bref.collection('staff').where('claimedUid', '==', uid).limit(1).get(); if (!q.empty) { sid = q.docs[0].id; sd = q.docs[0].data(); } }
        if (!sd) continue;
        // Remember a Pro flag mirrored onto a shop record, so a legacy subscriber
        // (who paid before Pro moved to their account) can be healed just below.
        if (sd.workerProActive === true) { foundStaffPro = true; if (!healSub) healSub = sd.workerProSubId || ''; if (!healSince) healSince = sd.workerProSince || ''; }
        out.push({ bid, staffId: sid, name: b.data().businessName || '', role: sd.job || '', nickname: sd.nickname || '', left: sd.leftByStaff === true, removed: sd.status === 'removed' });
      } catch (_) {}
    }
    // Self-heal: worker's OWN account isn't flagged Pro but a shop record is →
    // promote it onto workers/{uid} so Pro shows in EVERY workplace and survives
    // owner-delete. One-time; from now on the account is the source of truth.
    if (!workerPro && foundStaffPro) {
      workerPro = true;
      try { await adminDb.collection('workers').doc(uid).set({ workerProActive: true, workerProSubId: healSub || '', workerProSince: healSince || new Date().toISOString() }, { merge: true }); } catch (e) { console.error('workplaces heal', e.message); }
    }
    res.json({ ok: true, workplaces: out, pro: workerPro });
  } catch (e) { console.error('workplaces', e.message); res.status(500).json({ error: e.message }); }
});

// Link the worker's shared payout account into the current shop's staff doc, so
// they get paid here without re-connecting a bank. Called when the app loads a shop.
app.post('/staff/link-payout', async (req, res) => {
  try {
    const { idToken, bid, staffId } = req.body;
    if (!idToken || !bid || !staffId) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ ok: true, linked: false });
    const sd = snap.data();
    if (sd.claimedUid && sd.claimedUid !== uid) return res.status(403).json({ error: 'not-your-record' });
    // Remember this workplace under the worker so the in-app switcher can list it
    // without needing a collection-group index.
    try { await adminDb.collection('workers').doc(uid).set({ shops: { [bid]: { staffId, at: new Date().toISOString() } } }, { merge: true }); } catch (_) {}
    // Mirror the worker's OWN Pro status onto this shop's staff record so the app
    // display and the $2-fee waiver work here too (source of truth = workers/{uid}).
    try { const w = await adminDb.collection('workers').doc(uid).get(); if (w.exists && w.data().workerProActive === true && sd.workerProActive !== true) { await ref.set({ workerProActive: true, workerProSubId: w.data().workerProSubId || sd.workerProSubId || '', workerProSince: w.data().workerProSince || new Date().toISOString() }, { merge: true }); } } catch (_) {}
    // Already has one here → make sure it's remembered as the worker's shared account.
    if (sd.connectAccountId) { await setWorkerAccount(uid, sd.connectAccountId); return res.json({ ok: true, linked: false, already: true, accountId: sd.connectAccountId }); }
    const shared = await getWorkerAccount(uid);
    if (shared) { await ref.set({ connectAccountId: shared, connectStatus: 'linked', connectAt: new Date().toISOString() }, { merge: true }); return res.json({ ok: true, linked: true, accountId: shared }); }
    res.json({ ok: true, linked: false });
  } catch (e) { console.error('link-payout', e.message); res.status(500).json({ error: e.message }); }
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

// Worker taps "Cash out" — pay the full available balance to their bank now.
// Payouts are manual (no automatic schedule) and carry a short "TIP" descriptor so
// the bank line reads as a tip rather than a salary. Only "available" funds move
// (Stripe's short hold on pending funds still applies).
app.post('/connect/withdraw', async (req, res) => {
  try {
    const { accountId, method } = req.body;
    if (!accountId) return res.status(400).json({ error: 'missing accountId' });
    const hdr = { stripeAccount: accountId };
    // Defensive: guarantee this account is on manual payouts (older accounts may
    // still be on the automatic default) so it never auto-deposits.
    try { await connectStripe.accounts.update(accountId, { settings: { payouts: { schedule: { interval: 'manual' } } } }); } catch (_) {}

    // INSTANT (~30 min): worker pays a 7% fee (set as our platform instant-payout
    // pricing in Stripe). net_available = what the worker receives after that fee;
    // Stripe collects ~1% and the platform keeps the rest. Requires an eligible
    // instant destination (a debit card in CA) and account eligibility.
    if (method === 'instant') {
      const bal = await connectStripe.balance.retrieve({ ...hdr, expand: ['instant_available.net_available'] });
      const ia = (bal.instant_available || []).filter(b => (b.amount || 0) > 0);
      if (!ia.length) return res.status(400).json({ error: 'no-instant-funds' });
      const payouts = [];
      for (const b of ia) {
        const net = (b.net_available && b.net_available[0] && b.net_available[0].amount != null) ? b.net_available[0].amount : b.amount;
        if (net <= 0) continue;
        const p = await connectStripe.payouts.create(
          { amount: net, currency: b.currency, method: 'instant', statement_descriptor: 'TIP', metadata: { kind: 'worker-cashout-instant' } },
          hdr
        );
        payouts.push({ amount: p.amount / 100, currency: p.currency, status: p.status });
      }
      if (!payouts.length) return res.status(400).json({ error: 'no-instant-funds' });
      return res.json({ ok: true, instant: true, payouts });
    }

    // STANDARD (free, 1–2 business days).
    const bal = await connectStripe.balance.retrieve(hdr);
    const buckets = (bal.available || []).filter(b => (b.amount || 0) > 0);
    if (!buckets.length) return res.status(400).json({ error: 'no-available-funds' });
    const payouts = [];
    for (const b of buckets) {
      const p = await connectStripe.payouts.create(
        { amount: b.amount, currency: b.currency, statement_descriptor: 'TIP', metadata: { kind: 'worker-cashout' } },
        hdr
      );
      payouts.push({ amount: p.amount / 100, currency: p.currency, status: p.status, arrival_date: p.arrival_date });
    }
    res.json({ ok: true, payouts });
  } catch (e) { console.error('connect withdraw', e.message); res.status(500).json({ error: e.message }); }
});

// ---- Partner program: application from the public /partners page ----------
// Stores the application and emails the owner. Deliberately simple: the full
// partner system (accounts, referral links, commission ledger) comes later —
// this only makes the landing page's form real instead of decorative.
app.post('/partners/apply', async (req, res) => {
  try {
    const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const name = String(req.body.name || '').trim().slice(0, 80);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
    const country = String(req.body.country || '').trim().slice(0, 60);
    const audience = String(req.body.audience || '').trim().slice(0, 500);
    if (!name) return res.status(400).json({ error: 'missing-name' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid-email' });

    if (adminDb) {
      const ref = adminDb.collection('partnerApplications').doc(email);
      // Light anti-spam: ignore a repeat application from the same email inside
      // an hour, but still answer OK so the visitor isn't told they failed.
      const cur = await ref.get();
      if (cur.exists && cur.data().createdMs && (Date.now() - cur.data().createdMs) < 3600000) {
        return res.json({ ok: true, duplicate: true });
      }
      await ref.set({ name, email, country, audience, createdMs: Date.now(), status: 'new' }, { merge: true });
    }

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    const notify = process.env.PARTNER_NOTIFY_EMAIL || senderEmail;
    if (apiKey) {
      const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#1d1d1f">
        <h2 style="margin:0 0 14px">New partner application</h2>
        <p style="line-height:1.7;margin:0">
          <b>Name:</b> ${esc(name)}<br>
          <b>Email:</b> ${esc(email)}<br>
          <b>Country:</b> ${esc(country) || '—'}<br>
          <b>How they'll share:</b> ${esc(audience) || '—'}
        </p>
        <p style="font-size:12px;color:#9a9aa0;margin-top:20px">Sent from the EasyTipMe partners page.</p>
      </div>`;
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: notify }], replyTo: { email }, subject: 'New partner application — ' + name, htmlContent: html })
        });
      } catch (_) {}
    }
    res.json({ ok: true });
  } catch (e) { console.error('partners apply', e.message); res.status(500).json({ error: e.message }); }
});

// ============================ PARTNER PROGRAM ==============================
// A partner refers venues and earns a recurring share of the NET revenue those
// venues generate for us (net = after Stripe). Rates: 20% / 25% / 30%, tiers
// upgrade automatically at 25 and 200 active venues, and the rate steps down
// 7 points per 6 months without a new paying venue, never below 10%.
const PARTNER_TIERS = [
  { name: 'Starter', min: 0, rate: 20 },
  { name: 'Pro', min: 25, rate: 25 },
  { name: 'Diamond', min: 200, rate: 30 },
];
const PARTNER_RATE_FLOOR = 10;
const PARTNER_STEP_DOWN = 7;              // percentage points per idle period
const PARTNER_IDLE_MS = 183 * 24 * 3600 * 1000;  // ~6 months
const PARTNER_MIN_PAYOUT_CENTS = 1000;    // $10

// Effective rate for a partner: tier by active venues, minus the idle step-down,
// unless an explicit custom rate has been set for them.
function partnerRateFor(p) {
  if (p && p.customRate != null && !isNaN(Number(p.customRate))) {
    return { rate: Number(p.customRate), tier: 'Custom', baseRate: Number(p.customRate), steps: 0 };
  }
  const active = Number((p && p.activeClients) || 0);
  let tier = PARTNER_TIERS[0];
  for (const t of PARTNER_TIERS) if (active >= t.min) tier = t;
  // Idle clock runs from the last NEW paying venue (or from joining).
  const since = Number((p && (p.lastReferralMs || p.createdMs)) || Date.now());
  const steps = Math.max(0, Math.floor((Date.now() - since) / PARTNER_IDLE_MS));
  const rate = Math.max(PARTNER_RATE_FLOOR, tier.rate - steps * PARTNER_STEP_DOWN);
  return { rate, tier: tier.name, baseRate: tier.rate, steps };
}

// Short, unambiguous referral code (no look-alike characters).
function makePartnerCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 7; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

async function requirePartner(req, res) {
  if (!adminAuth || !adminDb) { res.status(500).json({ error: 'admin-not-configured' }); return null; }
  const idToken = req.body && req.body.idToken;
  if (!idToken) { res.status(400).json({ error: 'missing idToken' }); return null; }
  let decoded;
  try { decoded = await adminAuth.verifyIdToken(idToken); }
  catch (_) { res.status(401).json({ error: 'bad-token' }); return null; }
  return decoded;
}

// Create the partner record for the signed-in user (idempotent).
app.post('/partners/register', async (req, res) => {
  try {
    const decoded = await requirePartner(req, res); if (!decoded) return;
    const uid = decoded.uid;
    const ref = adminDb.collection('partners').doc(uid);
    const snap = await ref.get();
    if (snap.exists) return res.json({ ok: true, code: snap.data().code, existing: true });

    // Reserve a unique code.
    let code = null;
    for (let i = 0; i < 8 && !code; i++) {
      const c = makePartnerCode();
      const cRef = adminDb.collection('partnerCodes').doc(c);
      // eslint-disable-next-line no-await-in-loop
      const taken = await cRef.get();
      if (!taken.exists) { await cRef.set({ uid, createdMs: Date.now() }); code = c; }
    }
    if (!code) return res.status(500).json({ error: 'code-generation-failed' });

    const now = Date.now();
    await ref.set({
      uid, code,
      name: String((req.body && req.body.name) || decoded.name || '').slice(0, 80),
      email: (decoded.email || '').toLowerCase(),
      country: String((req.body && req.body.country) || '').slice(0, 60),
      status: 'active', createdMs: now, lastReferralMs: null,
      activeClients: 0, totalReferred: 0, accruedCents: 0, paidCents: 0,
    });
    res.json({ ok: true, code });
  } catch (e) { console.error('partners register', e.message); res.status(500).json({ error: e.message }); }
});

// Everything the partner dashboard shows.
app.post('/partners/me', async (req, res) => {
  try {
    const decoded = await requirePartner(req, res); if (!decoded) return;
    const snap = await adminDb.collection('partners').doc(decoded.uid).get();
    if (!snap.exists) return res.json({ ok: true, registered: false });
    const p = snap.data();
    const r = partnerRateFor(p);

    // The venues credited to this partner.
    const referrals = [];
    try {
      const q = await adminDb.collection('businesses').where('partnerUid', '==', decoded.uid).get();
      q.forEach(d => {
        const b = d.data();
        referrals.push({
          id: d.id,
          name: b.businessName || '—',
          joinedMs: b.partnerLockedMs || null,
          active: b.blocked !== true,
        });
      });
    } catch (_) {}

    // Recent commission lines.
    const ledger = [];
    try {
      const lq = await adminDb.collection('partners').doc(decoded.uid).collection('ledger')
        .orderBy('createdMs', 'desc').limit(24).get();
      lq.forEach(d => { const x = d.data(); ledger.push({ period: x.period, commission: (x.commissionCents || 0) / 100, rate: x.rate, status: x.status || 'accrued' }); });
    } catch (_) {}

    // Idle step-down: when does the rate drop next?
    const since = Number(p.lastReferralMs || p.createdMs || Date.now());
    const nextStepMs = since + (r.steps + 1) * PARTNER_IDLE_MS;

    res.json({
      ok: true, registered: true,
      code: p.code, name: p.name || '', email: p.email || '', status: p.status || 'active',
      tier: r.tier, rate: r.rate, baseRate: r.baseRate, stepsDown: r.steps,
      nextStepDownMs: r.rate > PARTNER_RATE_FLOOR ? nextStepMs : null,
      activeClients: referrals.filter(x => x.active).length,
      totalReferred: referrals.length,
      accrued: (p.accruedCents || 0) / 100,
      paid: (p.paidCents || 0) / 100,
      minPayout: PARTNER_MIN_PAYOUT_CENTS / 100,
      payoutMethod: p.payoutMethod || null,
      stripeReady: !!p.stripePayoutsEnabled,
      link: APP_URL + '/signup.html?ref=' + p.code,
      referrals, ledger,
    });
  } catch (e) { console.error('partners me', e.message); res.status(500).json({ error: e.message }); }
});

// Credit a newly registered business to a partner. Called once, at signup, with
// the ?ref= code the visitor arrived on. Locked to the first partner only.
app.post('/partners/attribute', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, code } = req.body;
    if (!idToken || !code) return res.status(400).json({ error: 'missing-fields' });
    let decoded;
    try { decoded = await adminAuth.verifyIdToken(idToken); } catch (_) { return res.status(401).json({ error: 'bad-token' }); }
    const bid = decoded.uid;

    const cSnap = await adminDb.collection('partnerCodes').doc(String(code).toUpperCase().trim()).get();
    if (!cSnap.exists) return res.json({ ok: true, credited: false });     // unknown code — ignore quietly
    const partnerUid = cSnap.data().uid;
    if (partnerUid === bid) return res.json({ ok: true, credited: false }); // no self-referral

    const bRef = adminDb.collection('businesses').doc(bid);
    const bSnap = await bRef.get();
    if (!bSnap.exists) return res.json({ ok: true, credited: false });
    if (bSnap.data().partnerUid) return res.json({ ok: true, credited: false }); // already credited — never reassign

    const now = Date.now();
    await bRef.update({ partnerUid, partnerCode: cSnap.id, partnerLockedMs: now });
    const pRef = adminDb.collection('partners').doc(partnerUid);
    await pRef.update({
      totalReferred: FieldValue.increment(1),
      activeClients: FieldValue.increment(1),
      lastReferralMs: now,   // restores the full tier rate
    });
    res.json({ ok: true, credited: true });
  } catch (e) { console.error('partners attribute', e.message); res.status(500).json({ error: e.message }); }
});

// Stripe Connect for the partner's own payouts (same rails as worker payouts).
app.post('/partners/connect', async (req, res) => {
  try {
    const decoded = await requirePartner(req, res); if (!decoded) return;
    const ref = adminDb.collection('partners').doc(decoded.uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'not-a-partner' });
    const p = snap.data();
    let accountId = p.stripeAccountId || null;
    if (accountId) {
      try { await connectStripe.accounts.retrieve(accountId); }
      catch (_) { accountId = null; }   // stale id (e.g. test→live switch)
    }
    if (!accountId) {
      const acct = await connectStripe.accounts.create({
        type: 'express',
        email: p.email || decoded.email || undefined,
        country: String(req.body.country || p.country || 'CA').toUpperCase().slice(0, 2),
        capabilities: { transfers: { requested: true } },
        business_type: 'individual',
        metadata: { partnerUid: decoded.uid, kind: 'partner' },
      });
      accountId = acct.id;
      await ref.update({ stripeAccountId: accountId });
    }
    const base = APP_URL + '/partner.html';
    const link = await connectStripe.accountLinks.create({
      account: accountId,
      refresh_url: base + '?connect=refresh',
      return_url: base + '?connect=done',
      type: 'account_onboarding',
    });
    res.json({ ok: true, url: link.url, accountId });
  } catch (e) { console.error('partners connect', e.message); res.status(500).json({ error: e.message }); }
});

// Refresh whether the partner's Stripe account can actually receive payouts.
app.post('/partners/connect-status', async (req, res) => {
  try {
    const decoded = await requirePartner(req, res); if (!decoded) return;
    const ref = adminDb.collection('partners').doc(decoded.uid);
    const snap = await ref.get();
    const accountId = snap.exists && snap.data().stripeAccountId;
    if (!accountId) return res.json({ ok: true, ready: false });
    const a = await connectStripe.accounts.retrieve(accountId);
    const ready = !!((a.capabilities && a.capabilities.transfers === 'active') || a.payouts_enabled);
    await ref.update({ stripePayoutsEnabled: ready });
    res.json({ ok: true, ready });
  } catch (e) { console.error('partners connect-status', e.message); res.status(500).json({ error: e.message }); }
});

// Manual payout method for countries Stripe does not reach.
app.post('/partners/payout-details', async (req, res) => {
  try {
    const decoded = await requirePartner(req, res); if (!decoded) return;
    const type = String((req.body && req.body.type) || '').toLowerCase();
    const ALLOWED = ['usdt', 'wise', 'western-union', 'bank'];
    if (!ALLOWED.includes(type)) return res.status(400).json({ error: 'bad-type' });
    const details = String((req.body && req.body.details) || '').trim().slice(0, 400);
    if (!details) return res.status(400).json({ error: 'missing-details' });
    await adminDb.collection('partners').doc(decoded.uid).update({
      payoutMethod: { type, details, updatedMs: Date.now() },
    });
    res.json({ ok: true });
  } catch (e) { console.error('partners payout-details', e.message); res.status(500).json({ error: e.message }); }
});

// ---- Admin view of the partner programme -----------------------------------
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'amidifysolutions@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
async function requireAdmin(req, res) {
  const decoded = await requirePartner(req, res); if (!decoded) return null;
  const email = (decoded.email || '').toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) { res.status(403).json({ error: 'not-admin' }); return null; }
  return decoded;
}

app.post('/partners/admin/list', async (req, res) => {
  try {
    const decoded = await requireAdmin(req, res); if (!decoded) return;
    const snap = await adminDb.collection('partners').get();
    const out = [];
    snap.forEach(d => {
      const p = d.data();
      const r = partnerRateFor(p);
      out.push({
        uid: d.id, name: p.name || '', email: p.email || '', code: p.code || '',
        status: p.status || 'active', tier: r.tier, rate: r.rate, baseRate: r.baseRate, stepsDown: r.steps,
        activeClients: p.activeClients || 0, totalReferred: p.totalReferred || 0,
        accrued: (p.accruedCents || 0) / 100, paid: (p.paidCents || 0) / 100,
        payoutMethod: p.payoutMethod || null, stripeReady: !!p.stripePayoutsEnabled,
        customRate: p.customRate != null ? p.customRate : null,
      });
    });
    out.sort((a, b) => b.accrued - a.accrued);
    res.json({ ok: true, partners: out });
  } catch (e) { console.error('partners admin list', e.message); res.status(500).json({ error: e.message }); }
});

// Record that a partner has been paid: moves their accrued balance to paid and
// leaves a receipt line. Money itself is sent outside this call.
app.post('/partners/admin/mark-paid', async (req, res) => {
  try {
    const decoded = await requireAdmin(req, res); if (!decoded) return;
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) return res.status(400).json({ error: 'missing-uid' });
    const pRef = adminDb.collection('partners').doc(uid);
    const snap = await pRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'not-found' });
    const p = snap.data();
    const amountCents = Math.round(Number(req.body.amount != null ? req.body.amount * 100 : (p.accruedCents || 0)));
    if (!(amountCents > 0)) return res.status(400).json({ error: 'nothing-to-pay' });
    if (amountCents > (p.accruedCents || 0)) return res.status(400).json({ error: 'more-than-owed' });
    await pRef.update({
      accruedCents: FieldValue.increment(-amountCents),
      paidCents: FieldValue.increment(amountCents),
    });
    await pRef.collection('payouts').add({
      amountCents, method: (p.payoutMethod && p.payoutMethod.type) || (p.stripePayoutsEnabled ? 'stripe' : 'manual'),
      byEmail: (decoded.email || '').toLowerCase(), createdMs: Date.now(),
    });
    res.json({ ok: true, paid: amountCents / 100 });
  } catch (e) { console.error('partners mark-paid', e.message); res.status(500).json({ error: e.message }); }
});

// Set (or clear) a custom rate for one partner.
app.post('/partners/admin/set-rate', async (req, res) => {
  try {
    const decoded = await requireAdmin(req, res); if (!decoded) return;
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) return res.status(400).json({ error: 'missing-uid' });
    const raw = req.body.rate;
    if (raw === null || raw === '' || raw === undefined) {
      await adminDb.collection('partners').doc(uid).update({ customRate: FieldValue.delete() });
      return res.json({ ok: true, cleared: true });
    }
    const rate = Number(raw);
    if (isNaN(rate) || rate < 0 || rate > 60) return res.status(400).json({ error: 'bad-rate' });
    await adminDb.collection('partners').doc(uid).update({ customRate: rate });
    res.json({ ok: true, rate });
  } catch (e) { console.error('partners set-rate', e.message); res.status(500).json({ error: e.message }); }
});

// Monthly commission accrual. For each venue that has a partner, work out what
// we ACTUALLY kept last month (gross commission minus Stripe's cut, plus the $2
// worker fees, which carry no card cost) and credit the partner's share of that.
// Writing to a fixed doc id per partner+period makes this safe to re-run.
const STRIPE_PCT = 0.029, STRIPE_FIXED_CENTS = 30;
function periodKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

async function accruePartnerCommissions(period) {
  if (!adminDb) return { ok: false, error: 'admin-not-configured' };
  // Default to the month that just ended.
  const now = new Date();
  const target = period || periodKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const [py, pm] = target.split('-').map(Number);
  const start = Date.UTC(py, pm - 1, 1), end = Date.UTC(py, pm, 1);

  // Only venues that belong to a partner.
  const bizSnap = await adminDb.collection('businesses').where('partnerUid', '!=', null).get();
  const byPartner = {};      // partnerUid -> net cents earned from their venues
  let venues = 0;

  for (const b of bizSnap.docs) {
    const biz = b.data();
    const partnerUid = biz.partnerUid;
    if (!partnerUid) continue;
    venues++;
    let netCents = 0;
    try {
      const tips = await adminDb.collection('businesses').doc(b.id).collection('tips').get();
      tips.forEach(t => {
        const x = t.data();
        const ms = (x.createdAt && x.createdAt.toMillis) ? x.createdAt.toMillis() : 0;
        if (ms < start || ms >= end) return;
        const tipC = Math.round(Number(x.tip || 0) * 100);
        const feeC = Math.round(Number(x.fee || 0) * 100);
        if (feeC <= 0) return;
        // What Stripe took from the whole charge, and what we were left with.
        const stripeC = Math.round(STRIPE_PCT * (tipC + feeC)) + STRIPE_FIXED_CENTS;
        netCents += (feeC - stripeC);
        // The $2 active-account fee is deducted from the worker's transfer, so it
        // carries no card processing cost — it is ours in full.
        netCents += Math.round(Number(x.monthlyFee || 0) * 100);
      });
    } catch (e) { console.error('accrue tips', b.id, e.message); }
    if (netCents > 0) byPartner[partnerUid] = (byPartner[partnerUid] || 0) + netCents;
  }

  const results = [];
  for (const uid of Object.keys(byPartner)) {
    try {
      const pRef = adminDb.collection('partners').doc(uid);
      const pSnap = await pRef.get();
      if (!pSnap.exists) continue;
      const p = pSnap.data();
      if (p.status === 'suspended') continue;   // suspended partners accrue nothing
      const { rate } = partnerRateFor(p);
      const netCents = byPartner[uid];
      const commissionCents = Math.round(netCents * rate / 100);
      if (commissionCents <= 0) continue;

      const lRef = pRef.collection('ledger').doc(target);
      const prev = await lRef.get();
      const prevAmount = prev.exists ? Number(prev.data().commissionCents || 0) : 0;
      await lRef.set({
        period: target, netCents, rate, commissionCents,
        createdMs: Date.now(), status: 'accrued',
      }, { merge: true });
      // Re-running only ever adjusts by the difference, never double-credits.
      const delta = commissionCents - prevAmount;
      if (delta !== 0) await pRef.update({ accruedCents: FieldValue.increment(delta) });
      results.push({ uid, period: target, netCents, rate, commissionCents, delta });
    } catch (e) { console.error('accrue partner', uid, e.message); }
  }
  console.log('partner-accrual', target, 'venues=' + venues, 'partners=' + results.length);
  return { ok: true, period: target, venues, credited: results };
}

// ---- Automatic partner payouts via Stripe ----------------------------------
// Once commission is accrued, partners who connected Stripe are paid AUTOMATICALLY
// — no manual step. Money moves from the platform balance to the partner's own
// connected account, and from there Stripe pays it out to their bank.
// Any transfer cost is borne by the PARTNER: set config/platform.partnerTransferFeePercent
// and it is deducted from their amount before sending.
async function payPartnersViaStripe() {
  if (!adminDb) return { ok: false, error: 'admin-not-configured' };
  let cfg = {};
  try { const c = await adminDb.collection('config').doc('platform').get(); if (c.exists) cfg = c.data() || {}; } catch (_) {}
  const currency = String(cfg.partnerPayoutCurrency || 'cad').toLowerCase();
  const feePct = Number(cfg.partnerTransferFeePercent || 0);   // charged to the partner

  const snap = await adminDb.collection('partners').get();
  const paid = [], skipped = [];
  for (const d of snap.docs) {
    const p = d.data();
    const owed = Number(p.accruedCents || 0);
    try {
      if (p.status === 'suspended') { skipped.push({ uid: d.id, why: 'suspended' }); continue; }
      if (owed < PARTNER_MIN_PAYOUT_CENTS) { skipped.push({ uid: d.id, why: 'below-minimum' }); continue; }
      if (!p.stripeAccountId || !p.stripePayoutsEnabled) { skipped.push({ uid: d.id, why: 'no-stripe' }); continue; }

      const fee = Math.round(owed * feePct / 100);
      const amount = owed - fee;
      if (amount <= 0) { skipped.push({ uid: d.id, why: 'fee-exceeds-amount' }); continue; }

      // Idempotency: one transfer per partner per month, even if this re-runs.
      const period = periodKey(new Date());
      const tr = await connectStripe.transfers.create({
        amount, currency, destination: p.stripeAccountId,
        description: 'EasyTipMe partner commission',
        metadata: { partnerUid: d.id, period, owedCents: String(owed), feeCents: String(fee) },
      }, { idempotencyKey: 'partner-payout-' + d.id + '-' + period });

      await d.ref.update({
        accruedCents: FieldValue.increment(-owed),
        paidCents: FieldValue.increment(amount),
        lastPayoutMs: Date.now(),
      });
      await d.ref.collection('payouts').add({
        amountCents: amount, feeCents: fee, currency, method: 'stripe',
        transferId: tr.id, period, auto: true, createdMs: Date.now(),
      });
      paid.push({ uid: d.id, amount: amount / 100, fee: fee / 100 });
    } catch (e) {
      // Insufficient platform balance or a Stripe error — leave the balance owed
      // and try again next run. Never lose what a partner has earned.
      console.error('partner payout', d.id, e.message);
      skipped.push({ uid: d.id, why: e.message });
    }
  }
  console.log('partner-payouts', 'paid=' + paid.length, 'skipped=' + skipped.length);
  return { ok: true, paid, skipped };
}

app.post('/partners/payout-run', async (req, res) => {
  try {
    const secret = req.headers['x-cron-secret'] || (req.body && req.body.secret);
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'forbidden' });
    res.json(await payPartnersViaStripe());
  } catch (e) { console.error('partners payout-run', e.message); res.status(500).json({ error: e.message }); }
});

// Manual/admin trigger (same secret as the sweep).
app.post('/partners/accrue', async (req, res) => {
  try {
    const secret = req.headers['x-cron-secret'] || (req.body && req.body.secret);
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'forbidden' });
    res.json(await accruePartnerCommissions(req.body && req.body.period));
  } catch (e) { console.error('partners accrue', e.message); res.status(500).json({ error: e.message }); }
});

// Runs itself: once a day the server checks whether last month has been accrued
// yet, and if not, does it. Writing to a per-period doc keeps this idempotent.
let _lastAccrualCheckMs = 0;
async function maybeAccrue() {
  if (Date.now() - _lastAccrualCheckMs < 24 * 3600 * 1000) return;
  _lastAccrualCheckMs = Date.now();
  try {
    const now = new Date();
    const target = periodKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    const marker = adminDb && await adminDb.collection('config').doc('partnerAccrual').get();
    if (marker && marker.exists && marker.data().lastPeriod === target) return;   // already done
    const r = await accruePartnerCommissions(target);
    if (r.ok && adminDb) await adminDb.collection('config').doc('partnerAccrual').set({ lastPeriod: target, ranMs: Date.now() }, { merge: true });
    // Accrue, then pay — partners on Stripe are paid without any manual step.
    if (r.ok) { try { await payPartnersViaStripe(); } catch (e) { console.error('auto-payout', e && e.message); } }
  } catch (e) { console.error('auto-accrual', e && e.message); }
}
setTimeout(maybeAccrue, 7 * 60 * 1000);
setInterval(maybeAccrue, 6 * 3600 * 1000);

// Safety-net auto-sweep (hidden backstop, NOT shown in the app).
// Purpose: money must never sit stuck in a worker's Connect balance forever — if
// a worker forgets, abandons the account, or passes away, an idle balance is
// pushed to THEIR OWN linked bank so it becomes part of their personal funds/
// estate instead of being frozen with us.
//
// Legally safe for closed-work-permit workers: this fires at most ~4 times a year
// per worker, so the bank line is an occasional "TIP" lump — never salary-like.
//
// Self-limiting: for each worker account we only sweep if the LAST payout of any
// kind was > 3 months ago (or, if never paid out, the account is > 3 months old)
// AND the available balance is >= $5. Because of the per-account 3-month check,
// the scheduler can call this as often as it likes with no double-sweeps.
// Core safety-net sweep. Shared by the HTTP endpoint (below) and by the
// internal daily timer, so the net works with no external scheduler at all.
async function runIdleSweep() {
    const IDLE_WINDOW = 92 * 24 * 60 * 60; // seconds (~3 months)
    const MIN_CENTS = 500;                  // only sweep >= $5 available
    const nowSec = Math.floor(Date.now() / 1000);
    const swept = [];
    let scanned = 0, considered = 0, starting_after;

    while (true) {
      const page = await connectStripe.accounts.list(
        Object.assign({ limit: 100 }, starting_after ? { starting_after } : {})
      );
      for (const acc of page.data) {
        scanned++;
        try {
          // Worker accounts only (created with { bid, staffId } metadata).
          if (!acc.metadata || !acc.metadata.staffId) continue;
          if (!acc.payouts_enabled) continue;
          const hdr = { stripeAccount: acc.id };

          const bal = await connectStripe.balance.retrieve(hdr);
          const buckets = (bal.available || []).filter(b => (b.amount || 0) >= MIN_CENTS);
          if (!buckets.length) continue;

          // Last payout of any kind -> how long has money been idle?
          const pl = await connectStripe.payouts.list({ limit: 1 }, hdr);
          const lastPayoutSec = (pl.data[0] && pl.data[0].created) ? pl.data[0].created : null;
          const refSec = lastPayoutSec || acc.created || nowSec;
          if (nowSec - refSec < IDLE_WINDOW) continue;

          considered++;
          // Belt-and-suspenders: keep the account on manual payouts.
          try { await connectStripe.accounts.update(acc.id, { settings: { payouts: { schedule: { interval: 'manual' } } } }); } catch (_) {}
          for (const b of buckets) {
            const p = await connectStripe.payouts.create(
              { amount: b.amount, currency: b.currency, statement_descriptor: 'TIP', metadata: { kind: 'auto-sweep-3mo', staffId: acc.metadata.staffId } },
              hdr
            );
            swept.push({ account: acc.id, staffId: acc.metadata.staffId, amount: p.amount / 100, currency: p.currency });
          }
        } catch (e) { console.error('sweep acct', acc.id, e.message); }
      }
      if (!page.has_more) break;
      starting_after = page.data[page.data.length - 1].id;
    }

    console.log(`sweep-idle: scanned=${scanned} considered=${considered} swept=${swept.length}`);
    return { ok: true, scanned, considered, swept };
}

// On-demand trigger (kept for manual runs). Requires CRON_SECRET to be set.
app.post('/cron/sweep-idle-balances', async (req, res) => {
  try {
    const secret = req.headers['x-cron-secret'] || (req.body && req.body.secret);
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json(await runIdleSweep());
  } catch (e) { console.error('sweep-idle', e.message); res.status(500).json({ error: e.message }); }
});

// Internal scheduler: the safety net runs itself about once a day while the
// server is up — no external cron, no secret, no dashboard to configure. The
// sweep is self-limiting (an account only moves if its last payout was over
// 3 months ago), so an extra run is harmless.
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
let _lastSweepMs = 0;
async function maybeRunSweep(tag) {
  if (Date.now() - _lastSweepMs < SWEEP_EVERY_MS) return;
  _lastSweepMs = Date.now();
  try {
    const r = await runIdleSweep();
    console.log('auto-sweep', tag, 'scanned=' + r.scanned, 'swept=' + r.swept.length);
  } catch (e) { console.error('auto-sweep', tag, e && e.message); }
}
setTimeout(() => maybeRunSweep('boot'), 5 * 60 * 1000);          // 5 min after boot
setInterval(() => maybeRunSweep('daily'), 6 * 60 * 60 * 1000);   // re-check every 6h

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

    // Every staff record this worker owns (index-free; not dependent on the
    // collection-group index).
    const staffDocs = await workerStaffDocs(uid);

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

// Worker permanently deletes THEIR OWN account: removed from EVERY workplace
// (stops appearing on all tip pages, login link severed), their Stripe payout
// account is deleted, and their Firebase login is removed so the email is freed.
// Before anything is removed we try to pay out any held money that's payable.
// The client re-authenticates (password) before calling. Idempotent-safe.
app.post('/staff/delete-account', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'missing idToken' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;

    // Every staff record this worker owns, across all workplaces (index-free —
    // works even when the collection-group index isn't enabled, which was the bug:
    // the old collectionGroup-only lookup silently found nothing and left the
    // worker sitting in the owner's dashboard).
    const staffDocs = await workerStaffDocs(uid);

    const acctIds = new Set();
    let workplaces = 0, released = 0, releasedCents = 0, heldUnpaid = 0, heldUnpaidCents = 0, currency = null;

    for (const sd of staffDocs) {
      const staff = sd.data();
      const staffId = sd.id;
      const bizRef = sd.ref.parent.parent; // businesses/{bid}
      const acctId = staff.connectAccountId;
      let ready = false;
      if (acctId) {
        try { const a = await stripe.accounts.retrieve(acctId); ready = !!((a.capabilities && a.capabilities.transfers === 'active') || a.payouts_enabled); } catch (_) { ready = false; }
      }
      // Pay out any held shares we still can before severing the account.
      if (bizRef) {
        let tipsSnap = null;
        try { tipsSnap = await bizRef.collection('tips').where('staffId', '==', staffId).get(); } catch (_) {}
        if (tipsSnap) for (const t of tipsSnap.docs) {
          const td = t.data();
          if (td.held !== true || td.released === true) continue;
          const owed = Math.round(Number(td.staffShare != null ? td.staffShare : td.tip) * 100);
          const cur = (td.currency || 'cad').toLowerCase();
          if (!(owed > 0)) { try { await t.ref.update({ released: true, releasedAt: new Date().toISOString(), releaseNote: 'zero-amount' }); } catch (_) {} continue; }
          if (!ready) { heldUnpaid++; heldUnpaidCents += owed; currency = cur; continue; }
          try {
            const tr = await stripe.transfers.create({ amount: owed, currency: cur, destination: acctId, metadata: { kind: 'held-release-selfdelete', businessId: bizRef.id, staffId, tipId: t.id } }, { idempotencyKey: 'release_' + t.id });
            try { await t.ref.update({ released: true, releasedAt: new Date().toISOString(), transferId: tr.id }); } catch (_) {}
            released++; releasedCents += owed; currency = cur;
          } catch (e) { heldUnpaid++; heldUnpaidCents += owed; currency = cur; console.error('delete-account release', t.id, e.message); }
        }
      }
      if (acctId) acctIds.add(acctId);
      // Full account deletion → remove the worker from this workplace's roster
      // entirely (not just marked "left"), so the email is truly free to sign up
      // fresh again later. Past tip records stay under the business (separate
      // subcollection) so the owner keeps their history and commission.
      try {
        await sd.ref.delete();
        if (bizRef) { try { await bizRef.collection('staffPrivate').doc(staffId).delete(); } catch (_) {} }
        workplaces++;
      } catch (e) { console.error('delete-account staff delete', e.message); }
    }

    // Delete the worker's Stripe payout account(s). Best-effort — Stripe blocks
    // deletion if a balance is still owed, which protects any un-paid money.
    let stripeDeleted = 0;
    for (const acctId of acctIds) {
      try { await connectStripe.accounts.del(acctId); stripeDeleted++; } catch (e) { console.error('delete-account stripe del', acctId, e.message); }
    }

    // Remove the shared worker doc (payout mapping + shops list) so nothing is left behind.
    try { await adminDb.collection('workers').doc(uid).delete(); } catch (_) {}

    // Free the login email.
    let authDeleted = false;
    try { await adminAuth.deleteUser(uid); authDeleted = true; } catch (e) { console.error('delete-account auth', e.message); }

    res.json({ ok: true, workplaces, released, releasedAmount: releasedCents / 100, heldUnpaid, heldUnpaidAmount: heldUnpaidCents / 100, stripeDeleted, authDeleted, currency });
  } catch (e) { console.error('delete-account', e.message); res.status(500).json({ error: e.message }); }
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
    // Drop a stale account id (e.g. a TEST account after switching to LIVE keys)
    // so a fresh live account gets created instead of failing bank setup.
    if (accountId) { try { await connectStripe.accounts.retrieve(accountId); } catch (e) { console.error('owner stale account -> recreate', accountId, e.message); accountId = null; } }
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

// Owner opens their OWN Stripe Express dashboard (see balance, payouts, edit
// bank details). Returns a one-time login link for the owner's connected
// account. Owner-authenticated (uid must match the business). If Express
// dashboard access isn't enabled yet, falls back to an onboarding account link
// so they can finish setup, then get a dashboard.
app.post('/connect/owner-dashboard-link', async (req, res) => {
  try {
    const { idToken, bid, returnUrl } = req.body;
    if (!idToken || !bid) return res.status(400).json({ error: 'missing fields' });
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (decoded.uid !== bid) return res.status(403).json({ error: 'not-your-business' });
    const snap = await adminDb.collection('businesses').doc(bid).get();
    const acctId = snap.exists && snap.data().ownerConnectAccountId;
    if (!acctId) return res.status(400).json({ error: 'no-account' });
    try {
      const link = await connectStripe.accounts.createLoginLink(acctId);
      return res.json({ url: link.url, kind: 'dashboard' });
    } catch (e) {
      // Account not fully onboarded yet → give an onboarding link instead.
      try {
        const base = (returnUrl || 'https://www.easytipme.com/dashboard.html');
        const al = await connectStripe.accountLinks.create({
          account: acctId, type: 'account_onboarding',
          refresh_url: base, return_url: base
        });
        return res.json({ url: al.url, kind: 'onboarding' });
      } catch (e2) { console.error('owner dashboard link fallback', e2.message); return res.status(500).json({ error: e.message }); }
    }
  } catch (e) { console.error('owner dashboard link', e.message); res.status(500).json({ error: e.message }); }
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

// Register a worker's Expo push token so the tip Cloud Function can notify them.
// Stored (admin) in the isolated `pushTokens/{email}` collection — no money logic,
// no Stripe. The app calls this after sign-in; a failure here never affects tips.
app.post('/staff/register-push', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, expoPushToken } = req.body || {};
    if (!idToken || !expoPushToken) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const email = String(decoded.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'no-email' });
    const ref = adminDb.collection('pushTokens').doc(email);
    const cur = await ref.get();
    const set = new Set((cur.exists && Array.isArray(cur.data().tokens)) ? cur.data().tokens : []);
    set.add(String(expoPushToken));
    const tokens = Array.from(set).slice(-10); // keep at most 10 devices
    await ref.set({ tokens, uid: decoded.uid, updatedAt: new Date().toISOString() }, { merge: true });
    return res.json({ ok: true });
  } catch (e) { console.error('register-push', e.message); return res.status(500).json({ error: e.message }); }
});

// ============================================================================
// Manager API (/mgr/*) — powers the EasyTipMe Manager mobile app.
// A business = the owner's uid (businesses/{ownerUid}). The owner can delegate
// access to "supervisors" by email; a supervisor signs in with their OWN account
// and manages the business through these endpoints. All authorization runs via
// the Admin SDK (no Firestore rules change), exactly like branch management.
//   canManage = you own the location (own shop / branch head office) OR you are a
//   member (supervisor) of its root business. Member management (granting access)
//   is OWNER-ONLY to prevent privilege escalation. Billing & account deletion are
//   never exposed here — supervisors can do everything except those two.
// ============================================================================
async function rootBidOf(id) {
  try { const s = await adminDb.collection('businesses').doc(id).get(); return (s.exists && s.data().orgOwnerUid) || id; }
  catch (_) { return id; }
}
async function isMemberEmail(email, rootBid) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || !rootBid) return false;
  try {
    const q = await adminDb.collection('businesses').doc(rootBid).collection('members').where('email', '==', e).limit(1).get();
    return !q.empty;
  } catch (_) { return false; }
}
// Full management access (owner OR supervisor) to a given location id.
async function canManage(decoded, id) {
  if (!decoded || !id) return false;
  if (await ownsLocation(decoded.uid, id)) return true;
  const root = await rootBidOf(id);
  return await isMemberEmail(decoded.email, root);
}
// True only for the actual account owner of the root business (uid === rootBid).
// Used to gate member management (grant/revoke supervisor access).
async function isRootOwner(decoded, id) {
  if (!decoded || !id) return false;
  const root = await rootBidOf(id);
  return decoded.uid === root;
}

// Which businesses can the signed-in user manage? Their own shop (if any) plus
// every business that has invited them as a supervisor. The Manager app calls
// this on launch to pick the active business.
app.post('/mgr/access', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    const email = String(decoded.email || '').toLowerCase().trim();
    const out = [];
    // Own business (a shop whose doc id is the user's uid, and isn't a branch).
    try {
      const own = await adminDb.collection('businesses').doc(decoded.uid).get();
      if (own.exists && !own.data().orgOwnerUid) out.push({ bid: decoded.uid, name: own.data().businessName || 'My business', role: 'owner' });
    } catch (_) {}
    // Businesses that invited this email as a supervisor.
    if (email) {
      try {
        const q = await adminDb.collectionGroup('members').where('email', '==', email).get();
        for (const d of q.docs) {
          const bid = d.ref.parent.parent.id;
          if (out.some(o => o.bid === bid)) continue;
          const bs = await adminDb.collection('businesses').doc(bid).get();
          out.push({ bid, name: (bs.exists && bs.data().businessName) || 'Business', role: 'manager' });
        }
      } catch (e) { console.error('mgr access group', e.message); }
    }
    res.json({ ok: true, businesses: out });
  } catch (e) { console.error('mgr access', e.message); res.status(500).json({ error: e.message }); }
});

// Dashboard overview for a business: name, currency, team count, tips summary.
app.post('/mgr/overview', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid } = req.body || {};
    if (!idToken || !bid) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await canManage(decoded, bid))) return res.status(403).json({ error: 'no-access' });
    const bref = adminDb.collection('businesses').doc(bid);
    const bsnap = await bref.get(); const b = bsnap.exists ? bsnap.data() : {};
    const ss = await bref.collection('staff').get();
    const teamCount = ss.docs.filter(d => (d.data().status !== 'removed')).length;
    const ts = await bref.collection('tips').get();
    let tipsTotal = 0; const recent = [];
    ts.docs.forEach(d => { const t = d.data(); const amt = Number(t.tip || 0); if (amt > 0) tipsTotal += amt; });
    ts.docs
      .map(d => Object.assign({ id: d.id }, d.data()))
      .sort((a, b2) => String(b2.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 10)
      .forEach(t => recent.push({ id: t.id, tip: Number(t.tip || 0), currency: t.currency || b.currency || 'CAD', rating: t.rating || null, fromName: t.fromName || '', createdAt: t.createdAt || '', staffId: t.staffId || '' }));
    res.json({ ok: true, name: b.businessName || 'My business', currency: b.currency || 'CAD', shopCode: b.shopCode || '', teamCount, tipsCount: ts.size, tipsTotal, recent });
  } catch (e) { console.error('mgr overview', e.message); res.status(500).json({ error: e.message }); }
});

// Team list for a business (manager sees full details incl. private name/phone).
app.post('/mgr/team', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid } = req.body || {};
    if (!idToken || !bid) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await canManage(decoded, bid))) return res.status(403).json({ error: 'no-access' });
    const bref = adminDb.collection('businesses').doc(bid);
    const ss = await bref.collection('staff').get();
    const ps = await bref.collection('staffPrivate').get();
    const priv = {}; ps.docs.forEach(d => priv[d.id] = d.data());
    const staff = ss.docs.map(d => Object.assign({ id: d.id }, d.data(), priv[d.id] || {}));
    const bankStatus = await bankStatusFor(staff);
    res.json({ ok: true, staff, bankStatus });
  } catch (e) { console.error('mgr team', e.message); res.status(500).json({ error: e.message }); }
});

// Add / update a team member (manager). Mirrors /branch/staff/save but canManage.
app.post('/mgr/staff/save', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid, staffId, data } = req.body || {};
    if (!idToken || !bid || !data || !data.nickname) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await canManage(decoded, bid))) return res.status(403).json({ error: 'no-access' });
    const admin = require('firebase-admin');
    const col = adminDb.collection('businesses').doc(bid).collection('staff');
    const pcol = adminDb.collection('businesses').doc(bid).collection('staffPrivate');
    const clean = cleanStaff(data);
    const priv = privateStaff(data);
    if (staffId) {
      await col.doc(staffId).set(Object.assign({}, clean, { realName: admin.firestore.FieldValue.delete(), phone: admin.firestore.FieldValue.delete() }), { merge: true });
      if (Object.keys(priv).length) await pcol.doc(staffId).set(priv, { merge: true });
      return res.json({ ok: true, staffId });
    }
    clean.published = clean.published !== false;
    clean.createdAt = new Date().toISOString();
    const ref = await col.add(clean);
    if (Object.keys(priv).length) { try { await pcol.doc(ref.id).set(priv); } catch (_) {} }
    res.json({ ok: true, staffId: ref.id, created: true });
  } catch (e) { console.error('mgr staff save', e.message); res.status(500).json({ error: e.message }); }
});

// Remove / restore / delete a team member (manager).
app.post('/mgr/staff/remove', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid, staffId, action } = req.body || {};
    if (!idToken || !bid || !staffId) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await canManage(decoded, bid))) return res.status(403).json({ error: 'no-access' });
    const ref = adminDb.collection('businesses').doc(bid).collection('staff').doc(staffId);
    if (action === 'delete') { await ref.delete(); }
    else if (action === 'restore') { await ref.set({ status: 'active', published: true }, { merge: true }); }
    else { await ref.set({ status: 'removed', published: false }, { merge: true }); }
    res.json({ ok: true });
  } catch (e) { console.error('mgr staff remove', e.message); res.status(500).json({ error: e.message }); }
});

// ---- Access / delegation (supervisors) — OWNER ONLY -------------------------
// List the supervisors who have delegated access to a business.
app.post('/mgr/members/list', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid } = req.body || {};
    if (!idToken || !bid) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await isRootOwner(decoded, bid))) return res.status(403).json({ error: 'owner-only' });
    const root = await rootBidOf(bid);
    const ms = await adminDb.collection('businesses').doc(root).collection('members').get();
    const members = ms.docs.map(d => Object.assign({ id: d.id }, d.data()));
    res.json({ ok: true, members });
  } catch (e) { console.error('mgr members list', e.message); res.status(500).json({ error: e.message }); }
});

// Invite a supervisor by email (owner only). Idempotent per email.
app.post('/mgr/members/invite', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid, email } = req.body || {};
    const addr = String(email || '').toLowerCase().trim();
    if (!idToken || !bid || !addr || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return res.status(400).json({ error: 'bad-email' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await isRootOwner(decoded, bid))) return res.status(403).json({ error: 'owner-only' });
    if (addr === String(decoded.email || '').toLowerCase().trim()) return res.status(400).json({ error: 'cant-invite-self' });
    const root = await rootBidOf(bid);
    const col = adminDb.collection('businesses').doc(root).collection('members');
    const existing = await col.where('email', '==', addr).limit(1).get();
    if (!existing.empty) return res.json({ ok: true, already: true });
    const ref = await col.add({ email: addr, role: 'manager', addedBy: decoded.uid, addedByEmail: String(decoded.email || ''), addedAt: new Date().toISOString() });
    // Best-effort email invite via Brevo (never blocks the grant).
    try {
      const apiKey = process.env.BREVO_API_KEY;
      const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
      const senderName = process.env.SENDER_NAME || 'EasyTipMe';
      const bs = await adminDb.collection('businesses').doc(root).get();
      const bizName = (bs.exists && bs.data().businessName) || 'a business';
      if (apiKey) {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({
            sender: { name: senderName, email: senderEmail }, to: [{ email: addr }],
            subject: `You've been given manager access to ${bizName} on EasyTipMe`,
            htmlContent: `<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1d1d1f"><h2 style="margin:0 0 12px">Manager access granted</h2><p style="line-height:1.6">You've been added as a manager for <b>${bizName}</b> on EasyTipMe. Sign in at <b>easytipme.com/manage.html</b> — just enter this email address (${addr}) and we'll send you a sign-in code. No password needed. From there you can manage the team, set schedules, and view tips.</p><p style="font-size:12px;color:#9a9aa0;margin-top:18px">If you weren't expecting this, you can ignore this email.</p></div>`
          })
        }).catch(() => {});
      }
    } catch (_) {}
    res.json({ ok: true, id: ref.id });
  } catch (e) { console.error('mgr members invite', e.message); res.status(500).json({ error: e.message }); }
});

// Revoke a supervisor's access (owner only).
app.post('/mgr/members/remove', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const { idToken, bid, email } = req.body || {};
    const addr = String(email || '').toLowerCase().trim();
    if (!idToken || !bid || !addr) return res.status(400).json({ error: 'missing-fields' });
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!(await isRootOwner(decoded, bid))) return res.status(403).json({ error: 'owner-only' });
    const root = await rootBidOf(bid);
    const col = adminDb.collection('businesses').doc(root).collection('members');
    const q = await col.where('email', '==', addr).get();
    await Promise.all(q.docs.map(d => d.ref.delete()));
    res.json({ ok: true, removed: q.size });
  } catch (e) { console.error('mgr members remove', e.message); res.status(500).json({ error: e.message }); }
});

// ---- Passwordless sign-in for managers/supervisors (email + 6-digit code) ----
// Stripe-Connect style: NO password, ever. Enter email → get a code → you're in.
// The code proves email ownership; we get-or-create the Firebase account and hand
// back a custom token the client exchanges for a session.
function loginCodeHtml(code) {
  return emailShell(`<div style="text-align:center">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-.02em;">Your sign-in code</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:14px 0 10px;">Enter this code on the sign-in page to continue:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0071e3;background:#f2f7ff;border-radius:14px;padding:16px 0;margin:0 0 10px;">${escapeHtml(code)}</div>
    <p style="font-size:12px;color:#9a9aa0;line-height:1.6;margin:10px 0 0;">This code expires in 15 minutes. If you didn't request it, you can ignore this email.</p>
  </div>`);
}
async function emailHasManagerAccess(addr) {
  try { const q = await adminDb.collectionGroup('members').where('email', '==', addr).limit(1).get(); return !q.empty; }
  catch (_) { return false; }
}

// ---- Passwordless sign-in for EVERYONE (worker, owner, manager) -------------
// Same idea as the manager code login, but open to anyone who already belongs
// here: an existing account, or a worker who was added to a shop's team but has
// not signed in yet. Entering the code proves the address, so the account comes
// out emailVerified with no separate verification step and no password at all.
async function emailIsKnown(addr) {
  try { await adminAuth.getUserByEmail(addr); return true; } catch (_) {}
  try { const q = await adminDb.collectionGroup('staff').where('email', '==', addr).limit(1).get(); if (!q.empty) return true; } catch (_) {}
  return await emailHasManagerAccess(addr);
}

app.post('/auth/login/request', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.json({ ok: false, error: 'admin-not-configured' });
    const addr = String((req.body && req.body.email) || '').toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return res.json({ ok: true });
    // Always answer ok so the response never reveals whether an account exists.
    if (!(await emailIsKnown(addr))) return res.json({ ok: true });
    const ref = adminDb.collection('loginCodes').doc(addr);
    const now = Date.now();
    const cur = await ref.get();
    if (cur.exists && cur.data().lastSentMs && (now - cur.data().lastSentMs) < 25000) return res.json({ ok: true });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await ref.set({ code, email: addr, expMs: now + 15 * 60000, tries: 0, lastSentMs: now });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (apiKey) {
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: addr }], subject: 'Your EasyTipMe sign-in code', htmlContent: loginCodeHtml(code) })
        });
      } catch (_) {}
    }
    res.json({ ok: true });
  } catch (e) { console.error('auth login request', e.message); res.json({ ok: false, error: e.message }); }
});
app.post('/mgr/login/request', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.json({ ok: false, error: 'admin-not-configured' });
    const addr = String((req.body && req.body.email) || '').toLowerCase().trim();
    if (!addr || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return res.status(400).json({ ok: false, error: 'bad-email' });
    // Only email a code to someone who has access (a supervisor) or an existing
    // account. Respond ok either way so we never reveal who exists.
    let allowed = await emailHasManagerAccess(addr);
    if (!allowed) { try { await adminAuth.getUserByEmail(addr); allowed = true; } catch (_) {} }
    if (!allowed) return res.json({ ok: true });
    const ref = adminDb.collection('loginCodes').doc(addr);
    const now = Date.now();
    const cur = await ref.get();
    if (cur.exists && cur.data().lastSentMs && (now - cur.data().lastSentMs) < 25000) return res.json({ ok: true });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await ref.set({ code, email: addr, expMs: now + 15 * 60000, tries: 0, lastSentMs: now });
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL || 'info@easytipme.com';
    const senderName = process.env.SENDER_NAME || 'EasyTipMe';
    if (apiKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: addr }], subject: 'Your EasyTipMe sign-in code', htmlContent: loginCodeHtml(code) })
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { console.error('mgr login request', e.message); res.json({ ok: false, error: e.message }); }
});
// One verifier for both entry points — it only checks the code, so it is safe
// to share: codes are only ever issued by the gated /request routes above.
app.post(['/mgr/login/verify', '/auth/login/verify'], async (req, res) => {
  try {
    if (!adminAuth || !adminDb) return res.status(500).json({ error: 'admin-not-configured' });
    const addr = String((req.body && req.body.email) || '').toLowerCase().trim();
    const code = String((req.body && req.body.code) || '').trim();
    if (!addr || !code) return res.status(400).json({ error: 'missing-fields' });
    const ref = adminDb.collection('loginCodes').doc(addr);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'no-code' });
    const d = snap.data();
    if (Date.now() > d.expMs) { await ref.delete(); return res.status(400).json({ error: 'expired' }); }
    if ((d.tries || 0) >= 5) return res.status(429).json({ error: 'too-many' });
    if (code !== String(d.code)) { await ref.update({ tries: (d.tries || 0) + 1 }); return res.status(400).json({ error: 'wrong-code' }); }
    // Code is correct → get-or-create the account (email is now proven).
    let uid = null;
    try { const u = await adminAuth.getUserByEmail(addr); uid = u.uid; if (!u.emailVerified) { try { await adminAuth.updateUser(uid, { emailVerified: true }); } catch (_) {} } }
    catch (_) { const nu = await adminAuth.createUser({ email: addr, emailVerified: true }); uid = nu.uid; }
    const token = await adminAuth.createCustomToken(uid);
    await ref.delete();
    res.json({ ok: true, token });
  } catch (e) { console.error('mgr login verify', e.message); res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
