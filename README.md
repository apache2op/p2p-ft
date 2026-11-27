# P2P Drop

A static, serverless file-transfer web app. The sender shares a 6-digit code and the receiver enters it; the file then travels directly between the two browsers over a WebRTC data channel. No application backend, no uploads, no accounts.

## Features

- **6-digit code pairing** — no links, accounts, or contact exchange.
- **Direct browser-to-browser transfer** — file bytes go over WebRTC, not through an app server.
- **No backend or storage** — deploy as static files.
- **Live progress** — progress bar, transferred/total bytes, speed, ETA, and remaining bytes.
- **Backpressure-aware sending** — 64 KB chunks with buffer watermarks.
- **Cancel and recovery** — cancel from either side, connection-loss handling, signaling reconnect.
- **Download fallback** — visible link if the browser blocks the automatic download.
- **Responsive UI** — dark/light themes, keyboard focus styles, reduced-motion support.
- **1 GB limit** — in-memory MVP, with a warning above 512 MB.

## How to use

1. Open the app on both devices.
2. **Sender:** choose **Send a file** and share the 6-digit code.
3. **Receiver:** choose **Receive a file**, enter the code, and connect.
4. **Sender:** choose a file and click **Send file**.
5. **Receiver:** download the file when the transfer completes.

Keep both tabs open and visible during the transfer.
