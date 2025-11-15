#!/usr/bin/env node

/**
 * pbjs always emits `import * as $protobuf from "protobufjs/minimal";`
 * which fails at runtime inside the MV3 bundle since bare specifiers are
 * not resolvable via `chrome.runtime.getURL`. This small post-process
 * step rewrites the import to a local wrapper that loads the bundled
 * protobuf runtime from `lib/protobufjs/minimal.js`.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const filePath = resolve(process.cwd(), 'lib/chat-message.js');
const original = readFileSync(filePath, 'utf8');
const bareImport = 'import * as $protobuf from "protobufjs/minimal";';
const wrappedImport = 'import * as $protobuf from \'./protobuf-wrapper.js\';';

if (original.includes(wrappedImport)) {
  process.exit(0);
}

if (!original.includes(bareImport)) {
  console.error('postprocess-proto: expected protobuf import not found');
  process.exit(1);
}

const updated = original.replace(bareImport, wrappedImport);
writeFileSync(filePath, updated, 'utf8');
