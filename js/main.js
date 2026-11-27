import { APP_CONFIG } from './config.js';
import { Session } from './session.js';
import { sendFile, FileReceiver, parseControl } from './transfer.js';
import {
  isValidCode,
  formatBytes,
  formatSpeed,
  formatEta,
  formatPercent,
  sanitizeFileName,
  SpeedMeter,
  createTransferId,
  clamp,
} from './utils.js';

const $ = (id) => document.getElementById(id);

const dom = {
  views: {
    landing: $('view-landing'),
    sender: $('view-sender'),
    receiver: $('view-receiver'),
  },
  btnSend: $('btn-send'),
  btnReceive: $('btn-receive'),

  senderBack: $('sender-back'),
  senderReset: $('sender-reset'),
  senderCode: $('sender-code'),
  btnCopy: $('btn-copy'),
  senderStatus: $('sender-status'),
  filePickerLabel: $('file-picker-label'),
  fileInput: $('file-input'),
  fileInfo: $('file-info'),
  fileName: $('file-name'),
  fileSize: $('file-size'),
  fileNote: $('file-note'),
  btnSendFile: $('btn-send-file'),

  receiverBack: $('receiver-back'),
  receiverReset: $('receiver-reset'),
  codeInput: $('code-input'),
  btnConnect: $('btn-connect'),
  receiverStatus: $('receiver-status'),

  transferPanel: $('transfer-panel'),
  transferRole: $('transfer-role'),
  transferTitle: $('transfer-title'),
  transferBadge: $('transfer-badge'),
  progress: $('progress'),
  progressPercent: $('progress-percent'),
  progressBytes: $('progress-bytes'),
  metricStatus: $('metric-status'),
  metricSpeed: $('metric-speed'),
  metricEta: $('metric-eta'),
  metricRemaining: $('metric-remaining'),
  downloadLink: $('download-link'),
  transferHint: $('transfer-hint'),
  transferReset: $('transfer-reset'),

  alert: $('alert'),
  alertMessage: $('alert-message'),
  alertAction: $('alert-action'),
  alertDismiss: $('alert-dismiss'),
};

const state = {
  view: 'landing',
  phase: 'idle',
  role: null,
  code: null,
  session: null,
  file: null,
  transfer: null,
  receiver: null,
  abortController: null,
  speedMeter: new SpeedMeter(),
  ticker: null,
  completeTimer: null,
  copyTimer: null,
  alertTimer: null,
  alertAction: null,
  alertKey: null,
  downloadUrl: null,
  resetting: false,
};

function setStatus(element, text, tone = 'idle') {
  element.dataset.tone = tone;
  const target = element.querySelector('.status-text');
  if (target) target.textContent = text;
}

function setTransferStatus(badge, tone, metricText = badge) {
  dom.transferBadge.textContent = badge;
  dom.transferBadge.dataset.tone = tone;
  dom.metricStatus.textContent = metricText;
}

