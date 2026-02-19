import { describe, expect, it, vi } from 'vitest';

async function loadClientClass() {
  const module = await import('../lib/waku-chat-client.js');
  return module.WakuChatClient;
}

describe('WakuChatClient auth-lite mode enforcement', () => {
  it('does not enable legacy mode implicitly when gatewayUrl is missing', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ gatewayUrl: '' });

    expect(client.useLegacyProto).toBe(false);
  });

  it('fails closed when strict mode send is attempted without gateway configuration', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({ gatewayUrl: '' });
    client.setWalletInfo('0x1234567890123456789012345678901234567890');
    client.setRoom('BTC-USD', 'Perps');

    await expect(client.sendMessage('hello', '0xsig')).rejects.toMatchObject({
      code: 'GATEWAY_CONFIG_MISSING',
    });
    await expect(client.sendMessage('hello', '0xsig')).rejects.toThrow(
      /Strict auth-lite mode cannot continue/,
    );
  });

  it('fails closed when strict mode session establishment is attempted without gateway', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({
      gatewayUrl: '',
      signMessage: vi.fn().mockResolvedValue('0xsignature'),
    });
    client.setWalletInfo('0x1234567890123456789012345678901234567890');
    client.setRoom('BTC-USD', 'Perps');

    await expect(client._ensureSession()).rejects.toMatchObject({
      code: 'GATEWAY_CONFIG_MISSING',
    });
  });

  it('uses legacy transport only when useLegacyProto is explicitly enabled', async () => {
    const WakuChatClient = await loadClientClass();
    const client = new WakuChatClient({
      gatewayUrl: '',
      useLegacyProto: true,
    });

    const legacySpy = vi.spyOn(client, '_sendLegacyMessage').mockResolvedValue({
      timestamp: Date.now(),
      address: '',
      content: '',
      signature: '',
      name: '',
      isOptimistic: true,
    });
    const gatewaySpy = vi.spyOn(client, '_sendMessageViaGateway').mockResolvedValue({
      timestamp: Date.now(),
      address: '',
      content: '',
      signature: '',
      name: '',
      sessionPubKey: '',
      isOptimistic: true,
    });

    await client.sendMessage('legacy hello', '0xsig');

    expect(legacySpy).toHaveBeenCalledWith('legacy hello', '0xsig');
    expect(gatewaySpy).not.toHaveBeenCalled();
  });
});
