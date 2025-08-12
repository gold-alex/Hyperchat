// P&L Service for calculating user's Perps trading performance
// Based on Hyperliquid API for real-time P&L display in chat

class PnLService {
  constructor() {
    this.API = "https://api.hyperliquid.xyz/info";
    this.cache = new Map(); // Cache P&L results with expiry
    this.cacheExpiry = 60000; // 1 minute cache
  }

  async post(body) {
    try {
      const res = await fetch(this.API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`HTTP ${res.status}: ${await res.text()}`);
        return null;
      }
      return res.json();
    } catch (error) {
      console.error("P&L API request failed:", error);
      return null;
    }
  }

  toNum(x) {
    if (x === null || x === undefined) return 0;
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  }

  async getFills(user) {
    return this.post({
      type: "userFillsByTime",
      user,
      startTime: 0,
      endTime: 9999999999999,
      aggregateByTime: true
    });
  }

  async getFunding(user) {
    return this.post({
      type: "userFunding",
      user,
      startTime: 0,
      endTime: 9999999999999
    });
  }

  getCacheKey(address, coin) {
    return `${address}_${coin || 'ALL'}`;
  }

  getCachedPnL(address, coin) {
    const key = this.getCacheKey(address, coin);
    const cached = this.cache.get(key);
    
    if (cached && (Date.now() - cached.timestamp < this.cacheExpiry)) {
      return cached.value;
    }
    
    return null;
  }

  setCachedPnL(address, coin, value) {
    const key = this.getCacheKey(address, coin);
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  formatPnL(value) {
    if (value === null || value === undefined) return "";
    
    const absValue = Math.abs(value);
    let formatted;
    
    if (absValue >= 1000000) {
      formatted = `${(value / 1000000).toFixed(2)}M`;
    } else if (absValue >= 1000) {
      formatted = `${(value / 1000).toFixed(1)}K`;
    } else {
      formatted = value.toFixed(0);
    }
    
    const sign = value >= 0 ? "+" : "";
    const color = value >= 0 ? "#4ade80" : "#f87171"; // green or red
    
    return {
      text: `${sign}$${formatted}`,
      color: color,
      raw: value
    };
  }

  extractCoinFromPair(pair) {
    // Extract coin from pairs like "BTC-USD", "ETH-USD", "BTC", etc.
    if (!pair) return null;
    
    // Remove -USD, -USDT, -USDC suffixes
    const coin = pair.replace(/[-/](USD[TC]?|PERP)$/i, '').toUpperCase();
    
    // Handle special cases
    if (coin === 'BITCOIN') return 'BTC';
    if (coin === 'ETHEREUM') return 'ETH';
    
    return coin;
  }

  async calculatePnL(address, coin = null) {
    try {
      // Check cache first
      const cached = this.getCachedPnL(address, coin);
      if (cached !== null) {
        return cached;
      }

      console.log(`Calculating P&L for ${address}, coin: ${coin || 'ALL'}`);

      // Fetch data in parallel
      const [fills, funding] = await Promise.all([
        this.getFills(address),
        this.getFunding(address)
      ]);

      if (!fills || !funding) {
        console.error("Failed to fetch P&L data");
        return null;
      }

      // Filter by coin if specified
      const fillsFiltered = coin
        ? fills.filter(f => f.coin === coin)
        : fills;

      const fundingFiltered = coin
        ? funding.filter(f => f?.delta?.coin === coin)
        : funding;

      // Calculate P&L components
      const fillsSum = fillsFiltered.reduce((acc, f) =>
        acc + this.toNum(f.closedPnl) - this.toNum(f.fee) - this.toNum(f.builderFee), 0);

      const fundingSum = fundingFiltered.reduce((acc, f) =>
        acc + this.toNum(f.delta?.usdc), 0);

      const total = fillsSum + fundingSum;

      // Cache the result
      this.setCachedPnL(address, coin, total);

      console.log(`P&L calculated for ${address} (${coin || 'ALL'}): ${total}`);
      return total;

    } catch (error) {
      console.error("Error calculating P&L:", error);
      return null;
    }
  }

  async getPnLDisplay(address, pair = null) {
    const coin = pair ? this.extractCoinFromPair(pair) : null;
    const pnl = await this.calculatePnL(address, coin);
    
    if (pnl === null) {
      return null;
    }
    
    return this.formatPnL(pnl);
  }

  // Batch fetch P&L for multiple users (more efficient)
  async batchGetPnL(addresses, pair = null) {
    const coin = pair ? this.extractCoinFromPair(pair) : null;
    const results = new Map();
    
    // Process in parallel but limit concurrency to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const promises = batch.map(async (address) => {
        const pnl = await this.calculatePnL(address, coin);
        return { address, pnl };
      });
      
      const batchResults = await Promise.all(promises);
      batchResults.forEach(({ address, pnl }) => {
        results.set(address, pnl);
      });
    }
    
    return results;
  }

  // Clear cache (useful when switching pairs or refreshing)
  clearCache() {
    this.cache.clear();
  }

  // Clear cache for specific address
  clearAddressCache(address) {
    for (const [key, _] of this.cache) {
      if (key.startsWith(address)) {
        this.cache.delete(key);
      }
    }
  }
}

// Export for use in content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PnLService;
}

// Also make it available globally for Chrome extension
if (typeof window !== 'undefined') {
  window.PnLService = PnLService;
}