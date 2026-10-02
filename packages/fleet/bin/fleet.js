#!/usr/bin/env node
import { runFleetCli } from '../dist/index.js';

process.exitCode = await runFleetCli(process.argv.slice(2));
