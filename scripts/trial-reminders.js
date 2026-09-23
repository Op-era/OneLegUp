#!/usr/bin/env node
/*
 * trial-reminders.js — daily job for One Leg Up trial memberships.
 *
 *  - Emails trial members 5 days before their trial expires, with a
 *    "keep my membership" link (subscribe page).
 *  - Flips fully-expired trials to subscription_status 'expired'
 *    (belt & suspenders: server.js also reverts on read).
 *
 * Run daily, e.g.:  node /Users/shanefoster/OneLegUp/scripts/trial-reminders.js
 * DATA_DIR and .env path can be overridden with ONELEGUP_DATA_DIR / ONELEGUP_ENV.
 */
const fs = require('fs');
const path = require('path');

const REPO_DIR = '/Users/shanefoster/OneLegUp';
const DATA_DIR = process.env.ONELEGUP_DATA_DIR || '/Users/shanefoster/OneLegUp-data';
const ENV_PATH = process.env.ONELEGUP_ENV || path.join(REPO_DIR, '.env');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const SITE_URL = 'https://onelegup.club';
const FROM = 'One Leg Up <noreply@onelegup.club>';
const FIVE_DAYS_MS = 5 * 24 * 3600 * 1000;

// Load .env the same way server.js does (launchd does not inject secrets).
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq <= 0) return;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  });
}

function readJSON(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function sendMail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html })
  });
  if (!res.ok) throw new Error('Resend error: ' + await res.text());
  return res.json();
}

async function main() {
  loadEnv();
  const members = readJSON(MEMBERS_FILE);
  const now = Date.now();
  let reminded = 0, expired = 0, dirty = false;

  for (const m of members) {
    if (m.subscription_status !== 'trial' || !m.trial_expires_at) continue;
    const exp = new Date(m.trial_expires_at).getTime();
    if (isNaN(exp)) continue;

    if (exp <= now) {
      m.subscription_status = 'expired';
      expired++; dirty = true;
      console.log(`expired: ${m.email} (${m.trial_code || 'no code'})`);
      continue;
    }
    if (exp - now <= FIVE_DAYS_MS && !m.trial_reminder_sent_at) {
      const dateStr = new Date(m.trial_expires_at).toLocaleDateString('en-US', {
        timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric'
      });
      const link = `${SITE_URL}/subscribe.html`;
      try {
        await sendMail({
          to: m.email,
          subject: 'Your One Leg Up free trial ends soon',
          html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#080808;color:#fff;border-radius:12px;">
        <h2 style="color:#f3c675;font-family:serif;">One Leg Up</h2>
        <p style="color:#c8b896;margin:16px 0;">Hi ${(m.display_name || 'there').replace(/</g, '&lt;')},</p>
        <p style="color:#c8b896;margin:16px 0;">
          Your free One Leg Up trial ends on <strong style="color:#f3c675;">${dateStr}</strong>.
          After that you won't be cleared for parties until you pick up a membership.
        </p>
        <a href="${link}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f3c675,#ec8b57);color:#0d1f28;font-weight:700;text-decoration:none;border-radius:8px;">Keep My Membership</a>
        <p style="color:#666;font-size:0.8rem;margin-top:24px;">Or copy this link: ${link}</p>
        <p style="color:#555;font-size:0.75rem;margin-top:16px;">Questions? Text 559-549-4765 or reply to this email.</p>
      </div>`
        });
        m.trial_reminder_sent_at = new Date().toISOString();
        reminded++; dirty = true;
        console.log(`reminded: ${m.email} (expires ${dateStr})`);
      } catch (e) {
        console.error(`reminder FAILED for ${m.email}:`, e.message);
      }
    }
  }

  if (dirty) writeJSON(MEMBERS_FILE, members);
  console.log(`done — reminded: ${reminded}, expired: ${expired}`);
}

main().catch(e => { console.error('trial-reminders fatal:', e.message); process.exit(1); });
