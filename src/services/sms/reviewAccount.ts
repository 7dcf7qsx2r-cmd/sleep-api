import { config } from '../../config.js';
import { normalizePhone } from '../../lib/phone.js';

export function isReviewSmsEnabled(): boolean {
  return config.sms.reviewPhones.length > 0 && /^\d{6}$/.test(config.sms.reviewCode);
}

export function isReviewSmsPhone(phone: string): boolean {
  if (!isReviewSmsEnabled()) return false;
  const normalized = normalizePhone(phone) ?? phone.trim();
  return config.sms.reviewPhones.includes(normalized);
}

export function matchesReviewSmsCode(phone: string, code: string): boolean {
  return isReviewSmsPhone(phone) && code.trim() === config.sms.reviewCode;
}
