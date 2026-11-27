import { APP_CONFIG } from './config.js';
import { generateCode, isValidCode } from './utils.js';

export class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

const PEER_ERROR_MESSAGES = {
  'browser-incompatible': 'This browser does not support WebRTC data channels.',
  'invalid-id': 'The room code is invalid. Please try again.',
  'unavailable-id': 'That room code is already in use. Please try again.',
  'peer-unavailable': 'No sender found with that code. Check the code and make sure the sender is still on this page.',
  network: 'Cannot reach the signaling server. Check your connection and try again.',
  'server-error': 'The signaling server returned an error. Please try again.',
  'socket-error': 'The signaling connection failed. Please try again.',
  'socket-closed': 'The signaling connection closed. Please try again.',
  'ssl-unavailable': 'A secure connection to the signaling server could not be established.',
  webrtc: 'WebRTC negotiation failed. Please try again.',
  'negotiation-failed': 'Could not establish a direct connection. A firewall or NAT may be blocking it.',
  'connection-closed': 'The connection was closed.',
  disconnected: 'Disconnected from the signaling server.',
};

const CONNECTION_ERROR_MESSAGES = {
  'negotiation-failed': 'Could not establish a direct connection. A firewall or NAT may be blocking it.',
  'connection-closed': 'The connection was closed.',
  'not-open-yet': 'The connection is not open yet.',
  'message-too-big': 'A message was too large for the connection.',
};

function normalizePeerError(error) {
  if (error instanceof SessionError) return error;
  const code = error?.type || 'unknown';
  return new SessionError(code, PEER_ERROR_MESSAGES[code] || error?.message || 'An unexpected signaling error occurred.');
}

function normalizeConnectionError(error) {
  if (error instanceof SessionError) return error;
  const code = error?.type || 'connection-error';
  return new SessionError(code, CONNECTION_ERROR_MESSAGES[code] || error?.message || 'The data connection reported an error.');
}

function getPeerClass() {
  const PeerClass = globalThis.Peer;
  if (typeof PeerClass !== 'function') {
    throw new SessionError('peerjs-missing', 'PeerJS failed to load. Refresh the page and try again.');
  }
  return PeerClass;
}

export class Session {
  constructor({ role, handlers = {} }) {
    this.role = role;
    this.handlers = handlers;
    this.peer = null;
    this.conn = null;
    this.dc = null;
    this.code = null;
    this.connOpen = false;
    this.reconnectAttempts = 0;

    this._ready = false;
    this._destroyed = false;
    this._closing = false;
    this._peerStartup = null;
    this._connectionDeferred = null;
    this._reconnectTimer = null;
    this._connectTimer = null;

    this._onOnline = () => {
      if (this._destroyed) return;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      if (this.peer?.disconnected && !this.peer.destroyed) {
        try {
          this.peer.reconnect();
        } catch {
          this._scheduleReconnect();
        }
      }
    };
    window.addEventListener('online', this._onOnline);
  }

