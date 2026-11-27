import { APP_CONFIG } from './config.js';

/** Generate a cryptographically random numeric room code. */
export function generateCode(length = APP_CONFIG.codeLength) {
  const digits = '0123456789';
  const bytes = new Uint8Array(length * 2);
  crypto.getRandomValues(bytes);

  let code = '';
  let index = 0;
  while (code.length < length) {
    if (index >= bytes.length) {
      crypto.getRandomValues(bytes);
      index = 0;
    }
    const value = bytes[index++];
    // Rejection sampling avoids modulo bias (250 is the largest multiple of 10 below 256).
    if (value < 250) code += digits[value % 10];
  }
  return code;
}

export function isValidCode(code) {
  return typeof code === 'string' && new RegExp(`^\\d{${APP_CONFIG.codeLength}}$`).test(code);
}

export function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const places = exponent === 0 ? 0 : value >= 100 ? 0 : decimals;
  return `${value.toFixed(places)} ${units[exponent]}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.ceil(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m ${secs.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, '0')}m`;
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.max(0, Math.min(100, value)).toFixed(value >= 10 ? 0 : 1)}%`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Make a file name safe for the download attribute. */
export function sanitizeFileName(name) {
  if (typeof name !== 'string') return 'download';
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || 'download').slice(0, 200);
}

export function createTransferId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Tracks transfer speed over a sliding time window using cumulative byte counts.
 */
export class SpeedMeter {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  add(totalBytes, now = performance.now()) {
    if (!Number.isFinite(totalBytes) || totalBytes < 0) return;
    this.samples.push({ total: totalBytes, t: now });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  getSpeed(now = performance.now()) {
    if (this.samples.length < 2) return 0;
    const last = this.samples[this.samples.length - 1];
    if (now - last.t > 1500) return 0;
    const first = this.samples[0];
    const seconds = (last.t - first.t) / 1000;
    if (seconds <= 0) return 0;
    return Math.max(0, (last.total - first.total) / seconds);
  }
}
