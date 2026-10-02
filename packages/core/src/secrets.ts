// Secret scanning for message bodies and artifact metadata (INV-14).
// Only high-confidence patterns: a false positive blocks a legitimate message, so each pattern
// matches a documented, prefixed credential format. Findings name the field and the kind of
// secret, never the value.

export interface SecretFinding {
  /** JSON Pointer to the string that contains the secret. */
  path: string;
  /** What it looks like, e.g. "GitHub token". */
  kind: string;
}

const PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'private key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { kind: 'Quorum token', pattern: /\bqrm_(?:at|rt|jc)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    kind: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { kind: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}/ },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: 'Hugging Face token', pattern: /\bhf_[A-Za-z0-9]{34,}\b/ },
];

const pointer = (path: string, key: string | number): string =>
  `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

const kindOf = (text: string): string | undefined => {
  // An Anthropic key also looks like a generic "sk-" key; report the more specific one.
  for (const { kind, pattern } of PATTERNS) if (pattern.test(text)) return kind;
  return undefined;
};

/** Every string in `value` (including object keys) that contains a known secret format. */
export const findSecrets = (value: unknown, path = ''): SecretFinding[] => {
  if (typeof value === 'string') {
    const kind = kindOf(value);
    return kind ? [{ path, kind }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => findSecrets(item, pointer(path, i)));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      const inKey = kindOf(key);
      return [
        ...(inKey ? [{ path: pointer(path, key), kind: inKey }] : []),
        ...findSecrets(item, pointer(path, key)),
      ];
    });
  }
  return [];
};
