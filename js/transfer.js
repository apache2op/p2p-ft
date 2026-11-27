import { APP_CONFIG, CONTROL_VERSION } from './config.js';

export class TransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
  }
}

export function parseControl(data) {
  if (typeof data !== 'string' || data.length > APP_CONFIG.maxControlLength) return null;
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return null;
  if (message.v !== undefined && message.v !== CONTROL_VERSION) return null;
  return message;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function sendJson(dc, message) {
  if (!dc || dc.readyState !== 'open') {
    throw new TransferError('closed', 'The connection is not open.');
  }
  try {
    dc.send(JSON.stringify(message));
  } catch (error) {
    throw new TransferError('send-failed', error?.message || 'Could not send data over the connection.');
  }
}

/**
 * Wait until the data channel has drained below its low-water mark.
 * Resolves immediately when the buffer is already small enough.
 */
export function waitForBuffer(dc, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  if (!dc || dc.readyState !== 'open') {
    return Promise.reject(new TransferError('closed', 'The connection is not open.'));
  }
  if (dc.bufferedAmount <= APP_CONFIG.highWaterMark) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      dc.removeEventListener('bufferedamountlow', onLow);
      dc.removeEventListener('close', onClose);
      dc.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const onLow = () => {
      if (dc.readyState !== 'open') {
        finish(new TransferError('closed', 'The connection closed while sending.'));
        return;
      }
      finish(null);
    };
    const onClose = () => finish(new TransferError('closed', 'The connection closed while sending.'));
    const onError = () => finish(new TransferError('channel-error', 'The data channel reported an error while sending.'));
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError'));

    const timer = setTimeout(
      () => finish(new TransferError('stalled', 'The connection stalled while sending.')),
      APP_CONFIG.bufferWaitTimeoutMs,
    );

    dc.addEventListener('bufferedamountlow', onLow);
    dc.addEventListener('close', onClose);
    dc.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Send one file over a raw RTCDataChannel.
 * Protocol: meta (JSON) -> binary chunks -> done (JSON).
 */
export async function sendFile({ dc, file, transferId, signal, onSent }) {
  if (!dc || dc.readyState !== 'open') {
    throw new TransferError('closed', 'The connection is not open.');
  }
  if (!file || typeof file.size !== 'number' || file.size < 0) {
    throw new TransferError('invalid-file', 'No readable file was selected.');
  }
  if (file.size > APP_CONFIG.maxFileSize) {
    throw new TransferError(
      'file-too-large',
      `Files are limited to ${APP_CONFIG.maxFileSize / (1024 * 1024 * 1024)} GB in this version.`,
    );
  }

  const meta = {
    v: CONTROL_VERSION,
    type: 'meta',
    id: transferId,
    name: String(file.name || 'file').slice(0, APP_CONFIG.maxNameLength),
    size: file.size,
    mime: String(file.type || 'application/octet-stream').slice(0, APP_CONFIG.maxMimeLength),
  };

  sendJson(dc, meta);

  let sent = 0;
  for (let offset = 0; offset < file.size; offset += APP_CONFIG.chunkSize) {
    throwIfAborted(signal);
    await waitForBuffer(dc, signal);
    throwIfAborted(signal);

    const end = Math.min(offset + APP_CONFIG.chunkSize, file.size);
    let buffer;
    try {
      buffer = await file.slice(offset, end).arrayBuffer();
    } catch {
      throw new TransferError('read-failed', 'Could not read the selected file.');
    }

    throwIfAborted(signal);
    if (!buffer || buffer.byteLength === 0) {
      throw new TransferError('read-failed', 'The selected file could not be read.');
    }

    try {
      dc.send(buffer);
    } catch (error) {
      throw new TransferError('send-failed', error?.message || 'Could not send file data.');
    }

    sent += buffer.byteLength;
    onSent?.(sent);
  }

  throwIfAborted(signal);
  sendJson(dc, {
    v: CONTROL_VERSION,
    type: 'done',
    id: transferId,
    size: file.size,
  });

  return sent;
}

/**
 * Receives one file at a time, validates the protocol, sends ACKs, assembles a Blob,
 * and hands it to onDone.
 */
export class FileReceiver {
  constructor({
    maxSize = APP_CONFIG.maxFileSize,
    maxChunkSize = APP_CONFIG.maxChunkSize,
    sendControl,
    onMeta,
    onProgress,
    onFinishing,
    onDone,
    onError,
    onCancel,
  }) {
    this.maxSize = maxSize;
    this.maxChunkSize = maxChunkSize;
    this.sendControl = sendControl;
    this.onMeta = onMeta;
    this.onProgress = onProgress;
    this.onFinishing = onFinishing;
    this.onDone = onDone;
    this.onError = onError;
    this.onCancel = onCancel;

    this.state = 'idle';
    this.id = null;
    this.name = null;
    this.size = 0;
    this.mime = 'application/octet-stream';
    this.chunks = [];
    this.received = 0;
    this.lastAckBytes = 0;
    this.lastAckAt = 0;
    this._generation = 0;
  }

  async handleData(data) {
    if (typeof data === 'string') {
      const message = parseControl(data);
      if (!message) {
        this._fail('The sender sent an invalid control message.');
        return;
      }
      await this._handleControl(message);
      return;
    }

    let buffer = null;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (ArrayBuffer.isView(data)) {
      buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    if (!buffer) {
      this._fail('The sender sent an unsupported data format.');
      return;
    }

    this._handleChunk(buffer);
  }

  abort({ notify = false, reason = 'Receiver canceled the transfer.' } = {}) {
    const canNotify =
      notify && this.id && (this.state === 'receiving' || this.state === 'assembling');
    if (canNotify) {
      this._sendControl({ v: CONTROL_VERSION, type: 'cancel', id: this.id, reason });
    }
    this.reset();
  }

  reset() {
    this._generation += 1;
    this.state = 'idle';
    this.id = null;
    this.name = null;
    this.size = 0;
    this.mime = 'application/octet-stream';
    this.chunks = [];
    this.received = 0;
    this.lastAckBytes = 0;
    this.lastAckAt = 0;
  }

  async _handleControl(message) {
    switch (message.type) {
      case 'meta':
        this._handleMeta(message);
        break;
      case 'done':
        await this._handleDone(message);
        break;
      case 'error':
        this._fail(String(message.message || 'The sender reported an error.').slice(0, 300), { send: false });
        break;
      case 'cancel':
        this._handleCancel(String(message.reason || 'The sender canceled the transfer.').slice(0, 300), { send: false });
        break;
      default:
        // Ignore ACK/complete/unknown messages sent in the wrong direction.
        break;
    }
  }

  _handleMeta(message) {
    const valid =
      typeof message.id === 'string' &&
      message.id.length > 0 &&
      message.id.length <= 128 &&
      typeof message.name === 'string' &&
      message.name.length <= APP_CONFIG.maxNameLength &&
      Number.isSafeInteger(message.size) &&
      message.size >= 0 &&
      message.size <= this.maxSize &&
      typeof message.mime === 'string' &&
      message.mime.length <= APP_CONFIG.maxMimeLength;

    if (!valid) {
      const text =
        Number.isSafeInteger(message.size) && message.size > this.maxSize
          ? `The sender tried to send a file larger than ${this.maxSize / (1024 * 1024 * 1024)} GB.`
          : 'The sender sent invalid file information.';
      this._rejectMeta(message, text);
      return;
    }

    if (this.state === 'receiving' || this.state === 'assembling') {
      this._fail('A transfer is already in progress.');
      return;
    }

    if (this.state === 'done') this.reset();

    this.state = 'receiving';
    this.id = message.id;
    this.name = message.name;
    this.size = message.size;
    this.mime = message.mime || 'application/octet-stream';
    this.chunks = [];
    this.received = 0;
    this.lastAckBytes = 0;
    this.lastAckAt = performance.now();

    this.onMeta?.({ id: this.id, name: this.name, size: this.size, mime: this.mime });
    this._sendControl({ v: CONTROL_VERSION, type: 'ack', id: this.id, received: 0 });
  }

  _handleChunk(buffer) {
    if (this.state !== 'receiving') {
      this._fail('Received file data before file information.');
      return;
    }

    const length = buffer.byteLength;
    if (length <= 0) return;

    if (length > this.maxChunkSize) {
      this._fail('The sender sent an oversized data chunk.');
      return;
    }

    if (this.received + length > this.size) {
      this._fail('The sender sent more data than the declared file size.');
      return;
    }

    this.chunks.push(buffer);
    this.received += length;
    this.onProgress?.({ received: this.received, total: this.size });
    this._maybeAck();
  }

  _maybeAck() {
    const now = performance.now();
    if (
      this.received - this.lastAckBytes >= APP_CONFIG.ackBytes ||
      now - this.lastAckAt >= APP_CONFIG.ackIntervalMs
    ) {
      this.lastAckBytes = this.received;
      this.lastAckAt = now;
      this._sendControl({ v: CONTROL_VERSION, type: 'ack', id: this.id, received: this.received });
    }
  }

  async _handleDone(message) {
    if (this.state === 'done' && message.id === this.id) return;
    if (this.state !== 'receiving' || message.id !== this.id) {
      this._fail('The sender finished an unknown transfer.');
      return;
    }

    if (Number.isSafeInteger(message.size) && message.size !== this.size) {
      this._fail('The sender finished with a different file size.');
      return;
    }

    if (this.received !== this.size) {
      this._fail(`Transfer incomplete: received ${this.received} of ${this.size} bytes.`);
      return;
    }

    this.state = 'assembling';
    const chunks = this.chunks;
    this.chunks = [];
    const generation = this._generation;

    try {
      this.onFinishing?.();
      // Let the UI paint the "preparing download" state before a large Blob copy.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (generation !== this._generation) return;

      const blob = new Blob(chunks, { type: this.mime || 'application/octet-stream' });
      const result = {
        id: this.id,
        name: this.name,
        size: this.size,
        mime: this.mime,
        blob,
      };

      this.state = 'done';
      await this.onDone?.(result);
      if (generation !== this._generation) return;
      this._sendControl({
        v: CONTROL_VERSION,
        type: 'complete',
        id: this.id,
        received: this.received,
      });
    } catch {
      if (generation !== this._generation) return;
      this._fail('Could not assemble the file. It may be too large for this device.', { send: true });
    }
  }

  _handleCancel(reason, { send = true } = {}) {
    if (send && this.id) {
      this._sendControl({ v: CONTROL_VERSION, type: 'cancel', id: this.id, reason });
    }
    const hadTransfer = this.state !== 'idle';
    this.reset();
    if (hadTransfer) this.onCancel?.(reason);
  }

  _fail(message, { send = true } = {}) {
    if (send && this.id) {
      this._sendControl({ v: CONTROL_VERSION, type: 'error', id: this.id, message });
    }
    const hadTransfer = this.state !== 'idle';
    this.reset();
    if (hadTransfer) this.onError?.(new TransferError('receiver-error', message));
  }

  _rejectMeta(message, text) {
    const id =
      typeof message?.id === 'string' && message.id.length > 0 && message.id.length <= 128
        ? message.id
        : null;
    if (id) {
      this._sendControl({ v: CONTROL_VERSION, type: 'error', id, message: text });
    }
    const hadTransfer = this.state !== 'idle';
    this.reset();
    if (hadTransfer || id) this.onError?.(new TransferError('receiver-error', text));
  }

  _sendControl(message) {
    try {
      this.sendControl?.(message);
    } catch {
      // The connection may already be closed; the sender will notice via close/timeout.
    }
  }
}
