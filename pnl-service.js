// P&L Service for calculating user's all-time P&L for specific trading pairs
// Based on Hyperliquid API - handles both Perps and Spot markets

class PnLService {
  constructor() {
    this.API = "https://api.hyperliquid.xyz/info";
    this.cache = new Map();
    this.cacheExpiry = 60000; // 1 minute cache
    this.EPOCH_START_MS = Date.UTC(2019, 0, 1); // Hyperliquid start
  }

  // HTTP helper
  async post(body) {
    try {
      const res = await fetch(this.API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error(`API ${res.status}: ${txt}`);
        return null;
      }
      return res.json();
    } catch (error) {
      console.error("P&L API request failed:", error);
      return null;
    }
  }

  // Utility functions
  toNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  }

  nowMs() {
    return Date.now();
  }

  // Normalize address format
  normalizeAddress(address) {
    return address.toLowerCase().startsWith('0x') ? 
           address.toLowerCase() : 
           `0x${address.toLowerCase()}`;
  }

  // Extract coin from pair format (HYPE-USD -> HYPE, BTC -> BTC)
  extractCoinFromPair(pair) {
    if (!pair) return null;
    // Handle various formats: BTC-USD, BTC-PERP, BTC, etc.
    const parts = pair.split('-');
    return parts[0].toUpperCase();
  }

  // Check if fill is for spot market
  isSpotFill(fill) {
    const c = fill.coin;
    return typeof c === "string" && (c.includes("/") || c.startsWith("@"));
  }

  // Calculate fee in USDC
  feeUsdc(fill) {
    return fill.feeToken === "USDC" ? this.toNum(fill.fee) : 0;
  }

  // Fetch all fills (trades) for a user - single call for all time
  async fetchAllFillsByTime(user) {
    const normalizedUser = this.normalizeAddress(user);
    
    // Single API call for all-time fills
    const fills = await this.post({
      type: "userFillsByTime",
      user: normalizedUser,
      startTime: 0, // From beginning
      endTime: Date.now() * 2, // Far future to get everything
      aggregateByTime: true,
    });
    
    return Array.isArray(fills) ? fills : [];
  }

  // Fetch all funding payments for a user - single call for all time
  async fetchAllFunding(user) {
    const normalizedUser = this.normalizeAddress(user);
    
    // Single API call for all-time funding
    const funding = await this.post({
      type: "userFunding",
      user: normalizedUser,
      startTime: 0, // From beginning
      endTime: Date.now() * 2, // Far future to get everything
    });
    
    const map = new Map(); // coin -> usdc sum
    
    if (Array.isArray(funding)) {
      for (const e of funding) {
        const d = e?.delta;
        if (!d || d.type !== "funding") continue;
        const coin = d.coin;
        const amt = this.toNum(d.usdc);
        map.set(coin, (map.get(coin) || 0) + amt);
      }
    }
    
    return map;
  }

  // Get current unrealized P&L for perps positions
  async getPerpUnrealizedMap(user) {
    const normalizedUser = this.normalizeAddress(user);
    const st = await this.post({ 
      type: "clearinghouseState", 
      user: normalizedUser 
    });
    
    const positions = Array.isArray(st?.assetPositions) ? st.assetPositions : [];
    const m = new Map();
    
    for (const p of positions) {
      const pos = p?.position;
      if (!pos) continue;
      const coin = pos.coin;
      const u = this.toNum(pos.unrealizedPnl);
      if (Math.abs(u) > 0) {
        m.set(coin, u);
      }
    }
    
    return m;
  }

  // Get spot market metadata and contexts
  async getSpotMetaAndCtxs() {
    const resp = await this.post({ type: "spotMetaAndAssetCtxs" });
    const [spotMeta, assetCtxs] = resp || [];
    return { 
      spotMeta, 
      assetCtxs: Array.isArray(assetCtxs) ? assetCtxs : [] 
    };
  }

  // Get spot balances for a user
  async getSpotBalances(user) {
    const normalizedUser = this.normalizeAddress(user);
    const st = await this.post({ 
      type: "spotClearinghouseState", 
      user: normalizedUser 
    });
    return Array.isArray(st?.balances) ? st.balances : [];
  }

  // Build lookup maps for spot trading
  buildSpotLookup(spotMeta, assetCtxs) {
    const tokenIndexToName = new Map();
    const pairIndexToInfo = new Map();
    
    for (const t of spotMeta?.tokens || []) {
      tokenIndexToName.set(t.index, t.name);
    }
    
    const uni = spotMeta?.universe || [];
    for (let i = 0; i < uni.length; i++) {
      const pair = uni[i];
      const name = pair.name;
      const baseTokenIndex = pair.tokens?.[0];
      const markPx = this.toNum(assetCtxs?.[i]?.markPx ?? assetCtxs?.[i]?.midPx);
      pairIndexToInfo.set(pair.index, { name, baseTokenIndex, markPx });
    }
    
    return { tokenIndexToName, pairIndexToInfo };
  }

  // Calculate P&L for Perps by pair
  async calculatePerpsPnLByPair(user) {
    // Fetch data sequentially to avoid rate limiting
    const fills = await this.fetchAllFillsByTime(user);
    const fundingMap = await this.fetchAllFunding(user);
    const unrealizedMap = await this.getPerpUnrealizedMap(user);

    // Aggregate realized P&L per coin
    const agg = new Map(); // coin -> { trades, fees, funding }
    
    for (const f of fills) {
      if (this.isSpotFill(f)) continue; // perps only
      const coin = f.coin;
      const entry = agg.get(coin) || { trades: 0, fees: 0, funding: 0 };
      entry.trades += this.toNum(f.closedPnl);
      entry.fees -= this.feeUsdc(f); // subtract fees
      entry.fees -= this.toNum(f.builderFee || 0); // subtract builder fees
      agg.set(coin, entry);
    }
    
    // Add funding payments
    for (const [coin, amt] of fundingMap.entries()) {
      const entry = agg.get(coin) || { trades: 0, fees: 0, funding: 0 };
      entry.funding += amt;
      agg.set(coin, entry);
    }

    // Build results by coin
    const perPair = [];
    const coinSet = new Set([...agg.keys(), ...unrealizedMap.keys()]);
    
    for (const coin of coinSet) {
      const e = agg.get(coin) || { trades: 0, fees: 0, funding: 0 };
      const realized = e.trades + e.funding + e.fees;
      const unrealized = this.toNum(unrealizedMap.get(coin) || 0);
      
      perPair.push({
        pair: coin, // Just the coin symbol for perps
        realized,
        unrealized,
        total: realized + unrealized,
        realizedBreakdown: { 
          trades: e.trades, 
          funding: e.funding, 
          fees: e.fees 
        },
      });
    }

    return perPair;
  }

  // Calculate P&L for Spot by pair
  async calculateSpotPnLByPair(user) {
    // Fetch data sequentially to avoid rate limiting
    const fills = await this.fetchAllFillsByTime(user);
    const balances = await this.getSpotBalances(user);
    const metaCtx = await this.getSpotMetaAndCtxs();
    
    const { tokenIndexToName, pairIndexToInfo } = this.buildSpotLookup(
      metaCtx.spotMeta, 
      metaCtx.assetCtxs
    );

    // Realized P&L by pair from fills
    const realizedByPair = new Map();
    for (const f of fills) {
      if (!this.isSpotFill(f)) continue; // spot only
      const pair = f.coin;
      const realized = this.toNum(f.closedPnl) - this.feeUsdc(f);
      realizedByPair.set(pair, (realizedByPair.get(pair) || 0) + realized);
    }

    // Unrealized P&L from current balances
    const perPair = [];
    const baseIdxToPair = new Map();
    
    for (const [, info] of pairIndexToInfo.entries()) {
      baseIdxToPair.set(info.baseTokenIndex, { 
        name: info.name, 
        markPx: info.markPx 
      });
    }

    for (const b of balances) {
      const tokenIdx = b.token;
      const qty = this.toNum(b.total);
      const cost = this.toNum(b.entryNtl);
      if (qty === 0 && cost === 0) continue;

      const baseName = tokenIndexToName.get(tokenIdx) || `@${tokenIdx}`;
      const pairInfo = baseIdxToPair.get(tokenIdx);
      if (!pairInfo) continue;

      const pairLabel = pairInfo.name || `${baseName}/USDC`;
      const mark = this.toNum(pairInfo.markPx);
      const mktVal = qty * mark;
      const unreal = mktVal - cost;
      const realized = realizedByPair.get(pairLabel) || 0;

      // Extract base coin from pair label (e.g., "PURR/USDC" -> "PURR")
      const coin = pairLabel.split('/')[0];
      
      perPair.push({
        pair: coin,
        realized,
        unrealized: unreal,
        total: realized + unreal,
        qty,
        costBasis: cost,
      });

      realizedByPair.delete(pairLabel);
    }

    // Include realized-only pairs (fully exited positions)
    for (const [pair, realized] of realizedByPair.entries()) {
      const coin = pair.split('/')[0];
      perPair.push({
        pair: coin,
        realized,
        unrealized: 0,
        total: realized,
        qty: 0,
        costBasis: 0,
      });
    }

    return perPair;
  }

  // Main function to get P&L for a specific pair and market
  async calculatePnLForPair(address, requestedPair, market = 'Perps') {
    const coin = this.extractCoinFromPair(requestedPair);
    if (!coin) {
      console.warn(`Invalid pair format: ${requestedPair}`);
      return 0;
    }

    // Check cache
    const cacheKey = `${address.toLowerCase()}_${coin}_${market}`;
    const cached = this.cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < this.cacheExpiry)) {
      console.log(`Using cached P&L for ${coin}`);
      return cached.value;
    }

    console.log(`Calculating ${market} P&L for ${address} on ${coin}`);

    try {
      let pnlData;
      
      if (market === 'Spot') {
        pnlData = await this.calculateSpotPnLByPair(address);
      } else {
        pnlData = await this.calculatePerpsPnLByPair(address);
      }

      // Find the specific coin's P&L
      const pairData = pnlData.find(p => p.pair === coin);
      const totalPnl = pairData ? pairData.total : 0;

      // Cache the result
      this.cache.set(cacheKey, {
        value: totalPnl,
        timestamp: Date.now()
      });

      console.log(`${market} P&L for ${coin}:`, {
        realized: pairData?.realized || 0,
        unrealized: pairData?.unrealized || 0,
        total: totalPnl
      });

      return totalPnl;
      
    } catch (error) {
      console.error(`Error calculating ${market} P&L for ${coin}:`, error);
      return 0;
    }
  }

  // Format P&L for display
  formatPnL(value) {
    if (value === null || value === undefined || isNaN(value)) return null;
    
    const absValue = Math.abs(value);
    let formatted;
    
    if (absValue === 0) {
      formatted = "0";
    } else if (absValue < 1) {
      formatted = value.toFixed(2).replace(/\.?0+$/, '');
    } else if (absValue >= 1000000) {
      formatted = `${(value / 1000000).toFixed(2)}M`;
    } else if (absValue >= 1000) {
      formatted = `${(value / 1000).toFixed(1)}K`;
    } else {
      formatted = value.toFixed(2).replace(/\.?0+$/, '');
    }
    
    const sign = value > 0 ? "+" : "";
    // Use neutral gray for $0, green for positive, red for negative
    const color = absValue === 0 ? "#9ca3af" : (value > 0 ? "#4ade80" : "#f87171");
    
    return {
      text: `${sign}$${formatted}`,
      color: color,
      raw: value,
      isPositive: value >= 0,
      isZero: absValue === 0
    };
  }

  // Public API
  async getPnLDisplay(address, pair, market = 'Perps') {
    const pnl = await this.calculatePnLForPair(address, pair, market);
    return this.formatPnL(pnl);
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
  }
}

// Export for Chrome extension
if (typeof window !== 'undefined') {
  window.PnLService = PnLService;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PnLService;
}