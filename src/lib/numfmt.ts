/**
 * Number formats.
 *
 * The Sheets API rejects a pattern whose declared type does not match it, so a
 * literal pattern gets its type inferred from the tokens Sheets itself uses.
 * Shorthands exist because "currency" is what a person means and
 * '"$"#,##0.00' is what the API wants.
 */

export interface NumberFormat {
  type: string;
  pattern: string;
}

const NUMBER_FORMAT_SHORTHAND: Record<string, NumberFormat> = {
  currency: { type: "CURRENCY", pattern: '"$"#,##0.00' },
  currency0: { type: "CURRENCY", pattern: '"$"#,##0' },
  accounting: { type: "CURRENCY", pattern: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_)' },
  percent: { type: "PERCENT", pattern: "0.00%" },
  percent0: { type: "PERCENT", pattern: "0%" },
  date: { type: "DATE", pattern: "yyyy-mm-dd" },
  datetime: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm" },
  time: { type: "TIME", pattern: "hh:mm:ss" },
  duration: { type: "TIME", pattern: "[h]:mm:ss" },
  integer: { type: "NUMBER", pattern: "#,##0" },
  number: { type: "NUMBER", pattern: "#,##0.00" },
  text: { type: "TEXT", pattern: "@" },
};

export const NUMBER_FORMAT_SHORTHANDS = Object.keys(NUMBER_FORMAT_SHORTHAND).sort();

/**
 * Turn either a shorthand name or a literal pattern into a NumberFormat.
 */
export function resolveNumberFormat(spec: string): NumberFormat {
  if (typeof spec !== "string" || !spec.trim()) {
    throw new Error(`Could not parse number format: ${JSON.stringify(spec)}`);
  }
  const raw = spec.trim();
  const short = NUMBER_FORMAT_SHORTHAND[raw.toLowerCase().replace(/[\s_-]/g, "")];
  if (short) return { ...short };

  // Literal pattern. Infer the type from the tokens Sheets uses.
  const withoutLiterals = raw.replace(/"[^"]*"/g, "");
  const hasDate = /[yd]/i.test(withoutLiterals) || /mmm/i.test(withoutLiterals);
  const hasClock = /(^|[^m])(h{1,2}|s{1,2})([^m]|$)/i.test(withoutLiterals) || /\[h\]/i.test(raw);
  if (raw === "@" || /@/.test(withoutLiterals)) return { type: "TEXT", pattern: raw };
  if (hasDate && hasClock) return { type: "DATE_TIME", pattern: raw };
  if (hasDate) return { type: "DATE", pattern: raw };
  if (hasClock) return { type: "TIME", pattern: raw };
  if (/%/.test(withoutLiterals)) return { type: "PERCENT", pattern: raw };
  if (/[$£€¥]/.test(raw)) return { type: "CURRENCY", pattern: raw };
  return { type: "NUMBER", pattern: raw };
}

/**
 * The reverse, for describing a sheet we just read: name the shorthand when a
 * format matches one, so `sheets_open` can report "currency" rather than a
 * pattern the reader has to decode.
 */
export function describeNumberFormat(
  format: { type?: string | null; pattern?: string | null } | null | undefined,
): string | undefined {
  if (!format) return undefined;
  const pattern = format.pattern ?? "";
  const type = format.type ?? "";
  if (!pattern && !type) return undefined;
  for (const [name, known] of Object.entries(NUMBER_FORMAT_SHORTHAND)) {
    if (known.pattern === pattern && known.type === type) return name;
  }
  return pattern || type.toLowerCase();
}
