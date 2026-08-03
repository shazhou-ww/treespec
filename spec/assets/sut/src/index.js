#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.GREET_STATE_FILE || '/tmp/greet-state.json';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { name: null };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const args = process.argv.slice(2);

// --- Subcommand: init ---
if (args[0] === 'init') {
  saveState({ name: null });
  console.log(`greet state initialized at ${STATE_FILE}`);
  return;
}

// --- Subcommand: config set <key> <value> ---
if (args[0] === 'config' && args[1] === 'set') {
  const key = args[2];
  const value = args[3] ?? '';
  const state = loadState();
  state[key] = value;
  saveState(state);
  console.log(`greet config: ${key}=${value}`);
  return;
}

// --- Subcommand: config get <key> ---
if (args[0] === 'config' && args[1] === 'get') {
  const key = args[2];
  const state = loadState();
  console.log(state[key] ?? '');
  return;
}

// --- Subcommand: serve ---
if (args[0] === 'serve') {
  let port = 9876;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port') port = parseInt(args[++i], 10);
  }

  const state = loadState();
  const name = state.name || '';

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (name === '') {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'name is empty' }));
      return;
    }
    const greeting = name ? `Hello, ${name}!` : 'Hello, World!';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: greeting }));
  });

  server.listen(port, () => {
    console.log(`greet server listening on :${port} (name=${name || 'none'})`);
  });
  return;
}

// --- CLI mode: greet [--upper] [--name NAME] ---
// If --name is not given, read from state file.
let upper = false;
let nameOverride = null;
let hasNameOverride = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--upper') {
    upper = true;
  } else if (args[i] === '--name') {
    nameOverride = args[++i];
    hasNameOverride = true;
  }
}

const state = loadState();
const name = hasNameOverride ? nameOverride : state.name;

if (name === '') {
  console.error('Error: name cannot be empty');
  process.exit(1);
}

const greeting = name ? `Hello, ${name}!` : 'Hello, World!';
console.log(upper ? greeting.toUpperCase() : greeting);
