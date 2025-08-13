const params = new URLSearchParams(location.search);
window.CHAT_PAIR_OVERRIDE = params.get('pair');
window.CHAT_MARKET_OVERRIDE = params.get('market');
window.IS_STANDALONE_CHAT = true;
// Mark document for side panel layout behavior
document.documentElement.setAttribute('data-hl-standalone', 'true');
import(chrome.runtime.getURL('content.js')).catch(console.error); 