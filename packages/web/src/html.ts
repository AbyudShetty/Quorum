// A tiny auto-escaping HTML template (ARCHITECTURE §7: "contextual auto-escaping templates").
// Every interpolated value is escaped unless it is already `Safe` (the result of another `html`
// call or `raw`). Message content is hostile by definition, so it never goes through `raw`.
// Convention that keeps attribute contexts safe: always put interpolations inside double quotes.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);

/** Markup that is already safe to emit as is. */
export class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Mark a string as trusted markup. Only for constants written in this repo, never for message data. */
export const raw = (value: string): Safe => new Safe(value);

type Interpolation = Safe | string | number | boolean | null | undefined | readonly Interpolation[];

const render = (value: Interpolation): string => {
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return (value as readonly Interpolation[]).map(render).join('');
  if (value === null || value === undefined || value === false || value === true) return '';
  return escapeHtml(String(value));
};

export const html = (strings: TemplateStringsArray, ...values: Interpolation[]): Safe => {
  let out = '';
  strings.forEach((chunk, i) => {
    out += chunk;
    if (i < values.length) out += render(values[i]);
  });
  return new Safe(out);
};
