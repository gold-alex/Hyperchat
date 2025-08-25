// Element Links Configuration and Utilities
// Shared configuration for element linking feature
//
// Format: 'hostname': { 'label': { selector: 'css-selector', description: 'human-readable description' } }
// Supports:
// - Element IDs: '#tv_chart_container'
// - Content-based: 'div:contains("Open Interest")'
// - Complex selectors: 'div:has(div:contains("Orderbook"))'

const ELEMENT_LINK_CONFIG = {
  // Hyperliquid trading interface
  'app.hyperliquid.xyz': {
    'chart': {
      selector: '#tv_chart_container',
      description: 'Trading Chart'
    },
    'info': {
      selector: '#coinInfo',
      description: 'Coin Information Panel'
    },
    'orderbook': {
      selector: "div:has(div:contains('Orderbook'))",
      description: 'Order Book'
    },
    'trades': {
      selector: "div:has(div:contains('Recent Trades'))",
      description: 'Recent Trades'
    },
    'positions': {
      selector: "div:has(div:contains('Positions'))",
      description: 'Positions Panel'
    },
    'orders': {
      selector: "div:has(div:contains('Orders'))",
      description: 'Orders Panel'
    },
    'openinterest': {
      selector: "div:contains('Open Interest')",
      description: 'Open Interest'
    },
    'funding': {
      selector: "div:contains('Funding Rate')",
      description: 'Funding Rate'
    },
    'volume': {
      selector: "div:contains('24h Volume')",
      description: '24h Volume'
    }
  }
  // Future sites can be added here
  // 'some.other.site': {
  //   'label': { selector: 'css-selector', description: 'description' }
  // }
};

// Element link processing function
function processElementLinks(content, config) {
  if (!config) {
    return content;
  }

  // Regex to find #word patterns. The # character is not escaped by HTML escaping.
  const tagRegex = /#(\w+)/g;

  return content.replace(tagRegex, (match, tagLabel) => {
    try {
      const elementConfig = config[tagLabel.toLowerCase()];
      if (elementConfig && elementConfig.selector) {
        return `<a href="#" class="hl-element-link" data-element-selector="${elementConfig.selector}" title="Scroll to ${elementConfig.description}">#${tagLabel}</a>`;
      }
    } catch (error) {
      console.warn('[ElementLinks] Failed to process tag:', tagLabel, error);
    }
    // If the tag is not in our config or processing failed, return it as plain text.
    return match;
  });
}

// Export for ES6 modules (sidepanel only)
export { ELEMENT_LINK_CONFIG, processElementLinks };

// Export for CommonJS (for potential Node.js usage)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ELEMENT_LINK_CONFIG, processElementLinks };
}
