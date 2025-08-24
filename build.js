#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Check for .env file
if (!fs.existsSync('.env')) {
  console.warn('\n⚠️  No .env file found. Using default configuration values.');
  console.warn('   See WAKU_CONFIG.md for instructions on how to configure Waku.\n');
}

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
  // 'supabase.js', // Commented out - no longer needed with Waku
  'lib/waku-chat-client.js',
  'lib/js-waku.min.js',
  'lib/protobuf.js',
  'lib/chat-message.proto',
];

// Environment variables to substitute
const envVars = {
  'process.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
  'process.env.SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
  'process.env.BACKEND_PORT': process.env.BACKEND_PORT,
  'process.env.WAKU_NODE_IP': JSON.stringify(process.env.WAKU_NODE_IP || '10.0.0.5'),
  'process.env.WAKU_NODE_PORT': process.env.WAKU_NODE_PORT || 60000,
  'process.env.WAKU_NODE_PEER_ID': JSON.stringify(process.env.WAKU_NODE_PEER_ID || '16Uiu2HAm4v86W3bmT1BiH6oSPzcsSr24iDQpSN5Qa992BCjjwgrD')
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
const wakuVars = ['WAKU_NODE_IP', 'WAKU_NODE_PORT', 'WAKU_NODE_PEER_ID'];

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