  async startSender() {
    if (this._destroyed) throw new SessionError('canceled', 'Canceled.');
    this.role = 'sender';

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this._destroyed) throw new SessionError('canceled', 'Canceled.');
      const code = generateCode();
      try {
        await this._createPeer(APP_CONFIG.roomPrefix + code);
        if (this._destroyed) throw new SessionError('canceled', 'Canceled.');
        this.code = code;
        this.handlers.onCode?.(code);
        return code;
      } catch (error) {
        lastError = error;
        if (error.code === 'unavailable-id' && attempt < 2) continue;
        throw error;
      }
    }
    throw lastError || new SessionError('unavailable-id', 'Could not reserve a room code. Please try again.');
  }

  async startReceiver(code) {
    if (this._destroyed) throw new SessionError('canceled', 'Canceled.');
    if (!isValidCode(code)) {
      throw new SessionError('invalid-code', `Enter a ${APP_CONFIG.codeLength}-digit code.`);
    }
    this.role = 'receiver';
    this.code = code;

    const peer = await this._createPeer(null);
    if (this._destroyed) throw new SessionError('canceled', 'Canceled.');
    if (!peer.open || peer.disconnected) {
      throw new SessionError('network', 'The signaling server is not ready. Please try again.');
    }

    const deferred = this._createConnectionDeferred();
    let conn = null;
    const timer = setTimeout(() => {
      this._settleConnection(new SessionError('timeout', 'Timed out connecting to the sender.'));
      try {
        conn?.close();
      } catch {
        // ignore
      }
    }, APP_CONFIG.connectTimeoutMs);
    this._connectTimer = timer;

    try {
      conn = peer.connect(APP_CONFIG.roomPrefix + code, {
        reliable: true,
        serialization: 'raw',
        metadata: { role: 'receiver' },
      });
    } catch (error) {
      clearTimeout(timer);
      this._connectTimer = null;
      const normalized = normalizePeerError(error);
      this._settleConnection(normalized);
      throw normalized;
    }

    if (!conn) {
      clearTimeout(timer);
      this._connectTimer = null;
      const error = new SessionError('connection-failed', 'Could not create the data connection.');
      this._settleConnection(error);
      throw error;
    }

    this._attachConnection(conn);

    try {
      await deferred.promise;
    } finally {
      clearTimeout(timer);
      if (this._connectTimer === timer) this._connectTimer = null;
    }

    return conn;
  }

  send(data) {
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new SessionError('not-open', 'The connection is not open.');
    }
    this.dc.send(data);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._closing = true;
    window.removeEventListener('online', this._onOnline);

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }

    const startup = this._peerStartup;
    if (startup) {
      startup.finish(new SessionError('canceled', 'Canceled.'));
    }
    this._settleConnection(new SessionError('canceled', 'Canceled.'));

    const conn = this.conn;
    this.conn = null;
    this.dc = null;
    if (conn) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }

    const peer = this.peer;
    this.peer = null;
    if (peer) {
      try {
        peer.destroy();
      } catch {
        // ignore
      }
    }

    this._ready = false;
    this.connOpen = false;
  }

  _createPeer(id) {
    return new Promise((resolve, reject) => {
      if (this._destroyed) {
        reject(new SessionError('canceled', 'Canceled.'));
        return;
      }

      let PeerClass;
      try {
        PeerClass = getPeerClass();
      } catch (error) {
        reject(error);
        return;
      }

      let peer;
      try {
        peer = id
          ? new PeerClass(id, APP_CONFIG.peer)
          : new PeerClass(APP_CONFIG.peer);
      } catch (error) {
        reject(new SessionError('peer-init', error?.message || 'Could not initialize PeerJS.'));
        return;
      }

      this.peer = peer;
      let settled = false;
      let timer = null;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        this._peerStartup = null;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (error) {
          if (this.peer === peer) this.peer = null;
          this._ready = false;
          try {
            peer.destroy();
          } catch {
            // ignore
          }
          reject(error);
        } else {
          this._ready = true;
          resolve(peer);
        }
      };

      this._peerStartup = { finish };
      timer = setTimeout(() => {
        finish(new SessionError('timeout', 'Timed out connecting to the signaling server.'));
      }, APP_CONFIG.peerOpenTimeoutMs);

      peer.on('open', () => {
        if (peer !== this.peer) return;
        if (!settled) {
          finish(null);
          return;
        }
        this.reconnectAttempts = 0;
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = null;
        }
        this.handlers.onSignalingReconnected?.();
      });

      peer.on('error', (error) => {
        if (peer !== this.peer) return;
        const normalized = normalizePeerError(error);
        if (!settled) {
          finish(normalized);
          return;
        }
        this._handlePeerError(normalized);
      });

      peer.on('disconnected', () => {
        if (peer !== this.peer) return;
        if (!settled) {
          finish(new SessionError('network', 'Lost connection to the signaling server.'));
          return;
        }
        this._handleSignalingDisconnected();
      });

      peer.on('close', () => {
        if (peer !== this.peer) return;
        if (!settled) {
          finish(new SessionError('closed', 'The signaling connection closed.'));
          return;
        }
        this._handlePeerClose();
      });

      peer.on('connection', (conn) => {
        if (peer !== this.peer) return;
        this._handleIncomingConnection(conn);
      });
    });
  }

  _handleIncomingConnection(conn) {
    if (this.role !== 'sender') {
      try {
        conn.close();
      } catch {
        // ignore
      }
      return;
    }

    if (this.conn) {
      // One receiver at a time.
      try {
        conn.close();
      } catch {
        // ignore
      }
      return;
    }

    this._attachConnection(conn);
  }

  _attachConnection(conn) {
    this.conn = conn;
    this.connOpen = false;

    conn.on('open', () => {
      if (this.conn !== conn) return;
      this.connOpen = true;
      const dc = conn.dataChannel;

      if (!dc) {
        const error = new SessionError('no-datachannel', 'The data channel could not be opened.');
        const wasStartup = Boolean(this._connectionDeferred);
        this._settleConnection(error);
        if (!wasStartup) this.handlers.onConnectionError?.(error);
        return;
      }

      this.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = APP_CONFIG.lowWaterMark;

      this._settleConnection(null);
      this.handlers.onConnection?.(dc, conn);
    });

    conn.on('data', (data) => {
      if (this.conn !== conn) return;
      this.handlers.onData?.(data);
    });

    conn.on('close', () => {
      if (this.conn !== conn) return;
      const wasOpen = this.connOpen;
      this.connOpen = false;
      this.dc = null;
      this.conn = null;
      this._settleConnection(new SessionError('connection-closed', 'The connection closed.'));
      if (wasOpen && !this._closing) this.handlers.onClose?.();
    });

    conn.on('error', (error) => {
      if (this.conn !== conn) return;
      const normalized = normalizeConnectionError(error);
      const wasStartup = Boolean(this._connectionDeferred);
      this._settleConnection(normalized);
      if (!wasStartup) this.handlers.onConnectionError?.(normalized);
    });
  }

  _createConnectionDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this._connectionDeferred = { promise, resolve, reject, settled: false };
    return this._connectionDeferred;
  }

  _settleConnection(error) {
    const deferred = this._connectionDeferred;
    if (!deferred || deferred.settled) return;
    deferred.settled = true;
    this._connectionDeferred = null;
    if (error) deferred.reject(error);
    else deferred.resolve();
  }

  _handlePeerError(error) {
    if (this._destroyed) return;
    if (this._connectionDeferred) {
      this._settleConnection(error);
      return;
    }

    if (
      error.code === 'network' ||
      error.code === 'server-error' ||
      error.code === 'socket-error' ||
      error.code === 'socket-closed'
    ) {
      this._handleSignalingDisconnected(error);
      return;
    }

    this.handlers.onError?.(error);
  }

  _handleSignalingDisconnected(error) {
    if (this._destroyed) return;
    this.handlers.onSignalingDisconnected?.(error);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;

    if (!this.peer || this.peer.destroyed) {
      this.handlers.onError?.(new SessionError('network', 'The signaling connection was lost. Please start over.'));
      return;
    }

    if (this.reconnectAttempts >= APP_CONFIG.reconnectMaxAttempts) {
      this.handlers.onError?.(new SessionError('network', 'Could not reconnect to the signaling server. Please start over.'));
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts += 1;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._destroyed || !this.peer || this.peer.destroyed) return;
      if (!this.peer.disconnected) return;
      try {
        this.peer.reconnect();
      } catch {
        this._scheduleReconnect();
      }
    }, delay);
  }

  _handlePeerClose() {
    if (this._destroyed) return;
    if (this._connectionDeferred) {
      this._settleConnection(new SessionError('closed', 'The signaling connection closed.'));
      return;
    }
    this.handlers.onPeerClose?.();
  }
}
