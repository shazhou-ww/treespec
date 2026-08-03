#!/usr/bin/env node

const http = require('http');
const { URL } = require('url');

const args = process.argv.slice(2);

// Subcommand: serve — start HTTP server
if (args[0] === 'serve') {
  let port = 9876;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port') port = parseInt(args[++i], 10);
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    const url = new URL(req.url, `http://localhost:${port}`);
    const name = url.searchParams.get('name') || '';
    const greeting = name ? `Hello, ${name}!` : 'Hello, World!';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: greeting }));
  });

  server.listen(port, () => {
    console.log(`greet server listening on :${port}`);
  });
  return;
}

// CLI mode: greet [--upper] [--name NAME]
let upper = false;
let name = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--upper') {
    upper = true;
  } else if (args[i] === '--name') {
    name = args[++i];
  }
}

if (name === '') {
  console.error('Error: name cannot be empty');
  process.exit(1);
}

const greeting = name ? `Hello, ${name}!` : 'Hello, World!';
console.log(upper ? greeting.toUpperCase() : greeting);
