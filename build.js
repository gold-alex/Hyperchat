#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load environment variables
require('dotenv').config();

// Check for .env file
if (!fs.existsSync('.env')) {
  console.warn('\n⚠️  No .env file found. Using default configuration values.');
  console.warn('   See WAKU_CONFIG.md for instructions on how to configure Waku.\n');
}

// --- SCRIPT EXECUTION ---

// 1. Run the protobuf compiler first.
console.log('Compiling protobuf definition...');
try {
  // This command correctly generates `lib/chat-message.js` but with the wrong import path.
  execSync('pnpm build:proto', { stdio: 'inherit' });
  console.log('✅ Protobuf compilation successful.');
} catch (error) {
  console.error('❌ Protobuf compilation failed:', error);
  process.exit(1);
}

// 2. Patch the generated file to fix the import path.
console.log('Patching generated protobuf module for browser compatibility...');
const protoJsPath = path.join(__dirname, 'lib/chat-message.js');
let protoJsContent = fs.readFileSync(protoJsPath, 'utf8');
protoJsContent = protoJsContent.replace(
  'import * as $protobuf from "protobufjs/minimal";',          // <-- This is what pbjs generates
  'import * as $protobuf from "./protobuf-wrapper.js";' // <-- Use our wrapper
);
fs.writeFileSync(protoJsPath, protoJsContent);
console.log('✅ Patched protobuf module successfully.');


const sourceFiles = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.js',
  'chat-widget.html',
  'chat-widget.js',
  'sidepanel.html',
  'sidepanel.js',
  'wallet-bridge.js',
  'content.css',
  'content.js',
  // 'supabase.js', // No longer needed with Waku
  'lib/waku-chat-client.js',
  'lib/js-waku.min.js',
  'lib/protobufjs/minimal.js',
  'lib/protobuf-wrapper.js',
  'lib/chat-message.js',
  'lib/chat-message.proto',
];

// Environment variables to substitute
const envVars = {
  'process.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
  'process.env.SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
  'process.env.BACKEND_PORT': process.env.BACKEND_PORT,
  'process.env.WAKU_NODE_URI': JSON.stringify(process.env.WAKU_NODE_URI || 'localhost'),
  'process.env.WAKU_NODE_PORT': process.env.WAKU_NODE_PORT || 443,
  'process.env.WAKU_NODE_PEER_ID': JSON.stringify(process.env.WAKU_NODE_PEER_ID || 'PEER_ID')
};

// Clean and create dist directory
if (fs.existsSync('dist')) {
  fs.rmSync('dist', { recursive: true });
}
fs.mkdirSync('dist');

console.log('Building extension with environment variables...');

sourceFiles.forEach(file => {
  if (!fs.existsSync(file)) {
    console.warn(`Warning: ${file} not found, skipping...`);
    return;
  }

  let content = fs.readFileSync(file, 'utf8');

  // Only process JS files for environment variable substitution
  if (file.endsWith('.js')) {
    Object.entries(envVars).forEach(([envVar, value]) => {
      // Replace process.env.VAR_NAME with actual values
      content = content.replace(new RegExp(envVar.replace('.', '\\.'), 'g'), value);
    });
  }

  // Create subdirectories if needed
  const destPath = path.join('dist', file);
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  fs.writeFileSync(destPath, content);
  console.log(`✓ ${file}`);
});

console.log('\n✅ Build completed successfully!');
console.log('Environment variables used:');

// Group variables by type
const supabaseVars = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'BACKEND_PORT'];
const wakuVars = ['WAKU_NODE_URL', 'WAKU_NODE_PORT', 'WAKU_NODE_PEER_ID'];

// Display Supabase variables (legacy)
console.log('\n  Supabase Configuration (Legacy):');
supabaseVars.forEach(envKey => {
  const key = `process.env.${envKey}`;
  const value = envVars[key];
  const displayValue = typeof value === 'string' && value.length > 50 ? value.substring(0, 47) + '...' : value;
  console.log(`    ${envKey}: ${displayValue}`);
});

// Display Waku variables
console.log('\n  Waku Configuration:');
wakuVars.forEach(envKey => {
  const key = `process.env.${envKey}`;
  const value = envVars[key];
  const displayValue = typeof value === 'string' && value.length > 50 ? value.substring(0, 47) + '...' : value;
  console.log(`    ${envKey}: ${displayValue}`);
});
