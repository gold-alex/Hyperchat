import { describe, it, expect, beforeEach } from 'vitest';
import { Hyperchat } from '../src/hyperchat.js';

describe('Hyperchat (Vitest) - minimal', () => {
  let chat: any;

  beforeEach(() => {
    document.body.innerHTML = '';
    chat = new Hyperchat({ backendPort: 3001 });
    chat.currentPair = 'ETH-USDC';
    chat.currentMarket = 'Perps';
  });

  it('renders connected state with name select and input (B2 analogue)', () => {
    chat.walletAddress = '0x1234567890abcdef1234567890abcdef12345678';
    chat.availableNames = ['crypto_trader', 'moon_boy'];

    const html = chat.getChatHTML();
    document.body.innerHTML = html;

    expect(document.querySelector('#connectWallet')).toBeNull();
    expect(document.querySelector('#messageInput')).not.toBeNull();
    expect((document.querySelector('#messageInput') as HTMLInputElement).placeholder).toContain('ETH-USDC_Perps');
    expect(document.querySelector('#hlNameSelect')).not.toBeNull();
  });

  it('updateChatHeader updates pair/market and placeholder (J1 analogue)', () => {
    document.body.innerHTML = `
      <div class="hl-chat-container">
        <div class="hl-chat-header">
          <div class="hl-chat-title">
            <span class="hl-chat-pair">ETH-USDC</span>
            <span class="hl-chat-market">Perps Chat</span>
          </div>
        </div>
      </div>
      <input id="messageInput" />
    `;
    chat.currentPair = 'SOL-USDC';
    chat.currentMarket = 'Spot';
    chat.updateChatHeader();

    const pairEl = document.querySelector('.hl-chat-pair');
    const marketEl = document.querySelector('.hl-chat-market');
    const inputEl = document.getElementById('messageInput') as HTMLInputElement;
    expect(pairEl?.textContent).toBe('SOL-USDC');
    expect(marketEl?.textContent).toBe('Spot Chat');
    expect(inputEl.placeholder).toBe('Chat with SOL-USDC_Spot traders...');
  });
});

