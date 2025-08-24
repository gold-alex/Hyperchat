#!/usr/bin/env node

/**
 * Test script to verify Waku node connectivity
 * Run with: node test-waku-node.js
 */

const WebSocket = require('ws');

const WAKU_NODE_IP = '10.0.0.58';
const WAKU_NODE_PORT = 8000;
const WAKU_NODE_PEER_ID = '16Uiu2HAmDiLTzSU7toieTmmL4VW579Mo13WCUdkaeCzWFAYQoVKF';

console.log('Testing Waku node connectivity...\n');

// Test 1: Basic WebSocket connection
console.log('Test 1: WebSocket connection to ws://' + WAKU_NODE_IP + ':' + WAKU_NODE_PORT);
const ws = new WebSocket(`ws://${WAKU_NODE_IP}:${WAKU_NODE_PORT}`);

ws.on('open', () => {
    console.log('✅ WebSocket connection established!');
    console.log('Sending test message...');
    ws.send('test');
});

ws.on('message', (data) => {
    console.log('📨 Received message:', data.toString());
});

ws.on('error', (error) => {
    console.log('❌ WebSocket error:', error.message);
    
    // Test 2: Try with different paths
    console.log('\nTest 2: Trying WebSocket with /ws path...');
    const ws2 = new WebSocket(`ws://${WAKU_NODE_IP}:${WAKU_NODE_PORT}/ws`);
    
    ws2.on('open', () => {
        console.log('✅ Connected with /ws path!');
        ws2.close();
    });
    
    ws2.on('error', (error2) => {
        console.log('❌ /ws path also failed:', error2.message);
        
        // Test 3: Try TCP connection
        console.log('\nTest 3: Trying raw TCP connection...');
        const net = require('net');
        const client = net.createConnection({ port: WAKU_NODE_PORT, host: WAKU_NODE_IP }, () => {
            console.log('✅ TCP connection established!');
            console.log('Note: Waku node is reachable via TCP but may not have WebSocket enabled.');
            client.end();
        });
        
        client.on('error', (error3) => {
            console.log('❌ TCP connection failed:', error3.message);
            console.log('\nSummary: The Waku node at ' + WAKU_NODE_IP + ':' + WAKU_NODE_PORT + ' is not reachable.');
            console.log('Possible issues:');
            console.log('  - Node is not running');
            console.log('  - Port ' + WAKU_NODE_PORT + ' is blocked by firewall');
            console.log('  - Node is only listening on localhost, not on network interface');
        });
    });
});

ws.on('close', () => {
    console.log('WebSocket connection closed');
});

// Also test HTTP endpoint if the node has one
console.log('\nTest 4: Checking for HTTP/REST API...');
const http = require('http');

const options = {
    hostname: WAKU_NODE_IP,
    port: WAKU_NODE_PORT,
    path: '/',
    method: 'GET',
    timeout: 5000
};

const req = http.request(options, (res) => {
    console.log(`✅ HTTP response: ${res.statusCode}`);
    res.on('data', (chunk) => {
        console.log('Response body:', chunk.toString());
    });
});

req.on('error', (error) => {
    console.log('❌ HTTP request failed:', error.message);
});

req.on('timeout', () => {
    console.log('❌ HTTP request timed out');
    req.destroy();
});

req.end();

// Test multiaddr format
console.log('\nTest 5: Multiaddr format test');
console.log('Full multiaddr that would be used:');
console.log(`  /ip4/${WAKU_NODE_IP}/tcp/${WAKU_NODE_PORT}/ws/p2p/${WAKU_NODE_PEER_ID}`);
console.log('\nIf the node requires different transport, try:');
console.log(`  /ip4/${WAKU_NODE_IP}/tcp/${WAKU_NODE_PORT}/p2p/${WAKU_NODE_PEER_ID} (without /ws for non-WebSocket)`);

setTimeout(() => {
    console.log('\n\nTest complete. Exiting...');
    process.exit(0);
}, 10000);