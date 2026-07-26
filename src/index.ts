#!/usr/bin/env node
/**
 * treespec — CLI entry point
 */

import { runCli } from './cli.js';

const code = await runCli(process.argv);
process.exit(code);
