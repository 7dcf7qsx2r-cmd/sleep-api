/** 大陆手机号 → E.164（+86138...） */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (/^1[3-9]\d{9}$/.test(digits)) return `+86${digits}`;
  if (/^86(1[3-9]\d{9})$/.test(digits)) return `+${digits}`;
  if (/^\+861[3-9]\d{9}$/.test(raw.trim())) return raw.trim();
  return null;
}

export function maskPhone(e164: string): string {
  const m = e164.match(/^\+86(1\d{2})(\d{4})(\d{4})$/);
  if (!m) return e164;
  return `+86${m[1]}****${m[3]}`;
}
