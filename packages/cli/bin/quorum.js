#!/usr/bin/env node
import { runtimeError } from './runtime.js';

const error = runtimeError(process.versions.node, process.versions.napi);
if (error) {
  console.error(error);
  process.exitCode = 1;
} else {
  const { runAndExit } = await import('../dist/index.js');
  await runAndExit(process.argv.slice(2));
}
