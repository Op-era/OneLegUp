const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

// Load .env
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
}

const PORT           = 3002;
const DATA_DIR       = '/Users/shanefoster/OneLegUp-data';
const RSVPS_FILE     = path.join(DATA_DIR, 'rsvps.json');
const MEMBERS_FILE   = path.join(DATA_DIR, 'members.json');
const SESSIONS_FILE  = path.join(DATA_DIR, 'sessions.json');
const FORUM_POSTS_FILE   = path.join(DATA_DIR, 'forum_posts.json');
const FORUM_REPLIES_FILE = path.join(DATA_DIR, 'forum_replies.json');
const CONTACTS_FILE      = path.join(DATA_DIR, 'contacts.json');
const SITE_URL           = 'https://onelegup.club';
const PARTY_EMAILS_FILE  = path.join(DATA_DIR, 'party_emails_sent.json');
const EVENTS_FILE        = path.join(DATA_DIR, 'events.json');
const IMAGES_DIR         = path.join(DATA_DIR, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Legacy fallback — only used to seed events.json on first run
const PARTY_SCHEDULE = [
  { date: '2026-06-27', title: 'Suns Out Buns Out Pool Party' },
  { date: '2026-08-01', title: 'School Girls and Professors Party' },
];

function getEvents() {
  const stored = readJSON(EVENTS_FILE);
  if (stored.length) return stored.sort((a,b) => {
    if (a.date === 'TBD') return 1;
    if (b.date === 'TBD') return -1;
    return a.date.localeCompare(b.date);
  });
  return PARTY_SCHEDULE.map(p => ({ id: p.date, title: p.title, date: p.date, description: '', poster: null, signup_text: 'RSVP Now', created_at: new Date().toISOString() }));
}

const FORUM_CATS = [
  { id:'general', name:'General',       desc:'General lifestyle talk',           nsfw:false, icon:'💬' },
  { id:'events',  name:'Event Talk',    desc:'Upcoming and past events',          nsfw:false, icon:'🎉' },
  { id:'intros',  name:'Introductions', desc:'New here? Say hello',               nsfw:false, icon:'👋' },
  { id:'stories', name:'Stories',       desc:'Share your experiences',            nsfw:true,  icon:'🔥' },
  { id:'advice',  name:'Adult Advice',  desc:'Questions and lifestyle guidance',  nsfw:true,  icon:'💭' },
  { id:'kink',    name:'Kink & Fetish', desc:'Explore and discuss kinks',         nsfw:true,  icon:'🖤' },
];

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
      const needsSetup = !members[idx].password_hash && members[idx].setup_token;
      members[idx] = {
        ...members[idx], status: 'approved', subscription_status: 'active',
        stripe_customer_id: String(obj.customer),
        stripe_subscription_id: String(obj.subscription)
      };
      writeJSON(MEMBERS_FILE, members);
      console.log('Subscription activated for member:', members[idx].email);
      if (needsSetup) {
        try { await sendSetupEmail(members[idx].email, members[idx].setup_token); }
        catch(e) { console.error('Setup email failed:', e.message); }
      }
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
async function sendMail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: 'One Leg Up <noreply@onelegup.club>', to, subject, html })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
  return res.json();
}

