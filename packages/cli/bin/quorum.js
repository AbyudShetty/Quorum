#!/usr/bin/env node
import { runAndExit } from '../dist/index.js';

await runAndExit(process.argv.slice(2));
