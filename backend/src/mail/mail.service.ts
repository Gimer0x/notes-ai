import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';

export type SendSummaryMail = {
  to: string[];
  replyTo: string;
  subject: string;
  text: string;
  html: string;
};

@Injectable()
export class MailService {
  constructor(private readonly config: ConfigService) {}

  async sendSummary(input: SendSummaryMail): Promise<void> {
    const from = this.config.get<string>('MAIL_FROM')?.trim();
    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const portRaw = this.config.get<string>('SMTP_PORT')?.trim();
    const user = this.config.get<string>('SMTP_USER')?.trim();
    const pass = this.config.get<string>('SMTP_PASS')?.trim();
    if (!from || !host || !user || !pass) {
      throw new ServiceUnavailableException('mail_not_configured');
    }
    const port = Number(portRaw || '587');
    const transporter = nodemailer.createTransport({
      host,
      port: Number.isFinite(port) ? port : 587,
      secure: false,
      auth: { user, pass },
    });
    try {
      await transporter.sendMail({
        from,
        to: input.to.join(', '),
        replyTo: input.replyTo,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'mail_send_failed';
      throw new BadGatewayException(message);
    }
  }
}