function showView(name) {
  for (const [key, element] of Object.entries(dom.views)) {
    element.hidden = key !== name;
  }
  state.view = name;
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function showAlert(message, { tone = 'error', actionLabel = '', onAction = null, autoHideMs = 0, key = null } = {}) {
  clearTimeout(state.alertTimer);
  state.alertTimer = null;
  state.alertKey = key;
  state.alertAction = onAction;

  dom.alert.dataset.tone = tone;
  dom.alertMessage.textContent = message;
  dom.alert.hidden = false;

  if (actionLabel && onAction) {
    dom.alertAction.textContent = actionLabel;
    dom.alertAction.hidden = false;
  } else {
    dom.alertAction.hidden = true;
    dom.alertAction.textContent = '';
  }

  if (autoHideMs > 0) {
    state.alertTimer = setTimeout(() => hideAlert(), autoHideMs);
  }
}

function hideAlert(key = null) {
  if (key && state.alertKey !== key) return;
  clearTimeout(state.alertTimer);
  state.alertTimer = null;
  state.alertKey = null;
  state.alertAction = null;
  dom.alert.hidden = true;
  dom.alertAction.hidden = true;
  dom.alertAction.textContent = '';
}

function setFilePickerEnabled(enabled) {
  dom.fileInput.disabled = !enabled;
  dom.filePickerLabel.classList.toggle('is-disabled', !enabled);
  dom.filePickerLabel.setAttribute('aria-disabled', String(!enabled));
}

function updateSendButton() {
  const file = state.file;
  const canSend =
    state.phase === 'connected' &&
    Boolean(file) &&
    file.size <= APP_CONFIG.maxFileSize &&
    !state.abortController;
  dom.btnSendFile.disabled = !canSend;
}

function stopTicker() {
  if (state.ticker) {
    clearInterval(state.ticker);
    state.ticker = null;
  }
}

function startTicker() {
  stopTicker();
  state.ticker = setInterval(updateTransferUI, 250);
}

function updateTransferUI() {
  const transfer = state.transfer;
  if (!transfer) return;

  const total = transfer.size;
  const isSender = state.role === 'sender';
  let bytes = isSender ? transfer.ackedBytes : transfer.receivedBytes;
  if (!Number.isFinite(bytes)) bytes = 0;
  bytes = clamp(bytes, 0, total);

  const percent = total > 0 ? (bytes / total) * 100 : state.phase === 'done' ? 100 : 0;
  const remaining = Math.max(0, total - bytes);
  const speed = state.phase === 'done' ? 0 : state.speedMeter.getSpeed();
  const eta = speed > 0 ? remaining / speed : Number.NaN;

  dom.progress.value = percent;
  dom.progress.setAttribute(
    'aria-valuetext',
    `${formatPercent(percent)}, ${formatBytes(bytes)} of ${formatBytes(total)}`,
  );
  dom.progressPercent.textContent = formatPercent(percent);
  dom.progressBytes.textContent = `${formatBytes(bytes)} / ${formatBytes(total)}`;
  dom.metricSpeed.textContent = formatSpeed(speed);
  dom.metricEta.textContent = remaining === 0 ? '0s' : formatEta(eta);
  dom.metricRemaining.textContent = formatBytes(remaining);
}

function showTransferPanel({ role, name, size }) {
  dom.transferPanel.hidden = false;
  dom.transferRole.textContent = role === 'sender' ? 'Sending' : 'Receiving';
  dom.transferTitle.textContent = name;
  dom.transferTitle.title = name;
  dom.progress.value = 0;
  dom.progressPercent.textContent = '0%';
  dom.progressBytes.textContent = `0 B / ${formatBytes(size)}`;
  dom.metricStatus.textContent = role === 'sender' ? 'Transferring' : 'Receiving';
  dom.metricSpeed.textContent = '—';
  dom.metricEta.textContent = '—';
  dom.metricRemaining.textContent = formatBytes(size);
  dom.downloadLink.hidden = true;
  dom.downloadLink.removeAttribute('href');
  dom.transferHint.hidden = true;
  dom.transferHint.textContent = '';
  dom.transferHint.dataset.tone = 'warn';
  dom.transferReset.textContent = 'Cancel transfer';
  dom.senderReset.hidden = true;
  dom.receiverReset.hidden = true;
  dom.transferPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setTransferHint(message, tone = 'warn') {
  dom.transferHint.textContent = message;
  dom.transferHint.dataset.tone = tone;
  dom.transferHint.hidden = !message;
}

function destroySessionWhenDrained(session) {
  const dc = session.dc;
  if (!dc || dc.readyState !== 'open') {
    session.destroy();
    return;
  }

  let finished = false;
  let timer = null;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    dc.removeEventListener('bufferedamountlow', onLow);
    dc.removeEventListener('close', finish);
    session.destroy();
  };

  const onLow = () => {
    if (dc.readyState !== 'open' || dc.bufferedAmount <= 0) finish();
  };

  // A threshold of 0 makes bufferedamountlow fire only when everything queued,
  // including the cancel control message, has left the channel.
  dc.bufferedAmountLowThreshold = 0;
  dc.addEventListener('bufferedamountlow', onLow);
  dc.addEventListener('close', finish, { once: true });
  timer = setTimeout(finish, APP_CONFIG.cancelFlushTimeoutMs);

  if (dc.bufferedAmount <= 0) setTimeout(finish, 0);
}

function resetApp({ toLanding = true, notifyPeer = true } = {}) {
  state.resetting = true;
  stopTicker();
  clearTimeout(state.completeTimer);
  state.completeTimer = null;

  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }

  const activeTransfer = state.phase === 'transferring' || state.phase === 'finalizing';

  if (notifyPeer && activeTransfer && state.role === 'sender' && state.transfer && state.session?.dc?.readyState === 'open') {
    try {
      state.session.send(
        JSON.stringify({ v: 1, type: 'cancel', id: state.transfer.id, reason: 'Sender canceled the transfer.' }),
      );
    } catch {
      // ignore
    }
  }

  if (state.receiver) {
    state.receiver.abort({
      notify: notifyPeer && activeTransfer && state.role === 'receiver',
      reason: 'Receiver canceled the transfer.',
    });
    state.receiver = null;
  }

  const session = state.session;
  state.session = null;
  if (session) {
    if (notifyPeer && activeTransfer) {
      // Let queued file data and the cancel message drain before closing.
      destroySessionWhenDrained(session);
    } else {
      session.destroy();
    }
  }

  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }

  clearTimeout(state.copyTimer);
  state.copyTimer = null;

  state.phase = 'idle';
  state.role = null;
  state.code = null;
  state.file = null;
  state.transfer = null;
  state.speedMeter.reset();

  dom.fileInput.value = '';
  dom.fileInput.disabled = false;
  dom.filePickerLabel.classList.remove('is-disabled');
  dom.filePickerLabel.setAttribute('aria-disabled', 'false');
  dom.fileInfo.hidden = true;
  dom.fileName.textContent = '';
  dom.fileSize.textContent = '';
  dom.fileNote.hidden = true;
  dom.fileNote.textContent = '';
  dom.fileNote.dataset.tone = 'warn';
  dom.btnSendFile.disabled = true;

  dom.senderCode.textContent = '------';
  dom.senderCode.setAttribute('aria-label', 'Room code');
  dom.btnCopy.disabled = true;
  dom.btnCopy.textContent = 'Copy';
  setStatus(dom.senderStatus, 'Connecting to the signaling server…', 'busy');
  dom.senderReset.hidden = false;
  dom.senderReset.textContent = 'Cancel';

  dom.codeInput.value = '';
  dom.codeInput.setAttribute('aria-invalid', 'false');
  dom.codeInput.disabled = false;
  dom.btnConnect.disabled = true;
  dom.receiverReset.hidden = false;
  dom.receiverReset.textContent = 'Back';
  setStatus(dom.receiverStatus, 'Enter the code from the sender.', 'idle');

  dom.transferPanel.hidden = true;
  dom.transferRole.textContent = 'Transfer';
  dom.transferTitle.textContent = 'file';
  dom.transferTitle.removeAttribute('title');
  dom.transferBadge.textContent = 'Transferring';
  dom.transferBadge.dataset.tone = 'busy';
  dom.progress.value = 0;
  dom.progress.removeAttribute('aria-valuetext');
  dom.progressPercent.textContent = '0%';
  dom.progressBytes.textContent = '0 B / 0 B';
  dom.metricStatus.textContent = '—';
  dom.metricSpeed.textContent = '—';
  dom.metricEta.textContent = '—';
  dom.metricRemaining.textContent = '—';
  dom.downloadLink.hidden = true;
  dom.downloadLink.removeAttribute('href');
  dom.downloadLink.removeAttribute('download');
  dom.downloadLink.removeAttribute('title');
  dom.downloadLink.textContent = 'Download file';
  dom.transferHint.hidden = true;
  dom.transferHint.textContent = '';
  dom.transferHint.dataset.tone = 'warn';
  dom.transferReset.textContent = 'Start over';

  hideAlert();
  state.resetting = false;

  if (toLanding) {
    showView('landing');
    dom.btnSend.focus({ preventScroll: true });
  }
}

