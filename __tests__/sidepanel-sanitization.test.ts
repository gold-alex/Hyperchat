import { describe, expect, it } from 'vitest';
import {
  buildSafeNameOptions,
  sanitizeDisplayName,
  sanitizeRoomId,
} from '../src/ui/chat-html-safety.js';

describe('Sidepanel sanitization helpers', () => {
  it('sanitizes external names used in selector options', () => {
    const optionsHtml = buildSafeNameOptions(
      ['alpha.hl', '\"><img src=x onerror=alert(1)>'],
      '',
    );
    const select = document.createElement('select');
    select.innerHTML = optionsHtml;

    expect(select.querySelector('img')).toBeNull();
    expect(select.innerHTML).not.toContain('<img');
    const optionTexts = Array.from(select.querySelectorAll('option')).map((option) => option.textContent || '');
    expect(optionTexts).toContain('\"><img src=x onerror=alert(1)>');
  });

  it('sanitizes message display names before rendering', () => {
    const displayName = sanitizeDisplayName('<svg onload=alert(1)>', '0x1234...abcd');
    const container = document.createElement('div');
    container.innerHTML = `<span class="hl-message-address">${displayName}</span>`;

    const addressNode = container.querySelector('.hl-message-address');
    expect(addressNode?.querySelector('svg')).toBeNull();
    expect(addressNode?.innerHTML).not.toContain('<svg');
    expect(addressNode?.textContent).toBe('<svg onload=alert(1)>');
  });

  it('sanitizes pair/market room labels before insertion', () => {
    const roomId = sanitizeRoomId('<img src=x onerror=1>', 'Perps<script>alert(1)</script>');
    const container = document.createElement('div');
    container.innerHTML = `<div class="hl-loading">No messages yet in ${roomId}. Be the first to chat!</div>`;

    const loading = container.querySelector('.hl-loading');
    expect(loading?.querySelector('img')).toBeNull();
    expect(loading?.querySelector('script')).toBeNull();
    expect(loading?.textContent).toContain('<img src=x onerror=1>_Perps<script>alert(1)</script>');
  });
});
