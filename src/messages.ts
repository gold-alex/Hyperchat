export const MSG = {
  GET_STORED: 'getStoredData',
  SET_STORED: 'setStoredData',
  OPEN_WIDGET: 'openStandaloneChat',
  ROOM_CHANGE: 'roomChange',
  SHOW_CHAT: 'showChat',
  SYNC_SIDEPANEL: 'syncSidepanel',
  HIDE_CHAT: 'hideChat',
  CLOSE_SIDEPANEL: 'closeSidePanel',
  REQUEST_WALLET: 'requestWalletConnection',
  SEND_MESSAGE: 'sendMessage',
  SIGN_MESSAGE: 'signMessage',
  GET_CURRENT_ROOM: 'getCurrentRoom',
  SYNC_MESSAGES: 'syncMessages',
  WALLET_CONNECTED: 'walletConnected',
  WALLET_DISCONNECTED: 'walletDisconnected',
} as const;

export type MessageAction = typeof MSG[keyof typeof MSG];

export type Message =
  | { action: typeof MSG.GET_STORED; key: string }
  | { action: typeof MSG.SET_STORED; key: string; value: unknown }
  | { action: typeof MSG.OPEN_WIDGET; pair?: string; market?: string }
  | { action: typeof MSG.ROOM_CHANGE; pair: string; market: string }
  | { action: typeof MSG.SHOW_CHAT; pair?: string; market?: string }
  | { action: typeof MSG.SYNC_SIDEPANEL; [key: string]: any }
  | { action: typeof MSG.CLOSE_SIDEPANEL }
  | { action: typeof MSG.REQUEST_WALLET }
  | { action: typeof MSG.SEND_MESSAGE; content: string; selectedName?: string }
  | { action: typeof MSG.SIGN_MESSAGE; message: string }
  | { action: typeof MSG.GET_CURRENT_ROOM }
  | { action: typeof MSG.SYNC_MESSAGES }
  | { action: typeof MSG.HIDE_CHAT }
  | { action: typeof MSG.WALLET_CONNECTED; walletAddress: string; availableNames?: string[]; selectedName?: string; hasBackendAuth?: boolean }
  | { action: typeof MSG.WALLET_DISCONNECTED };