async function sendSetupEmail(to, token) {
  const link = `${SITE_URL}/set-password.html?token=${token}`;
  await sendMail({
    to,
    subject: 'Action Required — Reset Your One Leg Up Password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#080808;color:#fff;border-radius:12px;">
        <h2 style="color:#f3c675;font-family:serif;">One Leg Up — Site Update</h2>
        <p style="color:#c8b896;margin:16px 0;">
          We're making some updates to the site and as part of those changes
          we're requiring all members to reset their passwords.
        </p>
        <p style="color:#c8b896;margin-bottom:24px;">
          Click the button below to set a new password and continue accessing your account.
          Your membership remains fully active.
        </p>
        <a href="${link}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f3c675,#ec8b57);color:#0d1f28;font-weight:700;text-decoration:none;border-radius:8px;">Reset My Password</a>
        <p style="color:#666;font-size:0.8rem;margin-top:24px;">Or copy this link: ${link}</p>
        <p style="color:#555;font-size:0.75rem;margin-top:16px;">If you have any questions, reply to this email or text us at 559-787-5801.</p>
      </div>`
  });
}

async function sendResetEmail(to, token) {
  const link = `${SITE_URL}/set-password.html?token=${token}`;
  await sendMail({
    to,
    subject: 'Reset your One Leg Up password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#080808;color:#fff;border-radius:12px;">
        <h2 style="color:#f3c675;font-family:serif;">Password Reset</h2>
        <p style="color:#c8b896;margin:16px 0;">Click the button below to set a new password. This link expires in 1 hour.</p>
        <a href="${link}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f3c675,#ec8b57);color:#0d1f28;font-weight:700;text-decoration:none;border-radius:8px;">Reset My Password</a>
        <p style="color:#666;font-size:0.8rem;margin-top:24px;">Or copy this link: ${link}</p>
        <p style="color:#666;font-size:0.8rem;">If you didn't request this, ignore this email.</p>
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

// ── Contact database ──────────────────────────────────────────────────────────
function findOrCreateContact(platform, username, profileType, phone, email) {
  if (!platform || !username) return null;
  const contacts = readJSON(CONTACTS_FILE);
  const key = platform.toLowerCase().trim() + '|' + username.toLowerCase().trim();
  let idx = contacts.findIndex(c =>
    c.platform.toLowerCase().trim() + '|' + c.username.toLowerCase().trim() === key
  );
  if (idx !== -1) {
    contacts[idx].last_seen   = new Date().toISOString();
    contacts[idx].event_count = (contacts[idx].event_count || 0) + 1;
    if (phone) contacts[idx].phone = phone;
    if (email) contacts[idx].email = email;
    if (profileType) contacts[idx].profile_type = profileType;
    writeJSON(CONTACTS_FILE, contacts);
    return contacts[idx].id;
  }
  const contact = {
    id: crypto.randomUUID(), platform, username,
    profile_type: profileType || '', verified: false, membership_type: null,
    first_seen: new Date().toISOString(), last_seen: new Date().toISOString(),
    event_count: 1, phone: phone || '', email: email || '', notes: ''
  };
  contacts.push(contact);
  writeJSON(CONTACTS_FILE, contacts);
  return contact.id;
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
      let me = getMemberFromToken(req);
      const isLoggedIn = !!me;
      if (!me) {
        const { display_name, email, profile_type } = await parseBody(req);
        if (!display_name || !email) return send(400, { error: 'Name and email required' });
        const members = readJSON(MEMBERS_FILE);
        const existing = members.find(m => m.email.toLowerCase() === email.toLowerCase());
        if (existing) {
          if (existing.subscription_status === 'active') return send(409, { error: 'That email already has an active membership' });
          me = existing;
        } else {
          const setup_token = crypto.randomBytes(32).toString('hex');
          me = {
            id: crypto.randomUUID(), display_name, email,
            profile_type: profile_type || '',
            password_hash: '', setup_token,
            status: 'pending', is_admin: false, notes: '',
            subscription_status: 'none', stripe_customer_id: null, stripe_subscription_id: null,
            created_at: new Date().toISOString()
          };
          members.push(me);
          writeJSON(MEMBERS_FILE, members);
        }
      }
      const successUrl = isLoggedIn
        ? `${SITE_URL}/dashboard.html?session_id={CHECKOUT_SESSION_ID}`
        : `${SITE_URL}/subscribe.html?success=1`;
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: me.email,
        client_reference_id: me.id,
        line_items: [{ price: MEMBERSHIP_PRICE_ID, quantity: 1 }],
        success_url: successUrl,
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
      const isDupe = !body.test && rsvps.some(r =>
        !r.test &&
        r.event === body.event &&
        (r.platform || '').toLowerCase() === (body.platform || '').toLowerCase() &&
        (r.username || '').toLowerCase() === (body.username || '').toLowerCase()
      );
      if (isDupe) return send(409, { error: 'You are already on the RSVP list for this party!' });
      const contactId = findOrCreateContact(body.platform, body.username, body.profile_type, body.phone, body.email);
      const contact = contactId ? readJSON(CONTACTS_FILE).find(c => c.id === contactId) : null;
      const autoVerify = contact?.verified && contact?.membership_type === 'Lifetime';
      const autoDonatePaid = body.profile_type === 'Single Female';
      rsvps.push({
        ...body,
        id: Date.now().toString(),
        submitted_at: new Date().toISOString(),
        contact_id: contactId,
        ...(autoVerify && { verified: true, membership_type: 'Lifetime' }),
        ...(autoDonatePaid && { donation_paid: true })
      });
      writeJSON(RSVPS_FILE, rsvps);
      return send(200, { ok: true });
    }

    if (req.method === 'GET' && req.url === '/rsvps') {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      return send(200, readJSON(RSVPS_FILE));
    }

    // Public: safe fields only for upcoming parties
    if (req.method === 'GET' && req.url === '/rsvps/public') {
      const now = new Date();
      const allRsvps = readJSON(RSVPS_FILE);
      const result = getEvents()
        .filter(p => p.date === 'TBD' || new Date(p.date + 'T23:59:59') >= now)
        .map(p => ({
          party: p,
          attendees: allRsvps
            .filter(r => !r.test && r.event && r.event.startsWith(p.title))
            .map(r => ({
              username: r.username,
              platform: r.platform,
              profile_type: r.profile_type,
              submitted_at: r.submitted_at
            }))
        }));
      return send(200, result);
    }

    const rsvpAddressMatch = req.url.match(/^\/rsvp\/([^/]+)\/address$/);
    if (req.method === 'PUT' && rsvpAddressMatch) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      const { address_sent } = await parseBody(req);
      const rsvps = readJSON(RSVPS_FILE);
      const idx = rsvps.findIndex(r => r.id === rsvpAddressMatch[1]);
      if (idx === -1) return send(404, { error: 'Not found' });
      rsvps[idx] = { ...rsvps[idx], address_sent: !!address_sent };
      writeJSON(RSVPS_FILE, rsvps);
      return send(200, { ok: true });
    }

    const rsvpDonationMatch = req.url.match(/^\/rsvp\/([^/]+)\/donation$/);
    if (req.method === 'PUT' && rsvpDonationMatch) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      const { donation_paid } = await parseBody(req);
      const rsvps = readJSON(RSVPS_FILE);
      const idx = rsvps.findIndex(r => r.id === rsvpDonationMatch[1]);
      if (idx === -1) return send(404, { error: 'Not found' });
      rsvps[idx] = { ...rsvps[idx], donation_paid: !!donation_paid };
      writeJSON(RSVPS_FILE, rsvps);
      return send(200, { ok: true });
    }

    const rsvpEventMatch = req.url.match(/^\/rsvp\/([^/]+)\/event$/);
    if (req.method === 'PUT' && rsvpEventMatch) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      const { event } = await parseBody(req);
      const rsvps = readJSON(RSVPS_FILE);
      const idx = rsvps.findIndex(r => r.id === rsvpEventMatch[1]);
      if (idx === -1) return send(404, { error: 'Not found' });
      rsvps[idx] = { ...rsvps[idx], event };
      writeJSON(RSVPS_FILE, rsvps);
      return send(200, { ok: true });
    }

    const verifyRsvp = req.url.match(/^\/rsvp\/(.+)\/verify$/);
    if (req.method === 'PUT' && verifyRsvp) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      const { verified, membership_type } = await parseBody(req);
      const rsvps = readJSON(RSVPS_FILE);
      const idx = rsvps.findIndex(r => r.id === verifyRsvp[1]);
      if (idx === -1) return send(404, { error: 'Not found' });
      rsvps[idx] = { ...rsvps[idx], verified: !!verified, membership_type: verified ? (membership_type || null) : null };
      writeJSON(RSVPS_FILE, rsvps);
      if (rsvps[idx].contact_id) {
        const contacts = readJSON(CONTACTS_FILE);
        const ci = contacts.findIndex(c => c.id === rsvps[idx].contact_id);
        if (ci !== -1) {
          contacts[ci].verified = !!verified;
          if (verified) contacts[ci].membership_type = membership_type || null;
          writeJSON(CONTACTS_FILE, contacts);
        }
      }
      return send(200, { ok: true });
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
      const isReset = members[idx].reset_mode === true;
      members[idx].password_hash = hashPassword(password);
      members[idx].setup_token   = null;
      members[idx].reset_mode    = false;
      writeJSON(MEMBERS_FILE, members);
      const sessionToken = createSession(members[idx].id);
      return send(200, { ok: true, token: sessionToken, reset: isReset });
    }

    if (req.method === 'POST' && req.url === '/member/forgot-password') {
      const { email } = await parseBody(req);
      if (!email) return send(400, { error: 'Email required' });
      const members = readJSON(MEMBERS_FILE);
      const idx = members.findIndex(m => m.email.toLowerCase() === email.toLowerCase());
      // Always respond OK so we don't leak whether an email exists
      if (idx !== -1 && members[idx].password_hash) {
        const token = crypto.randomBytes(32).toString('hex');
        members[idx].setup_token = token;
        members[idx].reset_mode  = true;
        writeJSON(MEMBERS_FILE, members);
        try { await sendResetEmail(email, token); } catch(e) { console.error('Reset email failed:', e.message); }
      }
      return send(200, { ok: true });
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
      const { display_name, profile_type, forum_handle, name_color } = await parseBody(req);
      const cleanHandle = forum_handle !== undefined ? forum_handle.trim().replace(/[^\w\s\-]/g,'').trim().slice(0,30) : undefined;
      writeJSON(MEMBERS_FILE, readJSON(MEMBERS_FILE).map(m =>
        m.id === me.id ? {
          ...m,
          ...(display_name && { display_name }),
          ...(profile_type && { profile_type }),
          ...(cleanHandle !== undefined && { forum_handle: cleanHandle }),
          ...(name_color && /^#[0-9a-fA-F]{6}$/.test(name_color) && { name_color })
        } : m
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

    // ── Contacts ──────────────────────────────────────────────────────────────

    if (req.method === 'GET' && req.url === '/contacts') {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      return send(200, readJSON(CONTACTS_FILE));
    }

    const contactNotes = req.url.match(/^\/contact\/(.+)\/notes$/);
    if (req.method === 'PUT' && contactNotes) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      const { notes } = await parseBody(req);
      const contacts = readJSON(CONTACTS_FILE);
      const idx = contacts.findIndex(c => c.id === contactNotes[1]);
      if (idx === -1) return send(404, { error: 'Not found' });
      contacts[idx].notes = notes || '';
      writeJSON(CONTACTS_FILE, contacts);
      return send(200, { ok: true });
    }

    const delContact = req.url.match(/^\/contact\/(.+)$/);
    if (req.method === 'DELETE' && delContact) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      writeJSON(CONTACTS_FILE, readJSON(CONTACTS_FILE).filter(c => c.id !== delContact[1]));
      return send(200, { ok: true });
    }

    // ── Forum ──────────────────────────────────────────────────────────────────

    if (req.method === 'GET' && req.url === '/forum/categories') {
      const me = getMemberFromToken(req);
      const posts = readJSON(FORUM_POSTS_FILE);
      const replies = readJSON(FORUM_REPLIES_FILE);
      return send(200, FORUM_CATS.map(cat => {
        const cp = posts.filter(p => p.category === cat.id);
        const last = [...cp].sort((a,b) => new Date(b.created_at)-new Date(a.created_at))[0];
        return { ...cat, post_count: cp.length,
          reply_count: replies.filter(r => cp.some(p => p.id === r.post_id)).length,
          last_activity: last?.created_at || null,
          locked: cat.nsfw && me?.status !== 'approved' };
      }));
    }

    if (req.method === 'GET' && req.url.startsWith('/forum/posts')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const catId = params.get('category');
      const page  = Math.max(1, parseInt(params.get('page')||'1'));
      const cat   = FORUM_CATS.find(c => c.id === catId);
      if (!cat) return send(404, { error: 'Category not found' });
      if (cat.nsfw) {
        const me = getMemberFromToken(req);
        if (me?.status !== 'approved') return send(401, { error: 'Approved membership required' });
      }
      const PER = 25;
      const all = readJSON(FORUM_POSTS_FILE).filter(p => p.category === catId).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
      const replies = readJSON(FORUM_REPLIES_FILE);
      const slice = all.slice((page-1)*PER, page*PER).map(p => ({ ...p, reply_count: replies.filter(r => r.post_id === p.id).length }));
      return send(200, { category: cat, posts: slice, total: all.length, page, pages: Math.ceil(all.length/PER)||1 });
    }

    if (req.method === 'GET' && req.url.match(/^\/forum\/post\/([^/]+)$/)) {
      const postId = req.url.match(/^\/forum\/post\/([^/]+)$/)[1];
      const post = readJSON(FORUM_POSTS_FILE).find(p => p.id === postId);
      if (!post) return send(404, { error: 'Post not found' });
      const cat = FORUM_CATS.find(c => c.id === post.category);
      if (cat?.nsfw) {
        const me = getMemberFromToken(req);
        if (me?.status !== 'approved') return send(401, { error: 'Approved membership required' });
      }
      const replies = readJSON(FORUM_REPLIES_FILE).filter(r => r.post_id === postId).sort((a,b) => new Date(a.created_at)-new Date(b.created_at));
      return send(200, { post, replies, category: cat });
    }

    if (req.method === 'POST' && req.url === '/forum/post') {
      const me = getMemberFromToken(req);
      if (!me) return send(401, { error: 'Not logged in' });
      if (me.status !== 'approved') return send(403, { error: 'Approved membership required to post' });
      if (!me.forum_handle) return send(400, { error: 'Set a forum handle in your dashboard first' });
      const { category, title, body } = await parseBody(req);
      if (!category || !title?.trim() || !body?.trim()) return send(400, { error: 'Category, title, and body required' });
      const cat = FORUM_CATS.find(c => c.id === category);
      if (!cat) return send(404, { error: 'Invalid category' });
      const posts = readJSON(FORUM_POSTS_FILE);
      const post = { id: crypto.randomUUID(), author_id: me.id, forum_handle: me.forum_handle,
        name_color: me.name_color || '#f3c675', category, title: title.trim().slice(0,200),
        body: body.trim().slice(0,10000), nsfw: cat.nsfw, created_at: new Date().toISOString() };
      posts.push(post);
      writeJSON(FORUM_POSTS_FILE, posts);
      return send(200, { ok: true, id: post.id });
    }

    if (req.method === 'POST' && req.url === '/forum/reply') {
      const me = getMemberFromToken(req);
      if (!me) return send(401, { error: 'Not logged in' });
      if (me.status !== 'approved') return send(403, { error: 'Approved membership required to reply' });
      if (!me.forum_handle) return send(400, { error: 'Set a forum handle in your dashboard first' });
      const { post_id, body } = await parseBody(req);
      if (!post_id || !body?.trim()) return send(400, { error: 'post_id and body required' });
      if (!readJSON(FORUM_POSTS_FILE).find(p => p.id === post_id)) return send(404, { error: 'Post not found' });
      const replies = readJSON(FORUM_REPLIES_FILE);
      const reply = { id: crypto.randomUUID(), post_id, author_id: me.id, forum_handle: me.forum_handle,
        name_color: me.name_color || '#f3c675', body: body.trim().slice(0,5000), created_at: new Date().toISOString() };
      replies.push(reply);
      writeJSON(FORUM_REPLIES_FILE, replies);
      return send(200, { ok: true, id: reply.id });
    }

    if (req.method === 'DELETE' && req.url.match(/^\/forum\/post\/([^/]+)$/)) {
      const me = getMemberFromToken(req);
      if (!me) return send(401, { error: 'Not logged in' });
      const postId = req.url.match(/^\/forum\/post\/([^/]+)$/)[1];
      const posts = readJSON(FORUM_POSTS_FILE);
      const post  = posts.find(p => p.id === postId);
      if (!post) return send(404, { error: 'Not found' });
      if (!me.is_admin && post.author_id !== me.id) return send(403, { error: 'Forbidden' });
      writeJSON(FORUM_POSTS_FILE, posts.filter(p => p.id !== postId));
      writeJSON(FORUM_REPLIES_FILE, readJSON(FORUM_REPLIES_FILE).filter(r => r.post_id !== postId));
      return send(200, { ok: true });
    }

    if (req.method === 'DELETE' && req.url.match(/^\/forum\/reply\/([^/]+)$/)) {
      const me = getMemberFromToken(req);
      if (!me) return send(401, { error: 'Not logged in' });
      const replyId = req.url.match(/^\/forum\/reply\/([^/]+)$/)[1];
      const replies = readJSON(FORUM_REPLIES_FILE);
      const reply   = replies.find(r => r.id === replyId);
      if (!reply) return send(404, { error: 'Not found' });
      if (!me.is_admin && reply.author_id !== me.id) return send(403, { error: 'Forbidden' });
      writeJSON(FORUM_REPLIES_FILE, replies.filter(r => r.id !== replyId));
      return send(200, { ok: true });
    }

    // ── Serve uploaded images ─────────────────────────────────────────────────
    const imgMatch = req.url.match(/^\/images\/([^/]+)$/);
    if (req.method === 'GET' && imgMatch) {
      const filename = path.basename(imgMatch[1]);
      const imgPath = path.join(IMAGES_DIR, filename);
      if (!fs.existsSync(imgPath)) return send(404, { error: 'Not found' });
      const ext = path.extname(filename).toLowerCase();
      const mime = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(imgPath).pipe(res);
      return;
    }

    // ── Events ────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/events') {
      return send(200, getEvents());
    }

    if (req.method === 'POST' && req.url === '/event') {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      const { title, date, description, poster_data, poster_ext, signup_text } = await parseBody(req);
      if (!title || !date) return send(400, { error: 'Title and date required' });
      let poster = null;
      if (poster_data) {
        const filename = `${Date.now()}.${(poster_ext || 'jpg').replace(/[^a-z0-9]/g,'')}`;
        fs.writeFileSync(path.join(IMAGES_DIR, filename), Buffer.from(poster_data, 'base64'));
        poster = `https://api.onelegup.club/images/${filename}`;
      }
      const events = readJSON(EVENTS_FILE);
      const event = { id: crypto.randomUUID(), title, date, description: description || '', poster, signup_text: signup_text || 'RSVP Now', created_at: new Date().toISOString() };
      events.push(event);
      writeJSON(EVENTS_FILE, events);
      return send(200, { ok: true, event });
    }

    const eventMatch = req.url.match(/^\/event\/([^/]+)$/);

    if (req.method === 'PUT' && eventMatch) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      const { title, date, description, poster_data, poster_ext, signup_text } = await parseBody(req);
      const events = readJSON(EVENTS_FILE);
      const idx = events.findIndex(e => e.id === eventMatch[1]);
      if (idx === -1) return send(404, { error: 'Not found' });
      let poster = events[idx].poster;
      if (poster_data) {
        const filename = `${Date.now()}.${(poster_ext || 'jpg').replace(/[^a-z0-9]/g,'')}`;
        fs.writeFileSync(path.join(IMAGES_DIR, filename), Buffer.from(poster_data, 'base64'));
        poster = `https://api.onelegup.club/images/${filename}`;
      }
      events[idx] = { ...events[idx], ...(title && { title }), ...(date && { date }), description: description ?? events[idx].description, poster, ...(signup_text && { signup_text }) };
      writeJSON(EVENTS_FILE, events);
      return send(200, { ok: true });
    }

    if (req.method === 'DELETE' && eventMatch) {
      const me = getMemberFromToken(req);
      if (!me?.is_admin) return send(401, { error: 'Unauthorized' });
      writeJSON(EVENTS_FILE, readJSON(EVENTS_FILE).filter(e => e.id !== eventMatch[1]));
      return send(200, { ok: true });
    }

    send(404, { error: 'Not found' });

  } catch (e) {
    console.error(e);
    send(500, { error: e.message });
  }
});