function requestReset() {
  const active = state.phase === 'transferring' || state.phase === 'finalizing';
  if (active && !window.confirm('Cancel the current transfer?')) return;
  resetApp();
}

async function copyCode() {
  const code = state.code;
  if (!code) return;

  let copied = false;
  try {
    await Promise.race([
      navigator.clipboard.writeText(code),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Clipboard write timed out.')), 800);
      }),
    ]);
    copied = true;
  } catch {
    // Clipboard API may be unavailable, blocked, or slow on insecure origins.
  }

  if (!copied) {
    let textarea = null;
    try {
      textarea = document.createElement('textarea');
      textarea.value = code;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      textarea?.remove();
    }
  }

  if (copied) {
    dom.btnCopy.textContent = 'Copied';
    clearTimeout(state.copyTimer);
    state.copyTimer = setTimeout(() => {
      dom.btnCopy.textContent = 'Copy';
    }, 1500);
  } else {
    showAlert('Could not copy automatically. Select the code and copy it manually.', {
      tone: 'info',
      autoHideMs: 4000,
    });
  }
}

function onFileChange() {
  const file = dom.fileInput.files?.[0] || null;
  state.file = file;
  dom.fileInfo.hidden = !file;
  dom.fileNote.hidden = true;
  dom.fileNote.textContent = '';

  if (!file) {
    dom.fileName.textContent = '';
    dom.fileSize.textContent = '';
    updateSendButton();
    return;
  }

  dom.fileName.textContent = file.name;
  dom.fileSize.textContent = formatBytes(file.size);

  if (file.size > APP_CONFIG.maxFileSize) {
    dom.fileNote.hidden = false;
    dom.fileNote.dataset.tone = 'error';
    dom.fileNote.textContent = `This file is larger than the ${APP_CONFIG.maxFileSize / (1024 * 1024 * 1024)} GB limit.`;
  } else if (file.size > APP_CONFIG.largeFileWarning) {
    dom.fileNote.hidden = false;
    dom.fileNote.dataset.tone = 'warn';
    dom.fileNote.textContent = 'Large file: keep both tabs open and in the foreground. On low-memory devices this may fail.';
  }

  updateSendButton();
}

function onCodeInput() {
  const digits = dom.codeInput.value.replace(/\D/g, '').slice(0, APP_CONFIG.codeLength);
  if (dom.codeInput.value !== digits) dom.codeInput.value = digits;
  dom.codeInput.setAttribute('aria-invalid', 'false');

  const busy = isBusy() || state.phase === 'connected';
  dom.btnConnect.disabled = digits.length !== APP_CONFIG.codeLength || busy;
}

function showSignalingWarning() {
  showAlert('Signaling server disconnected. Reconnecting… Existing transfers can continue.', {
    tone: 'warning',
    key: 'signaling',
  });

  if (state.role === 'sender' && state.phase === 'waiting') {
    setStatus(dom.senderStatus, 'Signaling server disconnected. Reconnecting…', 'warn');
  } else if (state.role === 'receiver' && state.phase === 'connected') {
    setStatus(dom.receiverStatus, 'Signaling server disconnected. Reconnecting…', 'warn');
  }
}

function hideSignalingWarning() {
  hideAlert('signaling');
  if (state.role === 'sender' && state.phase === 'waiting') {
    setStatus(dom.senderStatus, 'Waiting for a receiver to connect…', 'busy');
  } else if (state.role === 'receiver' && state.phase === 'connected') {
    setStatus(dom.receiverStatus, 'Connected! Waiting for the sender to choose a file…', 'ok');
  }
}

