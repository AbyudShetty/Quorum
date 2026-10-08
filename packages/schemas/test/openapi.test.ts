import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/index.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const doc = JSON.parse(JSON.stringify(openApiDocument)) as { [key: string]: Json };

/** Every value of a given key anywhere in the document. */
const collect = (node: Json, key: string, out: string[] = []): string[] => {
  if (Array.isArray(node)) node.forEach((child) => collect(child, key, out));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key && typeof v === 'string') out.push(v);
      collect(v, key, out);
    }
  }
  return out;
};

/** Resolve a local JSON Pointer like "#/components/schemas/Common/$defs/workspaceId". */
const resolvePointer = (pointer: string): Json | undefined =>
  pointer
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<Json | undefined>(
      (node, part) =>
        node !== null && typeof node === 'object' && !Array.isArray(node) ? node[part] : undefined,
      doc,
    );

type Operation = {
  operationId: string;
  security: Json[];
  parameters?: { name: string; in: string }[];
  responses: Record<string, Json>;
};
const operations = Object.entries(doc.paths as Record<string, Record<string, Operation>>).flatMap(
  ([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })),
);

describe('OpenAPI /v1 document', () => {
  it('is OpenAPI 3.1 using JSON Schema 2020-12', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('resolves every reference', () => {
    const schemaIds = new Set(collect(doc.components as Json, '$id'));
    const unresolved = collect(doc, '$ref').filter((target) =>
      target.startsWith('#/')
        ? resolvePointer(target) === undefined
        : !schemaIds.has(target.split('#')[0] ?? ''),
    );
    expect(unresolved).toEqual([]);
  });

  it('has a unique operationId per operation', () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serves everything under /v1', () => {
    expect(operations.every(({ path }) => path.startsWith('/v1/'))).toBe(true);
  });

  it('declares every path parameter', () => {
    for (const { path, op } of operations) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
      expect(declared.sort(), path).toEqual(inPath.sort());
    }
  });

  it('states who may call each operation', () => {
    for (const { path, method, op } of operations) {
      expect(Array.isArray(op.security), `${method} ${path}`).toBe(true);
    }
  });

  it('only health, hello, token refresh and the local bootstrap exchange work without a token (INV-23)', () => {
    const open = operations
      .filter(({ op }) => op.security.length === 0)
      .map(({ op }) => op.operationId)
      .sort();
    expect(open).toEqual(['getHealth', 'hello', 'localBootstrap', 'refreshToken']);
  });

  it('keeps human-only operations away from agent tokens (INV-1, INV-13, INV-30)', () => {
    const humanOnly = operations
      .filter(({ op }) => JSON.stringify(op.security) === JSON.stringify([{ humanToken: [] }]))
      .map(({ op }) => op.operationId)
      .sort();
    expect(humanOnly).toEqual([
      'createAttachment',
      'createUiLink',
      'createWorkspace',
      'deleteAttachment',
      'exportEvents',
      'revokeAgent',
      'updateAttachment',
    ]);
  });

  it('uses the ErrorResponse shape for every error (MESSAGE_SPEC §6)', () => {
    const responses = (doc.components as { responses: Record<string, Json> }).responses;
    for (const [name, response] of Object.entries(responses)) {
      expect(JSON.stringify(response), name).toContain('#/components/schemas/ErrorResponse');
    }
    for (const { path, method, op } of operations) {
      const errors = Object.keys(op.responses).filter((status) => status.startsWith('4'));
      if (op.operationId !== 'getHealth')
        expect(errors.length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  it('matches the committed openapi.v1.json (run `npm run generate` after changing it)', () => {
    const committed: unknown = JSON.parse(
      readFileSync(new URL('../openapi.v1.json', import.meta.url), 'utf8'),
    );
    expect(committed).toEqual(doc);
  });
});
