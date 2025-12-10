import { randomBytes, webcrypto, createHash } from 'node:crypto';
import { Wallet, verifyMessage } from 'ethers';
import * as secp from '@noble/secp256k1';

if (typeof globalThis.crypto === 'undefined') {
  (globalThis as typeof globalThis & { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

type ChatMessage = {
  text: string;
  timestamp: number;
};

type SignedEnvelope = {
  message: ChatMessage;
  senderAddress: string;
  sessionPubKey: string;
  timestampMs: number;
  messageId: string;
  signature: string;
};

const toHex = (data: Uint8Array) => Buffer.from(data).toString('hex');

function buildSiweMessage(params: {
  address: string;
  sessionPubKeyHex: string;
  nonce: string;
  issuedAt: string;
  expiration: string;
  chainId?: number;
}) {
  const { address, sessionPubKeyHex, nonce, issuedAt, expiration, chainId = 1 } = params;
  return `
${address} wants you to sign in with your Ethereum account:
${address}

URI: urn:session:${sessionPubKeyHex}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expiration}
`.trim();
}

function extractSessionPubKey(siweMessage: string): string {
  const match = siweMessage.match(/URI: urn:session:([a-fA-F0-9]+)/);
  if (!match) throw new Error('Session public key missing from SIWE message');
  return match[1];
}

function hashEnvelope(input: { contentTopic: string; pubsubTopic: string; envelope: SignedEnvelope }): Uint8Array {
  const canonical = JSON.stringify({
    contentTopic: input.contentTopic,
    pubsubTopic: input.pubsubTopic,
    message: input.envelope.message,
    timestampMs: input.envelope.timestampMs,
    sessionPubKey: input.envelope.sessionPubKey,
  });
  const hash = createHash('sha256').update(Buffer.from(canonical)).digest();
  return new Uint8Array(hash);
}

async function main() {
  console.log('--- Generating ephemeral session key');
  const sessionPrivKey = secp.utils.randomPrivateKey();
  const sessionPubKey = secp.getPublicKey(sessionPrivKey, true);
  const sessionPubKeyHex = toHex(sessionPubKey);

  console.log('Session pubkey:', sessionPubKeyHex);

  console.log('\n--- Creating delegator wallet');
  const delegatorWallet = Wallet.createRandom();
  console.log('Delegator address:', delegatorWallet.address);

  const nonce = toHex(randomBytes(8));
  const issuedAt = new Date().toISOString();
  const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const siweMessage = buildSiweMessage({
    address: delegatorWallet.address,
    sessionPubKeyHex,
    nonce,
    issuedAt,
    expiration,
  });

  console.log('\n--- Signing SIWE message with delegator wallet');
  console.log(siweMessage);
  const siweSignature = await delegatorWallet.signMessage(siweMessage);
  console.log('SIWE signature:', siweSignature);

  console.log('\n--- Gateway verifying SIWE login');
  const recoveredAddress = verifyMessage(siweMessage, siweSignature);
  if (recoveredAddress.toLowerCase() !== delegatorWallet.address.toLowerCase()) {
    throw new Error('Invalid SIWE signature: recovered address mismatch');
  }
  const authorizedSessionPubKey = extractSessionPubKey(siweMessage);
  console.log('Authorized session pubkey:', authorizedSessionPubKey);

  console.log('\n--- Preparing signed chat envelope');
  const contentTopic = '/waku-auth-lite/1/chat/json';
  const pubsubTopic = '/waku/2/rs/999/0';
  const chatMessage: ChatMessage = { text: 'Hello Waku!', timestamp: Date.now() };
  const envelope: SignedEnvelope = {
    message: chatMessage,
    senderAddress: delegatorWallet.address,
    sessionPubKey: sessionPubKeyHex,
    timestampMs: Date.now(),
    messageId: '',
    signature: '',
  };

  const messageHash = hashEnvelope({ contentTopic, pubsubTopic, envelope });
  const rawSignature = await secp.signAsync(messageHash, sessionPrivKey);
  const signatureBytes = rawSignature instanceof Uint8Array ? rawSignature : rawSignature.toCompactRawBytes();
  envelope.signature = toHex(signatureBytes);
  envelope.messageId = toHex(messageHash);

  const payloadBase64 = Buffer.from(JSON.stringify(envelope)).toString('base64');
  console.log('Envelope payload (base64):', payloadBase64);

  console.log('\n--- Gateway verifying message envelope');
  const envelopeHash = hashEnvelope({ contentTopic, pubsubTopic, envelope });
  const signatureValid = secp.verify(envelope.signature, envelopeHash, authorizedSessionPubKey);
  if (!signatureValid) {
    throw new Error('Ephemeral signature invalid');
  }

  console.log('Message verified! Ready to relay to Waku.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
