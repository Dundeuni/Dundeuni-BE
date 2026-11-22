import { normalizePhone } from './phone-analysis.dto';

/** Existing PHONE policy: retain only the two/three digit area prefix. */
export function maskPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s-]/g, '');
  if (
    /^(?:02\*{7,8}|01[016789]\*{7,8}|0(?:3[1-3]|4[1-4]|5[1-5]|6[1-4]|70)\*{7,8})$/.test(
      compact,
    )
  )
    return compact;
  try {
    const number = normalizePhone(value);
    const prefixLength = number.startsWith('02') ? 2 : 3;
    return (
      number.slice(0, prefixLength) + '*'.repeat(number.length - prefixLength)
    );
  } catch {
    return null;
  }
}

export function redactPhoneText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Defensive redaction for legacy provider-derived strings, before truncation.
  return Array.from(value.replace(/\d(?:[\s().+-]*\d){8,}/g, '[REDACTED]'))
    .slice(0, 2000)
    .join('');
}
