import nodemailer from "nodemailer";

export type Attachment = { filename: string; content: Buffer; contentType: string; cid?: string };

// fromName replaces the display name of EMAIL_FROM, so each shop signs its own mail.
export type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  fromName?: string;
  replyTo?: string;
  attachments?: Attachment[];
};

export function fromHeader(emailFrom: string | undefined, fromName?: string): string | undefined {
  if (!emailFrom || !fromName) return emailFrom;
  const address = emailFrom.match(/<([^>]+)>/)?.[1] ?? emailFrom.trim();
  return `"${fromName.replace(/["\r\n]/g, "")}" <${address}>`;
}

// Best effort: the order is already stored, so a mail failure never fails the
// payment flow. Without SMTP config, mails are only logged.
// Returns whether the mail was handed to the SMTP server.
export async function sendMail(mail: Mail): Promise<boolean> {
  const host = process.env.SMTP_HOST;
  if (!host) {
    console.info(`[mail] SMTP not configured, skipped: to=${mail.to} subject=${mail.subject}`);
    return false;
  }
  const port = Number(process.env.SMTP_PORT ?? 465);
  try {
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
    const { fromName, ...rest } = mail;
    const info = await transport.sendMail({ from: fromHeader(process.env.EMAIL_FROM, fromName), ...rest });
    console.info(`[mail] sent: subject=${mail.subject} id=${info.messageId}`);
    return true;
  } catch (err) {
    console.error("[mail] send failed", err);
    return false;
  }
}
