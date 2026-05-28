const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');

// Load .env
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
}

const PORT           = 3002;
const RSVPS_FILE     = path.join(__dirname, 'rsvps.json');
const MEMBERS_FILE   = path.join(__dirname, 'members.json');
const SESSIONS_FILE  = path.join(__dirname, 'sessions.json');
const SITE_URL       = 'https://onelegup.club';

// ── Stripe ────────────────────────────────────────────────────────────────────
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
let MEMBERSHIP_PRICE_ID = process.env.STRIPE_PRICE_MEMBERSHIP || '';

async function ensureMembershipPrice() {
  if (!stripe) { console.log('Stripe not configured — set STRIPE_SECRET_KEY in .env'); return; }
  if (MEMBERSHIP_PRICE_ID) { console.log('Membership price:', MEMBERSHIP_PRICE_ID); return; }
  try {
    const products = await stripe.products.list({ active: true, limit: 100 });
    let product = products.data.find(p => p.name === 'One Leg Up Monthly Membership');
    if (!product) {
      product = await stripe.products.create({
        name: 'One Leg Up Monthly Membership',
        description: 'Monthly access to One Leg Up events — no SLS or Kasidie required'
      });
      console.log('Created Stripe product:', product.id);
    }
    const prices = await stripe.prices.list({ product: product.id, active: true });
    let price = prices.data.find(p => p.unit_amount === 999 && p.recurring?.interval === 'month');
    if (!price) {
      price = await stripe.prices.create({
        product: product.id, unit_amount: 999, currency: 'usd',
        recurring: { interval: 'month' }
      });
      console.log('Created Stripe price:', price.id);
    }
    MEMBERSHIP_PRICE_ID = price.id;
    console.log('Membership price ID:', MEMBERSHIP_PRICE_ID);
    console.log('>> Add to .env: STRIPE_PRICE_MEMBERSHIP=' + MEMBERSHIP_PRICE_ID);
  } catch (e) {
    console.error('Stripe setup error:', e.message);
  }
}

async function handleStripeEvent(event) {
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const members = readJSON(MEMBERS_FILE);
    const idx = members.findIndex(m => m.id === obj.client_reference_id);
    if (idx !== -1) {
      members[idx] = {
        ...members[idx], status: 'approved', subscription_status: 'active',
        stripe_customer_id: String(obj.customer),
        stripe_subscription_id: String(obj.subscription)
      };
      writeJSON(MEMBERS_FILE, members);
      console.log('Subscription activated for member:', members[idx].email);
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const members = readJSON(MEMBERS_FILE);
    const idx = members.findIndex(m => m.stripe_subscription_id === obj.id);
    if (idx !== -1) {
      members[idx].subscription_status = 'canceled';
      writeJSON(MEMBERS_FILE, members);
      console.log('Subscription canceled for member:', members[idx].email);
    }
  } else if (event.type === 'invoice.payment_failed') {
    const subId = obj.subscription;
    if (subId) {
      const members = readJSON(MEMBERS_FILE);
      const idx = members.findIndex(m => m.stripe_subscription_id === subId);
      if (idx !== -1) { members[idx].subscription_status = 'past_due'; writeJSON(MEMBERS_FILE, members); }
    }
  }
}

// ── Gmail config ──────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: 'witprod@gmail.com', pass: process.env.GMAIL_PASS || 'GMAIL_APP_PASSWORD' }
});

