const HTML_ESCAPE_PATTERN = /[&<>"']/g;

const HTML_ESCAPE_LOOKUP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeUnsafeHtml(value) {
  return String(value ?? '').replace(HTML_ESCAPE_PATTERN, (char) => HTML_ESCAPE_LOOKUP[char] || char);
}

export function sanitizeRoomId(pair, market) {
  return `${escapeUnsafeHtml(pair)}_${escapeUnsafeHtml(market)}`;
}

export function sanitizeDisplayName(name, fallback) {
  if (name !== null && name !== undefined && String(name).length > 0) {
    return escapeUnsafeHtml(name);
  }
  return escapeUnsafeHtml(fallback);
}

export function buildSafeNameOptions(names, selectedName) {
  const selectedRaw = String(selectedName ?? '');
  if (!Array.isArray(names) || names.length === 0) {
    return '';
  }
  return names
    .map((name) => {
      const raw = String(name ?? '');
      const safe = escapeUnsafeHtml(raw);
      return `<option value="${safe}" ${raw === selectedRaw ? 'selected' : ''}>${safe}</option>`;
    })
    .join('');
}
