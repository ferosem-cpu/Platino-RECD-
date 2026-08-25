import nodemailer from "nodemailer";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !port || !user || !password) return null;

  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: { user, pass: password },
  });
  return transporter;
}

/**
 * Sends a real email via SMTP. Returns false (never throws) if SMTP isn't configured or the
 * send fails - callers log this as a failed notification rather than a hard error, since a
 * misconfigured mail server shouldn't break the request that triggered the notification.
 */
export async function sendEmail(args: { to: string; subject: string; text: string; html: string }): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.error("[email] SMTP not configured (SMTP_HOST/PORT/USER/PASSWORD) - email not sent");
    return false;
  }

  try {
    await t.sendMail({
      from: process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    return true;
  } catch (err) {
    console.error("[email] send failed", err);
    return false;
  }
}