async function startSender() {
  resetApp({ toLanding: false, notifyPeer: false });
  showView('sender');
  state.role = 'sender';
  state.phase = 'starting';
  setStatus(dom.senderStatus, 'Connecting to the signaling server…', 'busy');
  dom.senderCode.textContent = '------';
  dom.btnCopy.disabled = true;
  dom.btnSendFile.disabled = true;
  dom.senderReset.hidden = false;
  dom.senderReset.textContent = 'Cancel';
  setFilePickerEnabled(true);

  const session = new Session({
    role: 'sender',
    handlers: {
      onCode: (code) => {
        if (state.session !== session) return;
        state.code = code;
        dom.senderCode.textContent = code;
        dom.senderCode.setAttribute('aria-label', `Room code ${code}`);
        dom.btnCopy.disabled = false;
        setStatus(dom.senderStatus, 'Waiting for a receiver to connect…', 'busy');
      },
      onConnection: (dc) => {
        if (state.session !== session) return;
        onSenderConnected(dc);
      },
      onData: (data) => {
        if (state.session !== session) return;
        onSenderData(data);
      },
      onClose: () => {
        if (state.session !== session) return;
        onSenderConnectionClosed();
      },
      onConnectionError: (error) => {
        if (state.session !== session) return;
        onSenderConnectionError(error);
      },
      onSignalingDisconnected: () => {
        if (state.session !== session) return;
        showSignalingWarning();
      },
      onSignalingReconnected: () => {
        if (state.session !== session) return;
        hideSignalingWarning();
      },
      onPeerClose: () => {
        if (state.session !== session || state.phase === 'done') return;
        if (state.phase === 'error') return;
        if (state.transfer) {
          failSenderTransfer('The signaling connection closed during the transfer.');
          return;
        }
        state.phase = 'error';
        setStatus(dom.senderStatus, 'The signaling connection closed.', 'error');
        showAlert('The signaling connection closed. Start over to try again.', {
          tone: 'error',
          actionLabel: 'Start over',
          onAction: () => resetApp(),
        });
      },
      onError: (error) => {
        if (state.session !== session) return;
        onSessionError(error);
      },
    },
  });

  state.session = session;

  try {
    await session.startSender();
    if (state.session !== session) return;
    if (state.phase === 'starting') {
      state.phase = 'waiting';
      setStatus(dom.senderStatus, 'Waiting for a receiver to connect…', 'busy');
    }
  } catch (error) {
    if (state.session !== session || error.code === 'canceled') return;
    state.phase = 'error';
    setStatus(dom.senderStatus, error.message, 'error');
    showAlert(error.message, {
      tone: 'error',
      actionLabel: 'Try again',
      onAction: () => startSender(),
    });
  }
}

function onSenderConnected() {
  state.phase = 'connected';
  hideAlert('signaling');
  setStatus(dom.senderStatus, 'Receiver connected. Choose a file to send.', 'ok');
  setFilePickerEnabled(true);
  updateSendButton();
}

function onSenderData(data) {
  if (state.role !== 'sender') return;
  const message = parseControl(data);
  if (!message) return;

  if (message.type === 'ack') {
    if (!state.transfer || message.id !== state.transfer.id) return;
    if (state.phase !== 'transferring' && state.phase !== 'finalizing') return;
    const received = Number(message.received);
    if (!Number.isFinite(received)) return;
    const acked = clamp(Math.floor(received), 0, state.transfer.size);
    if (acked > state.transfer.ackedBytes) {
      state.transfer.ackedBytes = acked;
      state.speedMeter.add(acked);
      updateTransferUI();
    }
    return;
  }

  if (message.type === 'complete') {
    if (!state.transfer || message.id !== state.transfer.id) return;
    if (state.phase !== 'transferring' && state.phase !== 'finalizing') return;
    const received = Number(message.received);
    if (Number.isFinite(received) && received < state.transfer.size) {
      failSenderTransfer('The receiver confirmed an incomplete transfer.');
      return;
    }
    completeSenderTransfer();
    return;
  }

  if (message.type === 'error') {
    if (state.phase === 'done' || state.phase === 'error') return;
    if (state.transfer && message.id && message.id !== state.transfer.id) return;
    const text = String(message.message || 'The receiver reported an error.').slice(0, 300);
    if (state.transfer) failSenderTransfer(text);
    else showAlert(text, { tone: 'error', autoHideMs: 6000 });
    return;
  }

  if (message.type === 'cancel') {
    if (state.phase === 'done' || state.phase === 'error') return;
    if (state.transfer && message.id && message.id !== state.transfer.id) return;
    const text = String(message.reason || 'The receiver canceled the transfer.').slice(0, 300);
    if (state.transfer) cancelSenderTransfer(text);
    else showAlert(text, { tone: 'warning', autoHideMs: 6000 });
  }
}

function completeSenderTransfer() {
  if (!state.transfer || state.phase === 'done') return;

  clearTimeout(state.completeTimer);
  state.completeTimer = null;
  hideAlert('complete-timeout');

  state.phase = 'done';
  state.transfer.ackedBytes = state.transfer.size;
  stopTicker();
  updateTransferUI();

  setTransferStatus('Done', 'ok', 'Done');
  dom.progress.value = 100;
  dom.progressPercent.textContent = '100%';
  dom.progressBytes.textContent = `${formatBytes(state.transfer.size)} / ${formatBytes(state.transfer.size)}`;
  dom.metricSpeed.textContent = '—';
  dom.metricEta.textContent = '0s';
  dom.metricRemaining.textContent = '0 B';
  dom.downloadLink.hidden = true;
  setTransferHint('', 'warn');
  dom.transferReset.textContent = 'Start over';
  dom.senderReset.hidden = true;
  dom.receiverReset.hidden = true;
  setStatus(dom.senderStatus, 'File sent successfully.', 'ok');
}

function failSenderTransfer(message) {
  const text = String(message || 'The transfer failed.').slice(0, 300);
  if (state.abortController) state.abortController.abort();
  stopTicker();
  clearTimeout(state.completeTimer);
  state.completeTimer = null;
  hideAlert('complete-timeout');

  state.phase = 'error';
  setTransferStatus('Failed', 'error', 'Transfer failed');
  setTransferHint(text, 'error');
  dom.transferReset.textContent = 'Start over';
  dom.downloadLink.hidden = true;
  dom.senderReset.hidden = true;
  dom.receiverReset.hidden = true;
  setStatus(dom.senderStatus, 'Transfer failed.', 'error');
  showAlert(text, {
    tone: 'error',
    actionLabel: 'Start over',
    onAction: () => resetApp(),
  });
}

