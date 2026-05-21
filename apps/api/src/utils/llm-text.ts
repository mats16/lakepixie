export function cleanLlmTitle(rawTitle: string): string {
  let cleaned = rawTitle.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('`') && cleaned.endsWith('`'))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').trim();
}

export function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}
