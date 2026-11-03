// Optional SMTP email (password resets). When SMTP is not configured, admins issue reset links instead.
import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport = null;
export const mailEnabled = () => !!config.smtp.host;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined
    });
  }
  return transport;
}

export async function sendMail({ to, subject, text }) {
  if (!mailEnabled()) return false;
  try {
    await getTransport().sendMail({ from: config.smtp.from, to, subject, text });
    return true;
  } catch (err) {
    console.error('mail: send failed:', err.message);
    return false;
  }
}

export function resetLink(token) {
  return `${config.baseUrl || ''}/#/reset-password?token=${encodeURIComponent(token)}`;
}
