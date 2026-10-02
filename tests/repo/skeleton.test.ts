// Repository hygiene checks. These guard Phase 0 deliverables and the
// "every change ships with docs and a changelog" rule; they contain no product logic.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const requiredFiles = [
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  '.github/SECURITY.md',
  '.github/CONTRIBUTING.md',
  'AGENTS.md',
  '.claude/CLAUDE.md',
  'docs/QUORUM_PLAN.md',
  'docs/ARCHITECTURE.md',
  'docs/MESSAGE_SPEC.md',
  'docs/POLICY_SPEC.md',
  'docs/THREAT_MODEL.md',
  'docs/PRIOR_ART.md',
  'docs/DECISIONS.md',
  'docs/PHASE_0.md',
  'docs/TEAM_PLAN.md',
  'docs/interviews/README.md',
  'docs/interviews/TEMPLATE.md',
];

describe('repository skeleton', () => {
  it.each(requiredFiles)('has %s', (path) => {
    expect(existsSync(join(root, path))).toBe(true);
  });

  it('is licensed under Apache-2.0', () => {
    expect(read('LICENSE')).toContain('Apache License');
    expect(read('LICENSE')).toContain('Version 2.0, January 2004');
    expect(JSON.parse(read('package.json'))).toMatchObject({ license: 'Apache-2.0' });
  });

  it('keeps an Unreleased section in the changelog', () => {
    expect(read('CHANGELOG.md')).toMatch(/^## \[Unreleased\]$/m);
  });

  it('carries the agent rules from the plan in AGENTS.md', () => {
    const agents = read('AGENTS.md');
    expect(agents).toContain('Follow the phase order');
    expect(agents).toContain('Never weaken a security property');
  });

  it('numbers security invariants INV-1..INV-n without gaps or duplicates', () => {
    const numbers = [...read('docs/THREAT_MODEL.md').matchAll(/^\| INV-(\d+)\s+\|/gm)].map((m) =>
      Number(m[1]),
    );
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});
