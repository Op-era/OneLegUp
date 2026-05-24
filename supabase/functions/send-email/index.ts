import { createHmac } from "node:crypto";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const HOOK_SECRET    = Deno.env.get("SEND_EMAIL_HOOK_SECRET")!;

function verifySignature(body: string, signatureHeader: string): boolean {
  const [t, s] = signatureHeader.split(",").reduce<Record<string,string>>((acc, part) => {
    const [k, v] = part.split("=");
    acc[k] = v;
    return acc;
  }, {} as Record<string,string>);
  if (!t || !s) return false;
  const expected = createHmac("sha256", HOOK_SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  return expected === s;
}

const TEMPLATES: Record<string, (data: Record<string,string>) => { subject: string; html: string }> = {
  signup: (d) => ({
    subject: "Confirm your One Leg Up membership",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a1923;color:#e0d4b8;padding:32px;border-radius:12px;">
        <h1 style="font-family:serif;color:#f3c675;margin:0 0 16px;">One Leg Up</h1>
        <p style="margin:0 0 24px;">Welcome! Click below to confirm your email and activate your membership.</p>
        <a href="${d.confirmation_url}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f3c675,#ec8b57);color:#0d1f28;font-weight:700;border-radius:8px;text-decoration:none;letter-spacing:0.05em;">Confirm Email</a>
        <p style="margin:24px 0 0;font-size:0.82rem;color:rgba(255,220,150,0.5);">If you didn't create an account, you can safely ignore this email.</p>
      </div>`,
  }),
  recovery: (d) => ({
    subject: "Reset your One Leg Up password",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a1923;color:#e0d4b8;padding:32px;border-radius:12px;">
        <h1 style="font-family:serif;color:#f3c675;margin:0 0 16px;">One Leg Up</h1>
        <p style="margin:0 0 24px;">Click below to reset your password. This link expires in 1 hour.</p>
        <a href="${d.confirmation_url}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f3c675,#ec8b57);color:#0d1f28;font-weight:700;border-radius:8px;text-decoration:none;letter-spacing:0.05em;">Reset Password</a>
        <p style="margin:24px 0 0;font-size:0.82rem;color:rgba(255,220,150,0.5);">If you didn't request this, you can safely ignore this email.</p>
      </div>`,
  }),
  magic_link: (d) => ({
    subject: "Your One Leg Up login link",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a1923;color:#e0d4b8;padding:32px;border-radius:12px;">
        <h1 style="font-family:serif;color:#f3c675;margin:0 0 16px;">One Leg Up</h1>
        <p style="margin:0 0 24px;">Here's your magic login link. It expires in 10 minutes.</p>
        <a href="${d.confirmation_url}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f3c675,#ec8b57);color:#0d1f28;font-weight:700;border-radius:8px;text-decoration:none;letter-spacing:0.05em;">Log In</a>
      </div>`,
  }),
  invite: (d) => ({
    subject: "You've been invited to One Leg Up",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a1923;color:#e0d4b8;padding:32px;border-radius:12px;">
        <h1 style="font-family:serif;color:#f3c675;margin:0 0 16px;">One Leg Up</h1>
        <p style="margin:0 0 24px;">You've been invited. Click below to accept and create your account.</p>
        <a href="${d.confirmation_url}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f3c675,#ec8b57);color:#0d1f28;font-weight:700;border-radius:8px;text-decoration:none;letter-spacing:0.05em;">Accept Invitation</a>
      </div>`,
  }),
};

Deno.serve(async (req: Request) => {
  const rawBody = await req.text();

  if (HOOK_SECRET) {
    const sig = req.headers.get("x-supabase-signature") ?? "";
    if (!verifySignature(rawBody, sig)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
  }

  let payload: { user: { email: string }; email_data: Record<string, string> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const { user, email_data } = payload;
  const templateKey = email_data?.email_action_type ?? "signup";
  const builder = TEMPLATES[templateKey] ?? TEMPLATES.signup;
  const { subject, html } = builder(email_data);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "One Leg Up <noreply@onelegup.club>",
      to: [user.email],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", err);
    return new Response(JSON.stringify({ error: "Email send failed" }), { status: 500 });
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
