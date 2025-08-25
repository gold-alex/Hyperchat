// Element Links Configuration - Global Version (for content scripts)
const ELEMENT_LINK_CONFIG = {
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
};

function processElementLinks(content, config) {
  if (!config) {
    return content;
  }

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
    return match;
  });
}

// Make globally available
window.ElementLinks = { ELEMENT_LINK_CONFIG, processElementLinks };
