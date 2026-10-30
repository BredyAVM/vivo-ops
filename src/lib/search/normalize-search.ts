export function normalizeSearchValue(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function splitSearchTokens(value: string | null | undefined) {
  return normalizeSearchValue(value).split(/\s+/).filter(Boolean);
}

export function normalizeRemoteSearchValue(value: string | null | undefined) {
  return normalizeSearchValue(value).replace(/[,%]/g, ' ').replace(/\s+/g, ' ').trim();
}