function cancelSenderTransfer(message) {
  const text = String(message || 'The receiver canceled the transfer.').slice(0, 300);
  if (state.abortController) state.abortController.abort();
  stopTicker();
  clearTimeout(state.completeTimer);
  state.completeTimer = null;
  hideAlert('complete-timeout');

  state.phase = 'error';
  setTransferStatus('Canceled', 'warn', 'Transfer canceled');
  setTransferHint(text, 'warn');
  dom.transferReset.textContent = 'Start over';
  dom.downloadLink.hidden = true;
  dom.senderReset.hidden = true;
  dom.receiverReset.hidden = true;
  setStatus(dom.senderStatus, 'Transfer canceled.', 'warn');
  showAlert(text, {
    tone: 'warning',
    actionLabel: 'Start over',
    onAction: () => resetApp(),
  });
}

function onSenderConnectionClosed() {
  if (state.phase === 'done' || state.phase === 'error') return;

  if (state.transfer && (state.phase === 'transferring' || state.phase === 'finalizing')) {
    if (state.abortController) state.abortController.abort();
    failSenderTransfer('The receiver disconnected during the transfer.');
    return;
  }

  state.phase = 'waiting';
  state.transfer = null;
  state.abortController = null;
  stopTicker();
  clearTimeout(state.completeTimer);
  state.completeTimer = null;
  dom.transferPanel.hidden = true;
  dom.senderReset.hidden = false;
  dom.receiverReset.hidden = false;
  setFilePickerEnabled(true);
  updateSendButton();
  setStatus(dom.senderStatus, 'Receiver disconnected. Waiting for a new receiver…', 'busy');
  showAlert('Receiver disconnected. Waiting for a new receiver…', { tone: 'info', autoHideMs: 4000 });
}

function onSenderConnectionError(error) {
  if (state.phase === 'done' || state.phase === 'error') return;
  if (state.transfer) {
    failSenderTransfer(error.message);
    return;
  }
  state.phase = 'waiting';
  setFilePickerEnabled(true);
  updateSendButton();
  setStatus(dom.senderStatus, 'Connection error. Waiting for a new receiver…', 'warn');
  showAlert(error.message, {
    tone: 'warning',
    actionLabel: 'Start over',
    onAction: () => resetApp(),
  });
}

function onSessionError(error) {
  if (state.resetting || state.phase === 'done') return;

  if (error.code === 'network' && (state.phase === 'transferring' || state.phase === 'finalizing')) {
    showAlert('The signaling server is unavailable, but your transfer can continue.', {
      tone: 'warning',
      key: 'signaling',
    });
    return;
  }

  if (state.abortController) state.abortController.abort();
  stopTicker();
  clearTimeout(state.completeTimer);
  state.completeTimer = null;
  hideAlert('complete-timeout');
  state.phase = 'error';

  if (state.role === 'sender') {
    setStatus(dom.senderStatus, error.message, 'error');
    if (state.transfer) {
      setTransferStatus('Failed', 'error', 'Transfer failed');
      setTransferHint(error.message, 'error');
      dom.transferReset.textContent = 'Start over';
      dom.senderReset.hidden = true;
      showAlert(error.message, {
        tone: 'error',
        actionLabel: 'Start over',
        onAction: () => resetApp(),
      });
    } else {
      showAlert(error.message, {
        tone: 'error',
        actionLabel: 'Try again',
        onAction: () => startSender(),
      });
    }
    return;
  }

  setStatus(dom.receiverStatus, error.message, 'error');
  if (state.transfer) {
    state.receiver?.abort({ notify: false });
    setTransferStatus('Failed', 'error', 'Transfer failed');
    setTransferHint(error.message, 'error');
    dom.transferReset.textContent = 'Start over';
    dom.downloadLink.hidden = true;
    dom.receiverReset.hidden = true;
    showAlert(error.message, {
      tone: 'error',
      actionLabel: 'Start over',
      onAction: () => resetApp(),
    });
  } else {
    dom.codeInput.disabled = false;
    dom.btnConnect.disabled = !isValidCode(dom.codeInput.value);
    dom.receiverReset.hidden = false;
    dom.receiverReset.textContent = 'Back';
    showAlert(error.message, {
      tone: 'error',
      actionLabel: 'Try again',
      onAction: () => connectReceiver(),
    });
  }
}

