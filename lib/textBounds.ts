/** JavaScript offsets are UTF-16 units; a JSONB string must keep each pair intact. */
export function splitsSurrogatePair(text: string, end: number): boolean {
  const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** An exact prefix within the existing bound, without manufacturing a lone surrogate. */
export function unicodePrefix(text: string, maximum: number): string {
  const end = Math.min(text.length, maximum);
  return text.slice(0, splitsSurrogatePair(text, end) ? end - 1 : end);
}