// ── Party RSVP email blast ────────────────────────────────────────────────────
// Doors close at 8 PM Los Angeles time; email sends at that moment.

function doorsCloseAt(dateStr) {
  // 8 PM PDT (UTC-7) for summer parties; adjust offset to -08:00 for winter (PST)
  const month = parseInt(dateStr.split('-')[1], 10);
  const offset = (month >= 3 && month <= 11) ? '-07:00' : '-08:00';
  return new Date(`${dateStr}T20:00:00${offset}`);
}

async function sendPartyRsvpEmail(party) {
  const allRsvps = readJSON(RSVPS_FILE);
  const partyRsvps = allRsvps.filter(r => r.event && r.event.startsWith(party.title) && !r.test);

  const rows = partyRsvps.map(r => `
    <tr>
      <td style="padding:10px 12px;border:1px solid #333;">${r.username || '—'}</td>
      <td style="padding:10px 12px;border:1px solid #333;">${r.platform || '—'}</td>
      <td style="padding:10px 12px;border:1px solid #333;">${r.profile_type || '—'}</td>
      <td style="padding:10px 12px;border:1px solid #333;">${r.phone || '—'}</td>
      <td style="padding:10px 12px;border:1px solid #333;">${r.email || '—'}</td>
    </tr>`).join('');

  await sendMail({
    to: 'hautcouple@gmail.com',
    subject: party.title,
    html: `
      <div style="font-family:sans-serif;max-width:680px;margin:0 auto;padding:32px;background:#0a0a0a;color:#fff;border-radius:12px;">
        <h2 style="color:#f3c675;font-family:serif;margin-bottom:4px;">${party.title}</h2>
        <p style="color:#888;margin-bottom:24px;">Doors closed — ${partyRsvps.length} RSVP${partyRsvps.length !== 1 ? 's' : ''} total</p>
        <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
          <thead>
            <tr style="background:#1a1208;color:#f3c675;text-align:left;">
              <th style="padding:10px 12px;border:1px solid #333;">Username</th>
              <th style="padding:10px 12px;border:1px solid #333;">Platform</th>
              <th style="padding:10px 12px;border:1px solid #333;">Type</th>
              <th style="padding:10px 12px;border:1px solid #333;">Phone</th>
              <th style="padding:10px 12px;border:1px solid #333;">Email</th>
            </tr>
          </thead>
          <tbody style="color:#ccc;">
            ${rows || '<tr><td colspan="5" style="padding:12px;color:#666;border:1px solid #333;">No RSVPs recorded.</td></tr>'}
          </tbody>
        </table>
      </div>`
  });
  console.log(`RSVP list emailed for "${party.title}" (${partyRsvps.length} entries)`);
}

async function checkPartyEmailSchedule() {
  const now = new Date();
  const sent = readJSON(PARTY_EMAILS_FILE);
  for (const party of getEvents()) {
    if (sent.includes(party.date)) continue;
    if (now >= doorsCloseAt(party.date)) {
      try {
        await sendPartyRsvpEmail(party);
        sent.push(party.date);
        writeJSON(PARTY_EMAILS_FILE, sent);
      } catch (e) {
        console.error(`Failed to send RSVP email for ${party.title}:`, e.message);
      }
    }
  }
}

setInterval(checkPartyEmailSchedule, 60 * 1000);
checkPartyEmailSchedule();

server.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (readJSON(EVENTS_FILE).length === 0) {
    writeJSON(EVENTS_FILE, PARTY_SCHEDULE.map(p => ({
      id: crypto.randomUUID(), title: p.title, date: p.date,
      description: '', poster: null, signup_text: 'RSVP Now',
      created_at: new Date().toISOString()
    })));
    console.log('Seeded events.json from PARTY_SCHEDULE');
  }
  await ensureMembershipPrice();
});
