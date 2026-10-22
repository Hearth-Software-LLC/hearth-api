// Ember's privacy guard (implementation plan › Privacy, rule 5). The device de-identifies
// everything before sending (EmberRedactor); this checks again and refuses, before anything
// reaches Anthropic, a request whose text still looks like it carries an identifier. It fails
// closed: a false positive costs one answer, a miss would cost someone's privacy.

const patterns: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'email', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  // Card and account numbers: 9 to 19 digits, with optional spaces or dashes.
  { kind: 'number', pattern: /\b\d(?:[ -]?\d){8,18}\b/ },
  // Phone numbers: (801) 555-0134, 801.555.0134, +1 801 555 0134.
  { kind: 'phone', pattern: /(?:\+\d{1,3}[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/ },
  // Street addresses: a house number and a street word.
  { kind: 'address', pattern: /\b\d{1,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place|Cir|Circle|Pkwy|Parkway|Hwy|Highway)\b\.?/ },
  { kind: 'link', pattern: /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i },
];

/** The kinds of identifier found in `text`; empty when it's clean. */
export function findIdentifiers(text: string): string[] {
  return patterns.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind);
}