async function sendSelectedFile() {
  if (state.role !== 'sender' || state.phase !== 'connected' || !state.file) return;

  const session = state.session;
  const dc = session?.dc;
  if (!session || !dc || dc.readyState !== 'open') {
    showAlert('The receiver is not connected. Wait for a receiver and try again.', {
      tone: 'error',
      autoHideMs: 6000,
    });
    return;
  }

  const file = state.file;
  if (file.size > APP_CONFIG.maxFileSize) {
    showAlert(`Files are limited to ${APP_CONFIG.maxFileSize / (1024 * 1024 * 1024)} GB in this version.`, {
      tone: 'error',
    });
    return;
  }

  const transfer = {
    id: createTransferId(),
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    sentBytes: 0,
    ackedBytes: 0,
  };

  state.transfer = transfer;
  state.phase = 'transferring';
  state.speedMeter.reset();
  state.abortController = new AbortController();

  showTransferPanel({ role: 'sender', name: file.name, size: file.size });
  setTransferStatus('Sending', 'busy', 'Transferring');
  startTicker();
  setFilePickerEnabled(false);
  dom.btnSendFile.disabled = true;
  dom.senderReset.hidden = true;
  dom.receiverReset.hidden = true;
  setStatus(dom.senderStatus, 'Sending file…', 'busy');

  try {
    await sendFile({
      dc,
      file,
      transferId: transfer.id,
      signal: state.abortController.signal,
      onSent: (sent) => {
        if (state.transfer === transfer) transfer.sentBytes = sent;
      },
    });

    if (state.session !== session || state.transfer !== transfer) return;
    if (state.phase === 'done' || state.phase === 'error') return;

    state.phase = 'finalizing';
    setTransferStatus('Confirming', 'busy', 'Waiting for receiver…');
    dom.transferReset.textContent = 'Cancel transfer';

    state.completeTimer = setTimeout(() => {
      if (state.transfer !== transfer || state.phase !== 'finalizing') return;
      setTransferStatus('Waiting', 'warn', 'Waiting for confirmation');
      setTransferHint('The receiver has not confirmed yet. The file may still arrive; check the receiver tab.', 'warn');
      showAlert('The receiver has not confirmed the transfer yet. Keep both tabs open.', {
        tone: 'warning',
        key: 'complete-timeout',
      });
    }, APP_CONFIG.completeTimeoutMs);
  } catch (error) {
    if (state.session !== session || state.transfer !== transfer) return;
    if (error?.name === 'AbortError' || error?.code === 'canceled') return;
    failSenderTransfer(error?.message || 'The transfer failed.');
  }
}


function startReceiverFlow() {
  resetApp({ toLanding: false, notifyPeer: false });
  showView('receiver');
  state.role = 'receiver';
  state.phase = 'idle';
  dom.codeInput.disabled = false;
  dom.codeInput.value = '';
  dom.codeInput.setAttribute('aria-invalid', 'false');
  dom.btnConnect.disabled = true;
  dom.receiverReset.hidden = false;
  dom.receiverReset.textContent = 'Back';
  setStatus(dom.receiverStatus, 'Enter the code from the sender.', 'idle');
  dom.codeInput.focus();
}

async function connectReceiver() {
  if (state.role !== 'receiver') return;
  if (isBusy() || state.phase === 'connected') return;

  const code = dom.codeInput.value.trim();
  if (!isValidCode(code)) {
    dom.codeInput.setAttribute('aria-invalid', 'true');
    setStatus(dom.receiverStatus, `Enter the ${APP_CONFIG.codeLength}-digit code.`, 'error');
    dom.codeInput.focus();
    return;
  }

  if (state.session) {
    const oldSession = state.session;
    state.session = null;
    oldSession.destroy();
  }
  if (state.receiver) {
    state.receiver.abort({ notify: false });
    state.receiver = null;
  }

  state.phase = 'connecting';
  state.code = code;
  dom.codeInput.disabled = true;
  dom.btnConnect.disabled = true;
  dom.receiverReset.hidden = false;
  dom.receiverReset.textContent = 'Cancel';
  setStatus(dom.receiverStatus, 'Connecting to the sender…', 'busy');
  hideAlert();

  const session = new Session({
    role: 'receiver',
    handlers: {
      onConnection: () => {
        if (state.session !== session) return;
        state.phase = 'connected';
        setStatus(dom.receiverStatus, 'Connected! Waiting for the sender to choose a file…', 'ok');
        dom.codeInput.disabled = true;
        dom.btnConnect.disabled = true;
        dom.receiverReset.hidden = false;
        dom.receiverReset.textContent = 'Cancel';
        if (!state.receiver) state.receiver = createFileReceiver(session);
      },
      onData: (data) => {
        if (state.session !== session) return;
        if (!state.receiver) state.receiver = createFileReceiver(session);
        state.receiver.handleData(data).catch((error) => {
          if (state.session !== session) return;
          onReceiverError(error, session);
        });
      },
      onClose: () => {
        if (state.session !== session) return;
        onReceiverConnectionClosed();
      },
      onConnectionError: (error) => {
        if (state.session !== session) return;
        onReceiverConnectionError(error);
      },
      onSignalingDisconnected: () => {
        if (state.session !== session) return;
        showSignalingWarning();
      },
      onSignalingReconnected: () => {
        if (state.session !== session) return;
        hideSignalingWarning();
      },
      onPeerClose: () => {
        if (state.session !== session || state.phase === 'done' || state.phase === 'error') return;
        onReceiverConnectionClosed();
      },
      onError: (error) => {
        if (state.session !== session) return;
        onSessionError(error);
      },
    },
  });

  state.session = session;

  try {
    await session.startReceiver(code);
    if (state.session !== session || state.phase === 'error') return;
    if (state.phase === 'connecting') {
      state.phase = 'connected';
      setStatus(dom.receiverStatus, 'Connected! Waiting for the sender to choose a file…', 'ok');
      dom.codeInput.disabled = true;
      dom.btnConnect.disabled = true;
      dom.receiverReset.hidden = false;
      dom.receiverReset.textContent = 'Cancel';
    }
    if (!state.receiver) state.receiver = createFileReceiver(session);
  } catch (error) {
    if (state.session !== session || error.code === 'canceled') return;
    state.phase = 'error';
    setStatus(dom.receiverStatus, error.message, 'error');
    dom.codeInput.disabled = false;
    dom.btnConnect.disabled = !isValidCode(code);
    dom.receiverReset.hidden = false;
    dom.receiverReset.textContent = 'Back';
    showAlert(error.message, {
      tone: 'error',
      actionLabel: 'Try again',
      onAction: () => connectReceiver(),
    });
  }
}

