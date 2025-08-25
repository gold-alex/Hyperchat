#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

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
  'supabase.js',
  'pnl-service.js',
  'eip712-types.js',
  'links-config.js',
  'links-config-global.js',
  'icon-16.png',
  'icon-32.png',
  'icon-48.png',
  'icon-128.png'
];

// Environment variables to substitute
const envVars = {
  'process.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
  'process.env.SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
  'process.env.BACKEND_PORT': process.env.BACKEND_PORT
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

  fs.writeFileSync(path.join('dist', file), content);
  console.log(`✓ ${file}`);
});

console.log('\n✅ Build completed successfully!');
console.log('Environment variables used:');
Object.entries(envVars).forEach(([key, value]) => {
  const envKey = key.replace('process.env.', '');
  const displayValue = typeof value === 'string' && value.length > 50 ? value.substring(0, 47) + '...' : value;
  console.log(`  ${envKey}: ${displayValue}`);
});
