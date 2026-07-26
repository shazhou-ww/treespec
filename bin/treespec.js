#!/usr/bin/env -S node --
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '..', 'src', 'index.ts');

// Pass `--` so Node/tsx does not consume CLI flags like `--env-file`.
const child = spawn('npx', ['tsx', '--', entry, ...process.argv.slice(2)], {
	stdio: 'inherit',
});

child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