function createFileReceiver(session) {
  return new FileReceiver({
    maxSize: APP_CONFIG.maxFileSize,
    sendControl: (message) => session.send(JSON.stringify(message)),
    onMeta: (meta) => {
      if (state.session !== session) return;
      onReceiverMeta(meta, session);
    },
    onProgress: ({ received }) => {
      if (state.session !== session) return;
      onReceiverProgress(received, session);
    },
    onFinishing: () => {
      if (state.session !== session) return;
      state.phase = 'finalizing';
      setTransferStatus('Preparing', 'busy', 'Preparing download…');
    },
    onDone: (result) => {
      if (state.session !== session) return;
      onReceiverDone(result, session);
    },
    onError: (error) => {
      if (state.session !== session) return;
      onReceiverError(error, session);
    },
    onCancel: (reason) => {
      if (state.session !== session) return;
      onReceiverCancel(reason, session);
    },
  });
}

function onReceiverMeta(meta, session) {
  if (state.session !== session) return;

  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
  dom.downloadLink.hidden = true;
  dom.downloadLink.removeAttribute('href');

  state.transfer = {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    receivedBytes: 0,
  };
  state.phase = 'transferring';
  state.speedMeter.reset();

  showTransferPanel({ role: 'receiver', name: meta.name, size: meta.size });
  setTransferStatus('Receiving', 'busy', 'Receiving');
  startTicker();
  updateTransferUI();
  setStatus(dom.receiverStatus, `Receiving ${meta.name}…`, 'busy');
  dom.receiverReset.hidden = true;
  dom.senderReset.hidden = true;

  if (meta.size > APP_CONFIG.largeFileWarning) {
    setTransferHint('Large file: keep both tabs open and in the foreground.', 'warn');
  }
}

function onReceiverProgress(received, session) {
  if (state.session !== session || !state.transfer) return;
  state.transfer.receivedBytes = received;
  state.speedMeter.add(received);
}

function onReceiverDone(result, session) {
  if (state.session !== session || !state.transfer) return;

  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }

  // Let this throw before the UI claims success; FileReceiver will report the
  // error to both sides if the device cannot allocate the download URL.
  const url = URL.createObjectURL(result.blob);
  state.downloadUrl = url;

  state.transfer.receivedBytes = state.transfer.size;
  state.phase = 'done';
  stopTicker();
  updateTransferUI();

  setTransferStatus('Done', 'ok', 'Done');
  dom.progress.value = 100;
  dom.progressPercent.textContent = '100%';
  dom.progressBytes.textContent = `${formatBytes(state.transfer.size)} / ${formatBytes(state.transfer.size)}`;
  dom.metricSpeed.textContent = '—';
  dom.metricEta.textContent = '0s';
  dom.metricRemaining.textContent = '0 B';
  dom.downloadLink.hidden = false;
  setTransferHint('', 'warn');
  dom.transferReset.textContent = 'Start over';
  dom.receiverReset.hidden = true;
  dom.senderReset.hidden = true;
  setStatus(dom.receiverStatus, 'File received. Use the download button if it did not start.', 'ok');

  const safeName = sanitizeFileName(result.name);

  dom.downloadLink.href = url;
  dom.downloadLink.download = safeName;
  dom.downloadLink.textContent = 'Download file';
  dom.downloadLink.title = safeName;

  try {
    dom.downloadLink.click();
  } catch {
    // The visible link is the fallback if the automatic download is blocked.
  }
}

function onReceiverError(error, session) {
  if (state.session !== session || state.phase === 'done') return;

  state.receiver?.abort({ notify: false });
  stopTicker();
  clearTimeout(state.completeTimer);
  state.completeTimer = null;
  state.phase = 'error';

  if (state.transfer) {
    setTransferStatus('Failed', 'error', 'Transfer failed');
    setTransferHint(error.message || 'The transfer failed.', 'error');
    dom.transferReset.textContent = 'Start over';
    dom.downloadLink.hidden = true;
    dom.receiverReset.hidden = true;
    setStatus(dom.receiverStatus, 'Transfer failed.', 'error');
    showAlert(error.message || 'The transfer failed.', {
      tone: 'error',
      actionLabel: 'Start over',
      onAction: () => resetApp(),
    });
    return;
  }

  setStatus(dom.receiverStatus, error.message || 'The transfer failed.', 'error');
  dom.codeInput.disabled = false;
  dom.btnConnect.disabled = !isValidCode(dom.codeInput.value);
  dom.receiverReset.hidden = false;
  dom.receiverReset.textContent = 'Back';
  showAlert(error.message || 'The transfer failed.', {
    tone: 'error',
    actionLabel: 'Try again',
    onAction: () => connectReceiver(),
  });
}

function onReceiverCancel(reason, session) {
  if (state.session !== session || state.phase === 'done') return;

  stopTicker();
  clearTimeout(state.completeTimer);
  state.completeTimer = null;
  state.phase = 'error';
  setTransferStatus('Canceled', 'warn', 'Canceled');
  setTransferHint(String(reason || 'The sender canceled the transfer.').slice(0, 300), 'warn');
  dom.transferReset.textContent = 'Start over';
  dom.downloadLink.hidden = true;
  dom.receiverReset.hidden = true;
  setStatus(dom.receiverStatus, 'Transfer canceled by the sender.', 'warn');
  showAlert(String(reason || 'The sender canceled the transfer.').slice(0, 300), {
    tone: 'warning',
    actionLabel: 'Start over',
    onAction: () => resetApp(),
  });
}

