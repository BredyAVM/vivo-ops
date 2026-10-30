export type PhoneNormalizationResult = {
  raw: string;
  e164: string | null;
  digits: string;
  hasExplicitCountryCode: boolean;
  assumedCountryCode: string | null;
  isValid: boolean;
};

const DEFAULT_COUNTRY_CODE = '58';

function pickPhoneCandidate(raw: string) {
  const decoded = safeDecode(raw);
  const compactUrl = decoded.replace(/https?:\/\/(?:api\.)?whatsapp\.com\/send\?phone=/gi, ' ');
  const candidateText = compactUrl.replace(/https?:\/\/wa\.me\//gi, ' ');
  const candidates =
    candidateText.match(/(?:\+|00)?\d[\d\s().-]{5,}\d/g) ??
    [];

  if (candidates.length === 0) return candidateText;

  return candidates
    .map((candidate) => candidate.trim())
    .sort((a, b) => onlyDigits(b).length - onlyDigits(a).length)[0] ?? candidateText;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function onlyDigits(value: string) {
  return String(value || '').replace(/\D/g, '');
}

function toE164(digits: string, hasExplicitCountryCode: boolean, defaultCountryCode: string) {
  if (!digits) return null;

  if (hasExplicitCountryCode) {
    const withoutInternationalPrefix = digits.startsWith('00') ? digits.slice(2) : digits;
    return `+${withoutInternationalPrefix}`;
  }

  if (digits.startsWith(defaultCountryCode) && digits.length >= 11) {
    return `+${digits}`;
  }

  if (defaultCountryCode === DEFAULT_COUNTRY_CODE) {
    if (digits.startsWith('0') && digits.length >= 10) {
      return `+${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
    }

    if (digits.length >= 9 && digits.length <= 10) {
      return `+${DEFAULT_COUNTRY_CODE}${digits}`;
    }
  }

  return null;
}

export function normalizePhoneDetailed(
  raw: string | null | undefined,
  options: { defaultCountryCode?: string } = {}
): PhoneNormalizationResult {
  const original = String(raw || '').trim();
  const candidate = pickPhoneCandidate(original);
  const defaultCountryCode = onlyDigits(options.defaultCountryCode || DEFAULT_COUNTRY_CODE) || DEFAULT_COUNTRY_CODE;
  const hasExplicitCountryCode = /^\s*(?:\+|00)/.test(candidate);
  const digits = onlyDigits(candidate);
  const e164 = toE164(digits, hasExplicitCountryCode, defaultCountryCode);
  const isValid = !!e164 && /^\+[1-9]\d{6,14}$/.test(e164);

  return {
    raw: original,
    e164: isValid ? e164 : null,
    digits,
    hasExplicitCountryCode,
    assumedCountryCode: hasExplicitCountryCode || !isValid ? null : defaultCountryCode,
    isValid,
  };
}

export function normalizePhone(raw: string | null | undefined) {
  return normalizePhoneDetailed(raw).e164 ?? '';
}

export function getPhoneSearchTerms(raw: string | null | undefined) {
  const result = normalizePhoneDetailed(raw);
  const terms = new Set<string>();
  const rawText = String(raw || '').trim();
  const rawDigits = onlyDigits(rawText);

  if (rawText) terms.add(rawText);
  if (rawDigits) terms.add(rawDigits);
  if (result.e164) {
    const e164Digits = onlyDigits(result.e164);
    terms.add(result.e164);
    terms.add(e164Digits);

    if (result.e164.startsWith(`+${DEFAULT_COUNTRY_CODE}`)) {
      const national = e164Digits.slice(DEFAULT_COUNTRY_CODE.length);
      if (national) {
        terms.add(national);
        terms.add(`0${national}`);
      }
    }
  }

  return Array.from(terms)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