async function sendSetupEmail(to, token) {
  const link = `${SITE_URL}/set-password.html?token=${token}`;
  await mailer.sendMail({
    from: '"One Leg Up" <witprod@gmail.com>',
    to,
    subject: 'Set up your One Leg Up password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#080808;color:#fff;border-radius:12px;">
        <h2 style="color:#f3c675;font-family:serif;">Welcome to One Leg Up</h2>
        <p style="color:#c8b896;margin:16px 0;">Click the button below to set your password and activate your account. After that, you can subscribe for $9.99/month for instant access to all parties.</p>
        <a href="${link}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f3c675,#ec8b57);color:#0d1f28;font-weight:700;text-decoration:none;border-radius:8px;">Set My Password</a>
        <p style="color:#666;font-size:0.8rem;margin-top:24px;">Or copy this link: ${link}</p>
      </div>`
  });
}

// ── File helpers ──────────────────────────────────────────────────────────────
function readJSON(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Password hashing ──────────────────────────────────────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.scryptSync(pw, salt, 64).toString('hex') === hash;
}

// ── Sessions (persisted to disk so server restarts don't log users out) ────────
function loadSessions() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')))); }
  catch { return new Map(); }
}
function saveSessions(map) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(map)));
}
const sessions = loadSessions();

function createSession(memberId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, memberId);
  saveSessions(sessions);
  return token;
}
function getMemberFromToken(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const id = sessions.get(token);
  if (!id) return null;
  return readJSON(MEMBERS_FILE).find(m => m.id === id) || null;
}

// ── Body parsers ──────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { reject(e); } });
  });
}
function parseRawBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {

    // ── Stripe webhook (raw body — must be before parseBody calls) ────────────

    if (req.method === 'POST' && req.url === '/stripe/webhook') {
      if (!stripe) return send(503, { error: 'Stripe not configured' });
      const rawBody = await parseRawBody(req);
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.error('Webhook sig error:', err.message);
        return send(400, { error: 'Bad signature' });
      }
      await handleStripeEvent(event);
      return send(200, { received: true });
    }

    // ── Subscribe: create Stripe Checkout session ─────────────────────────────

    if (req.method === 'POST' && req.url === '/subscribe/checkout') {
      if (!stripe || !MEMBERSHIP_PRICE_ID) return send(503, { error: 'Stripe not configured' });
      const me = getMemberFromToken(req);
      if (!me) return send(401, { error: 'Not logged in' });
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: me.email,
        client_reference_id: me.id,
        line_items: [{ price: MEMBERSHIP_PRICE_ID, quantity: 1 }],
        success_url: `${SITE_URL}/dashboard.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/subscribe.html?canceled=1`
      });
      return send(200, { url: session.url });
    }

    // ── Subscribe: confirm payment after Stripe redirect ──────────────────────

    if (req.method === 'GET' && req.url.startsWith('/subscribe/confirm')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const sessionId = params.get('session_id');
      const me = getMemberFromToken(req);
      if (!me) return send(401, { error: 'Not logged in' });
      if (!sessionId || !stripe) return send(400, { error: 'Missing session_id' });
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== 'paid' || session.client_reference_id !== me.id)
        return send(400, { error: 'Payment not verified' });
      const members = readJSON(MEMBERS_FILE);
      writeJSON(MEMBERS_FILE, members.map(m =>
        m.id === me.id ? {
          ...m, status: 'approved', subscription_status: 'active',
          stripe_customer_id: String(session.customer),
          stripe_subscription_id: String(session.subscription)
        } : m
      ));
      return send(200, { ok: true });
    }

    // ── Subscribe: Stripe customer portal (manage/cancel) ─────────────────────

    if (req.method === 'POST' && req.url === '/subscribe/portal') {
      const me = getMemberFromToken(req);
      if (!me || !me.stripe_customer_id) return send(400, { error: 'No subscription found' });
      const portal = await stripe.billingPortal.sessions.create({
        customer: me.stripe_customer_id,
        return_url: `${SITE_URL}/dashboard.html`
      });
      return send(200, { url: portal.url });
    }

    // ── RSVPs ─────────────────────────────────────────────────────────────────

    if (req.method === 'POST' && req.url === '/rsvp') {
      const body  = await parseBody(req);
      const rsvps = readJSON(RSVPS_FILE);
      rsvps.push({ ...body, id: Date.now().toString(), submitted_at: new Date().toISOString() });
      writeJSON(RSVPS_FILE, rsvps);
      return send(200, { ok: true });
    }

    if (req.method === 'GET' && req.url === '/rsvps') {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      return send(200, readJSON(RSVPS_FILE));
    }

    const delRsvp = req.url.match(/^\/rsvp\/(.+)$/);
    if (req.method === 'DELETE' && delRsvp) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      writeJSON(RSVPS_FILE, readJSON(RSVPS_FILE).filter(r => r.id !== delRsvp[1]));
      return send(200, { ok: true });
    }

    // ── Registration & password setup ─────────────────────────────────────────

    if (req.method === 'POST' && req.url === '/member/register') {
      const { display_name, email, profile_type } = await parseBody(req);
      if (!display_name || !email || !profile_type)
        return send(400, { error: 'All fields required' });
      const members = readJSON(MEMBERS_FILE);
      if (members.find(m => m.email.toLowerCase() === email.toLowerCase()))
        return send(409, { error: 'Email already registered' });
      const setup_token = crypto.randomBytes(32).toString('hex');
      members.push({
        id: crypto.randomUUID(), display_name, email, profile_type,
        password_hash: '', setup_token,
        status: 'pending', is_admin: false, notes: '',
        subscription_status: 'none', stripe_customer_id: null, stripe_subscription_id: null,
        created_at: new Date().toISOString()
      });
      writeJSON(MEMBERS_FILE, members);
      await sendSetupEmail(email, setup_token);
      return send(200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/member/setup-password') {
      const { token, password } = await parseBody(req);
      if (!token || !password || password.length < 8)
        return send(400, { error: 'Token and password (min 8 chars) required' });
      const members = readJSON(MEMBERS_FILE);
      const idx = members.findIndex(m => m.setup_token === token);
      if (idx === -1) return send(404, { error: 'Invalid or expired link' });
      members[idx].password_hash = hashPassword(password);
      members[idx].setup_token   = null;
      writeJSON(MEMBERS_FILE, members);
      // Auto-login so user can proceed straight to subscription
      const sessionToken = createSession(members[idx].id);
      return send(200, { ok: true, token: sessionToken });
    }

    // ── Login / session ───────────────────────────────────────────────────────

    if (req.method === 'POST' && req.url === '/member/login') {
      const { email, password } = await parseBody(req);
      const member = readJSON(MEMBERS_FILE).find(m => m.email.toLowerCase() === email.toLowerCase());
      if (!member || !member.password_hash)
        return send(401, { error: 'Account not set up yet — check your email for the setup link' });
      if (!verifyPassword(password, member.password_hash))
        return send(401, { error: 'Invalid email or password' });
      const { password_hash, setup_token, ...safe } = member;
      return send(200, { token: createSession(member.id), member: safe });
    }

    if (req.method === 'GET' && req.url === '/member/me') {
      const me = getMemberFromToken(req);
      if (!me) return send(401, { error: 'Not logged in' });
      const { password_hash, setup_token, ...safe } = me;
      return send(200, safe);
    }

    if (req.method === 'PUT' && req.url === '/member/me') {
      const me = getMemberFromToken(req);
      if (!me) return send(401, { error: 'Not logged in' });
      const { display_name, profile_type } = await parseBody(req);
      writeJSON(MEMBERS_FILE, readJSON(MEMBERS_FILE).map(m =>
        m.id === me.id ? { ...m, ...(display_name && { display_name }), ...(profile_type && { profile_type }) } : m
      ));
      return send(200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/member/logout') {
      const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      sessions.delete(token);
      return send(200, { ok: true });
    }

    // ── Admin: members ────────────────────────────────────────────────────────

    if (req.method === 'GET' && req.url === '/members') {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      return send(200, readJSON(MEMBERS_FILE).map(({ password_hash, setup_token, ...m }) => m));
    }

    const statusMatch = req.url.match(/^\/member\/(.+)\/status$/);
    if (req.method === 'PUT' && statusMatch) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      const { status, notes } = await parseBody(req);
      writeJSON(MEMBERS_FILE, readJSON(MEMBERS_FILE).map(m =>
        m.id === statusMatch[1]
          ? { ...m, ...(status !== undefined && { status }), ...(notes !== undefined && { notes }) }
          : m
      ));
      return send(200, { ok: true });
    }

    const delMember = req.url.match(/^\/member\/(.+)$/);
    if (req.method === 'DELETE' && delMember) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      writeJSON(MEMBERS_FILE, readJSON(MEMBERS_FILE).filter(m => m.id !== delMember[1]));
      return send(200, { ok: true });
    }

    send(404, { error: 'Not found' });

  } catch (e) {
    console.error(e);
    send(500, { error: e.message });
  }
});

server.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await ensureMembershipPrice();
});
