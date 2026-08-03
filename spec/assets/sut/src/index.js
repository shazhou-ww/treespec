#!/usr/bin/env node

const args = process.argv.slice(2);

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
