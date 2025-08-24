#!/usr/bin/env node

const WebSocket = require('ws');

const WAKU_NODE_IP = '10.0.0.58';
const WAKU_NODE_PORT = 8000;

console.log('Testing Waku node protocol support...\n');

const ws = new WebSocket(`ws://${WAKU_NODE_IP}:${WAKU_NODE_PORT}`);

ws.on('open', () => {
    console.log('✅ WebSocket connected');
    
    // Try sending a multistream-select protocol negotiation
    // This is what libp2p does under the hood
    const multistream = '/multistream/1.0.0\n';
    console.log('Sending multistream-select:', multistream.trim());
    ws.send(multistream);
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
    
    // If we get a multistream response, try listing protocols
    if (data.toString().includes('/multistream/1.0.0')) {
        console.log('Multistream supported! Requesting protocol list...');
        ws.send('ls\n');
    }
});

ws.on('error', (error) => {
    console.log('❌ Error:', error.message);
});

ws.on('close', () => {
    console.log('Connection closed');
});

setTimeout(() => {
    ws.close();
    process.exit(0);
}, 5000);