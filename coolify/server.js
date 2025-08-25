import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

// Load env
dotenv.config();

const {
  PORT = 3000,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  JWT_SECRET,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !JWT_SECRET) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_KEY, or JWT_SECRET in environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(cors());
app.use(express.json());

function createJwt(address) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: address.toLowerCase(),
      address: address.toLowerCase(),
      role: 'authenticated',
      iat: now,
      exp: now + 24 * 60 * 60, // 24h
    },
    JWT_SECRET,
  );
}

// Endpoint to authenticate wallet once and return JWT
app.post('/auth', async (req, res) => {
  try {
    const { address, signature, timestamp, typedData } = req.body;
    if (!address || !signature || !timestamp) {
      return res.status(400).json({ error: 'address, signature, timestamp required' });
    }

    // 2-minute freshness
    if (Math.abs(Date.now() - timestamp) > 2 * 60 * 1000) {
      return res.status(400).json({ error: 'stale timestamp' });
    }

    let recovered;
    
    if (typedData) {
      // EIP-712 typed data signature verification
      try {
        // Remove EIP712Domain from types for ethers v6
        const types = { ...typedData.types };
        delete types.EIP712Domain;
        
        recovered = ethers.verifyTypedData(
          typedData.domain,
          types,
          typedData.message,
          signature
        );
      } catch (err) {
        console.error('EIP-712 verification failed:', err);
        return res.status(400).json({ error: 'invalid typed data signature' });
      }
    } else {
      // Fallback to plain message signature
      const message = `HyperLiquidChat login ${timestamp}`;
      recovered = ethers.verifyMessage(message, signature);
    }
    
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(400).json({ error: 'signature mismatch' });
    }

    const token = createJwt(address);
    return res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'invalid auth request' });
  }
});

// Simple in-memory rate limiting: wallet => {count, firstTs}
const RATE_WINDOW_MS = 60 * 1000; // 1 min
const MAX_MSGS_PER_WINDOW = 30;
const rateMap = new Map();

function checkRateLimit(address) {
  const now = Date.now();
  let entry = rateMap.get(address);
  if (!entry || now - entry.firstTs > RATE_WINDOW_MS) {
    // reset window
    entry = { count: 0, firstTs: now };
  }
  entry.count += 1;
  rateMap.set(address, entry);
  return entry.count <= MAX_MSGS_PER_WINDOW;
}

// Nonce store to prevent replay (in-memory, clears older than TTL)
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 min
const nonceMap = new Map(); // nonce => ts
setInterval(() => {
  const now = Date.now();
  for (const [nonce, ts] of nonceMap.entries()) {
    if (now - ts > NONCE_TTL_MS) nonceMap.delete(nonce);
  }
}, 5 * 60 * 1000);

// Simple cache for name ownership checks
const nameCache = new Map(); // key -> ts when stored
const NAME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

async function ownsName(address, name) {
  if (!name) return true; // no name provided, nothing to verify
  const key = `${address.toLowerCase()}::${name.toLowerCase()}`;
  const now = Date.now();
  const cached = nameCache.get(key);
  if (cached && now - cached < NAME_CACHE_TTL_MS) return true;

  try {
    const resp = await fetch(`https://api.hlnames.xyz/utils/names_owner/${address}`, {
      headers: { 'X-API-Key': 'CPEPKMI-HUSUX6I-SE2DHEA-YYWFG5Y' }
    });
    if (!resp.ok) return false;
    const arr = await resp.json();
    const ok = Array.isArray(arr) && arr.some((x) => (x.name || '').toLowerCase() === name.toLowerCase());
    if (ok) nameCache.set(key, now);
    return ok;
  } catch (err) {
    console.error('HL name verify error', err);
    return false;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/message', async (req, res) => {
  try {
    const { signature, message, typedData, address: reqAddress, name, pair, market } = req.body;
    
    let msgObj, recovered;
    
    if (typedData) {
      // EIP-712 typed data format
      msgObj = {
        address: typedData.message.address || reqAddress,
        name: typedData.message.name || name,
        content: typedData.message.content,
        timestamp: Number(typedData.message.timestamp),
        pair: typedData.message.pair || pair,
        market: typedData.message.market || market,
        nonce: typedData.message.nonce,
        room: typedData.message.room
      };
      
      try {
        // Remove EIP712Domain from types for ethers v6
        const types = { ...typedData.types };
        delete types.EIP712Domain;
        
        recovered = ethers.verifyTypedData(
          typedData.domain,
          types,
          typedData.message,
          signature
        );
      } catch (err) {
        console.error('EIP-712 message verification failed:', err);
        return res.status(400).json({ error: 'invalid typed data signature' });
      }
    } else {
      // Legacy plain message format
      if (!message) {
        return res.status(400).json({ error: 'signature and message required' });
      }
      msgObj = JSON.parse(message);
      recovered = ethers.verifyMessage(message, signature);
    }
    
    const { address, room, nonce } = msgObj;
    if (!address || !msgObj.content || !msgObj.timestamp || !msgObj.pair || !msgObj.market || !nonce || !room) {
      return res.status(400).json({ error: 'invalid message fields' });
    }

    // Replay prevention: timestamp freshness 5 min
    if (Math.abs(Date.now() - msgObj.timestamp) > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'stale timestamp' });
    }

    // Nonce duplication
    if (nonceMap.has(nonce)) {
      return res.status(400).json({ error: 'nonce already used' });
    }

    // Verify signature recovers address
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(400).json({ error: 'signature mismatch' });
    }

    // Rate limit
    if (!checkRateLimit(address)) {
      return res.status(429).json({ error: 'rate limit exceeded' });
    }

    // Store nonce
    nonceMap.set(nonce, Date.now());

    // If name present, verify ownership
    if (name) {
      const hasName = await ownsName(address, name);
      if (!hasName) {
        return res.status(400).json({ error: 'name not owned by address' });
      }
    }

    // Insert into Supabase 'messages' table (assumes exists with RLS allow select)
    const { error: dbError } = await supabase
      .from('messages')
      .insert({ 
        room: msgObj.room || room,
        address: msgObj.address || address,
        name: msgObj.name || name,
        content: msgObj.content,
        timestamp: msgObj.timestamp,
        pair: msgObj.pair,
        market: msgObj.market
      });
    if (dbError) {
      console.error('Supabase insert error:', dbError);
      return res.status(500).json({ error: 'db insert failed' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'invalid request' });
  }
});

app.listen(PORT, () => {
  console.log(`Hyperliquid chat backend running on ${PORT}`);
}); 