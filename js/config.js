/**
 * App-wide configuration.
 *
 * PeerJS is used only for signaling and connection setup. File bytes always
 * travel directly over the resulting RTCDataChannel.
 */
export const APP_CONFIG = {
  appName: 'P2P Drop',

  // PeerJS room IDs use this prefix: p2p-room-123456
  roomPrefix: 'p2p-room-',
  codeLength: 6,

  // File transfer
  chunkSize: 64 * 1024,          // 64 KB
  highWaterMark: 4 * 1024 * 1024, // pause sending above 4 MB buffered
  lowWaterMark: 1 * 1024 * 1024,  // resume when below 1 MB
  bufferWaitTimeoutMs: 30000,
  ackBytes: 256 * 1024,           // receiver ACKs every 256 KB...
  ackIntervalMs: 500,             // ...or every 500 ms
  maxChunkSize: 1024 * 1024,
  maxFileSize: 1024 * 1024 * 1024, // 1 GB hard cap for the in-memory MVP
  largeFileWarning: 512 * 1024 * 1024,
  maxNameLength: 255,
  maxMimeLength: 255,
  maxControlLength: 16384,

  // Timeouts
  peerOpenTimeoutMs: 25000,
  connectTimeoutMs: 30000,
  completeTimeoutMs: 60000,
  reconnectMaxAttempts: 6,
  cancelFlushTimeoutMs: 3000, // wait for queued data (including a cancel) to drain

  // PeerJS options.
  //
  // Leave host/port/path unset to use the public PeerJS cloud.
  // To use a self-hosted PeerServer, set host/port/path/secure, for example:
  //
  // peer: {
  //   host: 'peer.example.com',
  //   port: 443,
  //   path: '/',
  //   secure: true,
  //   debug: 0,
  // },
  //
  // If you provide a custom `config`, include your own STUN/TURN servers;
  // otherwise PeerJS's defaults (including its public TURN) are used.
  peer: {
    debug: 0,
  },
};

export const CONTROL_VERSION = 1;
