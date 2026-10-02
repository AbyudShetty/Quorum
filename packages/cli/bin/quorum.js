#!/usr/bin/env node
import { runFromProcess } from '../dist/index.js';

process.exitCode = await runFromProcess(process.argv.slice(2));