function onReceiverConnectionClosed() {
  if (state.phase === 'done' || state.phase === 'error') return;

  if (state.transfer) {
    state.receiver?.abort({ notify: false });
    stopTicker();
    clearTimeout(state.completeTimer);
    state.completeTimer = null;
    state.phase = 'error';
    setTransferStatus('Stopped', 'warn', 'Transfer stopped');
    setTransferHint('The sender canceled or the connection was lost. Start over and ask the sender for a new code.', 'warn');
    dom.transferReset.textContent = 'Start over';
    dom.downloadLink.hidden = true;
    dom.receiverReset.hidden = true;
    setStatus(dom.receiverStatus, 'Transfer stopped.', 'warn');
    showAlert('The sender canceled or the connection was lost.', {
      tone: 'warning',
      actionLabel: 'Start over',
      onAction: () => resetApp(),
    });
    return;
  }

  state.phase = 'error';
  setStatus(dom.receiverStatus, 'Sender disconnected.', 'error');
  dom.codeInput.disabled = false;
  dom.btnConnect.disabled = !isValidCode(dom.codeInput.value);
  dom.receiverReset.hidden = false;
  dom.receiverReset.textContent = 'Back';
  showAlert('The sender disconnected.', {
    tone: 'error',
    actionLabel: 'Try again',
    onAction: () => connectReceiver(),
  });
}

function onReceiverConnectionError(error) {
  if (state.phase === 'done' || state.phase === 'error') return;

  if (state.transfer) {
    state.receiver?.abort({ notify: false });
    stopTicker();
    clearTimeout(state.completeTimer);
    state.completeTimer = null;
    state.phase = 'error';
    setTransferStatus('Failed', 'error', 'Transfer failed');
    setTransferHint(error.message, 'error');
    dom.transferReset.textContent = 'Start over';
    dom.downloadLink.hidden = true;
    dom.receiverReset.hidden = true;
    setStatus(dom.receiverStatus, 'Transfer failed.', 'error');
    showAlert(error.message, {
      tone: 'error',
      actionLabel: 'Start over',
      onAction: () => resetApp(),
    });
    return;
  }

  state.phase = 'error';
  setStatus(dom.receiverStatus, error.message, 'error');
  dom.codeInput.disabled = false;
  dom.btnConnect.disabled = !isValidCode(dom.codeInput.value);
  dom.receiverReset.hidden = false;
  dom.receiverReset.textContent = 'Back';
  showAlert(error.message, {
    tone: 'error',
    actionLabel: 'Try again',
    onAction: () => connectReceiver(),
  });
}


function isBusy() {
  return (
    state.phase === 'starting' ||
    state.phase === 'connecting' ||
    state.phase === 'transferring' ||
    state.phase === 'finalizing'
  );
}

function isActiveTransfer() {
  return state.phase === 'transferring' || state.phase === 'finalizing';
}

function wireEvents() {
  dom.btnSend.addEventListener('click', () => {
    void startSender();
  });

  dom.btnReceive.addEventListener('click', () => {
    startReceiverFlow();
  });

  dom.senderBack.addEventListener('click', () => {
    requestReset();
  });
  dom.senderReset.addEventListener('click', () => {
    requestReset();
  });

  dom.receiverBack.addEventListener('click', () => {
    requestReset();
  });
  dom.receiverReset.addEventListener('click', () => {
    requestReset();
  });

  dom.transferReset.addEventListener('click', () => {
    requestReset();
  });

  dom.btnCopy.addEventListener('click', () => {
    void copyCode();
  });

  dom.fileInput.addEventListener('change', () => {
    onFileChange();
  });

  dom.btnSendFile.addEventListener('click', () => {
    void sendSelectedFile();
  });

  dom.codeInput.addEventListener('input', () => {
    onCodeInput();
  });

  dom.codeInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!dom.btnConnect.disabled) void connectReceiver();
  });

  dom.btnConnect.addEventListener('click', () => {
    void connectReceiver();
  });

  dom.alertDismiss.addEventListener('click', () => {
    hideAlert();
  });

  dom.alertAction.addEventListener('click', () => {
    const action = state.alertAction;
    hideAlert();
    if (typeof action === 'function') action();
  });

  window.addEventListener('beforeunload', (event) => {
    if (!isActiveTransfer()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // If the tab is hidden mid-transfer, browsers may throttle timers. This is a
  // heads-up only; the transfer itself keeps running.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !isActiveTransfer()) return;
    if (state.role === 'sender' && state.transfer && state.transfer.ackedBytes < state.transfer.size) {
      setTransferHint('This tab is in the background. Keep it visible for the fastest transfer.', 'warn');
    }
  });
}

function init() {
  wireEvents();
  showView('landing');

  if (location.protocol === 'file:') {
    showAlert('Open this page over HTTP or HTTPS. Browsers block WebRTC connections on file:// pages.', {
      tone: 'error',
    });
    return;
  }

  if (!globalThis.RTCPeerConnection || !globalThis.Peer) {
    showAlert('This browser does not support WebRTC data channels or PeerJS failed to load.', {
      tone: 'error',
    });
  }
}

init();
