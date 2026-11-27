# P2P Drop

A tiny, static peer-to-peer file transfer app. The sender creates a 6-digit room code, the receiver enters it, and the file travels directly between the two browsers over a WebRTC data channel. There is no application server, no upload storage, and no account.

This README covers the implementation, the trade-offs, and the test cases that were used to validate v1.

## Features

- 6-digit numeric room code (sender creates, receiver enters).
- One file per connection, up to 1 GB.
- Direct browser-to-browser transfer over a WebRTC data channel.
- Live progress bar, transferred/total bytes, speed, ETA, and remaining bytes.
- Sender progress is based on receiver acknowledgements, not just bytes handed to the network stack.
- Backpressure so a fast disk/CPU cannot flood the data channel.
- Cancel from either side, connection-loss handling, and signaling reconnect with backoff.
- Download fallback link if the browser blocks the automatic download.
- Responsive dark/light UI with keyboard focus styles and reduced-motion support.
- No build step, no npm dependency at runtime, and no backend.

## How it works

1. The sender opens the app and chooses **Send a file**. PeerJS registers an ID such as `p2p-room-123456` with the signaling service.
2. The receiver enters the 6-digit code. PeerJS performs the WebRTC handshake and the browsers open a data channel.
3. The sender picks one file. The file is read in 64 KB chunks and sent over the data channel.
4. The receiver validates the metadata, assembles the chunks into a `Blob`, and offers the file as a download.

Only the signaling handshake goes through PeerJS. File bytes go peer-to-peer over WebRTC. If a direct route cannot be established, a STUN/TURN server may relay the encrypted WebRTC traffic; the app does not upload the file to an application server.

## Implementation

### Project layout

```
v1/
  index.html          # landing, sender, receiver, and transfer panel markup
  style.css           # responsive dark/light UI
  js/
    config.js         # app, transfer, timeout, and PeerJS settings
    utils.js          # code generation, validation, formatting, speed meter
    session.js        # PeerJS lifecycle and connection management
    transfer.js       # chunking, backpressure, receiver state machine
    main.js           # UI state machine and event wiring
  vendor/
    peerjs.min.js     # PeerJS 1.5.5 (MIT)
    peerjs.LICENSE
```

The app uses native ES modules (`<script type="module">`) and plain CSS. There is no bundler and no generated output. All resource paths in `index.html` are relative, so the folder can be served from a domain root or a repository subpath.

### Signaling and room codes

- `utils.js` generates a 6-digit code with `crypto.getRandomValues`.
- The sender registers `p2p-room-<code>` with PeerJS. If the ID is already taken, `session.js` retries with a new code (up to three attempts).
- The receiver connects to the same ID. A missing sender produces a clear "No sender found with that code" error.
- PeerJS is vendored locally, so the app does not depend on a CDN at runtime. The default signaling service is the public PeerJS cloud; `js/config.js` can point at a self-hosted PeerServer instead.

### Raw data channel

PeerJS's default `binary` serialization wraps messages in its own binarypack format and installs a data listener that can interfere with raw file chunks. This app passes:

```js
peer.connect(id, {
  reliable: true,
  serialization: 'raw',
  metadata: { role: 'receiver' },
});
```

and then uses `conn.dataChannel` directly. This gives the transfer code access to `bufferedAmount`, `bufferedAmountLowThreshold`, and the `bufferedamountlow` event. The receiver sets `binaryType = 'arraybuffer'` and reads all incoming data through PeerJS's single `conn.on('data')` path.

### Transfer protocol

Control messages are JSON strings; file payloads are binary `ArrayBuffer`s. Every message carries a transfer `id` so stale messages from a canceled or previous transfer are ignored.

| Direction | Message | Payload | Purpose |
| --- | --- | --- | --- |
| Sender → Receiver | `meta` | `v`, `type`, `id`, `name`, `size`, `mime` | Start a transfer. |
| Sender → Receiver | binary | up to 64 KB per chunk | File data. |
| Sender → Receiver | `done` | `id`, `size` | All chunks have been queued. |
| Receiver → Sender | `ack` | `id`, `received` | Progress acknowledgement. |
| Receiver → Sender | `complete` | `id`, `received` | Blob assembled and handed to the UI. |
| Receiver → Sender | `error` | `id`, `message` | Validation or assembly failure. |
| Receiver → Sender | `cancel` | `id`, `reason` | Receiver cancelled. |
| Sender → Receiver | `cancel` | `id`, `reason` | Sender cancelled. |

The receiver validates the declared size against the 1 GB cap, checks every chunk for a sane length, rejects data that exceeds the declared total, and only builds the Blob when the received byte count matches. It sends an acknowledgement roughly every 256 KB or 500 ms, whichever comes first, to avoid flooding the control channel with ACKs.

### Chunking and backpressure

`transfer.js` sends 64 KB chunks. Before each chunk it checks `dc.bufferedAmount`:

- Above 4 MB, it waits for `bufferedamountlow` (threshold 1 MB) before continuing.
- The wait has a 30-second stall timeout and responds to the abort signal used by Cancel.
- The sender's visible progress uses ACKed bytes from the receiver, so the bar reflects what the receiver has actually accepted.

This avoids the classic "queue the whole file and hope" failure mode, where the browser buffers hundreds of megabytes and memory use spikes.

### Receiver assembly and download

The receiver keeps chunks in an array and creates a single `Blob` when `done` arrives. It then:

- Sanitizes the filename for the download attribute.
- Creates an object URL and updates a visible **Download file** link.
- Attempts an automatic download, with the visible link as the fallback if the browser blocks it.
- Revokes the previous object URL when a new transfer starts or the app resets.

The 1 GB limit exists because the receiver holds the whole file in memory. Above 512 MB the UI shows a warning about low-memory devices.

### UI state and failure handling

`main.js` keeps a small state machine covering landing, sender, receiver, connecting, transferring, finalizing, done, and error states. Important behaviors:

- The sender can choose a file while waiting, but **Send file** stays disabled until a receiver connects.
- Cancelling an active transfer asks for confirmation and sends a best-effort `cancel` control message before closing.
- A receiver disconnect, sender disconnect, signaling loss, connection error, or assembly error each produce a specific status and recovery action.
- Signaling disconnects show a non-fatal warning and retry with exponential backoff (1 s up to 30 s, six attempts). An existing data channel can keep working while signaling is down.
- `beforeunload` warns if the user tries to close the tab during a transfer.
- If the tab becomes hidden mid-transfer, the UI suggests keeping it visible because browsers throttle background tabs.

## Advantages

- **No backend and no upload.** The file never lands on an application server; the two browsers exchange it directly.
- **Simple deployment.** It is a handful of static files plus a vendored library. GitHub Pages, S3, nginx, or any static host works.
- **No accounts, no database, no storage costs.** The only third-party dependency is signaling/STUN/TURN.
- **Small surface area.** No framework, no build pipeline, no package manager at runtime, and no hidden server code.
- **Thoughtful transfer behavior.** Backpressure, ACK-based progress, stall detection, cancel, and explicit error states make it more than a toy demo.
- **Good default UX.** A single code, one clear action per side, responsive layout, dark/light themes, focus styles, and a download fallback.
- **Privacy-friendly default.** File bytes do not pass through PeerJS; only the handshake does. WebRTC encrypts the data channel in transit.

## Disadvantages and limitations

- **Signaling dependency.** New connections require the PeerJS cloud by default. It has no SLA and can be blocked or rate-limited. A self-hosted PeerServer is recommended for production.
- **Room codes are guessable.** Six digits give one million possibilities. A malicious peer that can reach the signaling service could guess or enumerate a code and connect before the intended receiver. The code is a rendezvous identifier, not a secret.
- **No identity verification.** WebRTC provides transport encryption, but the app does not verify who is on the other end. Do not send sensitive files to an untrusted peer.
- **NAT/firewall failures are possible.** Some networks block peer-to-peer traffic. TURN can relay the connection, but public TURN capacity is not guaranteed; a private TURN service is more reliable.
- **1 GB in-memory cap.** The receiver holds the entire file in memory. Mobile devices can run out of memory well before 1 GB. Larger files need a streaming-to-disk design.
- **One file per connection.** No queue, folder upload, drag-and-drop, or multi-file transfer in v1.
- **No resume.** A dropped connection means starting the transfer again from zero.
- **No cryptographic checksum.** The receiver checks byte counts, but not a SHA-256 or similar digest. For high-assurance use, compare a hash out of band.
- **Background tabs are throttled.** Browsers may slow timers and network work when a tab is hidden. The UI warns, but it cannot override browser policy.
- **No persistence.** Refreshing or closing the page loses the transfer and the download URL.
- **Browser/OS variability.** Mobile Safari and some corporate networks are stricter about WebRTC, downloads, and background execution.

## Test cases

The following checks were run during development. The browser tests used Chromium through the OpenCode browser tool at `http://127.0.0.1:8080`; the protocol tests used a temporary Node harness that imported `transfer.js` with a fake data channel.

| # | Area | Test | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Syntax | `node --check` on every JS module | No syntax errors | Pass |
| 2 | Happy path | 1 MiB + 12,345 byte transfer through the Node harness | `meta` → chunks → `done`, ACKs, `complete`, exact byte count | Pass (19 messages, 5 ACKs) |
| 3 | Empty file | 0-byte file through the Node harness | 0-byte Blob, `complete`, no error | Pass |
| 4 | Backpressure | Force an 8 MiB simulated buffer in the Node harness | Sender pauses, resumes on `bufferedamountlow`, sends all chunks | Pass |
| 5 | Oversized metadata | Receiver receives a `meta` above the cap | Error response, no assembly | Pass |
| 6 | Invalid code | Receiver enters `000000` with no sender | "No sender found…" alert; inputs re-enabled | Pass |
| 7 | Sender cancel | Sender cancels a 20 MiB transfer | Receiver stops with a warning; sender returns to landing | Pass |
| 8 | Receiver cancel | Receiver cancels a 12 MiB transfer | Sender shows "Canceled"; receiver returns to landing | Pass |
| 9 | Sender disconnect | Sender session closed mid-transfer | Receiver shows a stopped/connection-lost warning | Pass |
| 10 | Signaling loss | Force `peer.disconnect()` while waiting | Warning appears, reconnect succeeds, waiting status returns | Pass |
| 11 | Copy code | Click **Copy**; also force the Clipboard API to reject | "Copied" on success; manual-copy alert on failure | Pass |
| 12 | Oversized file UI | Select a simulated >1 GB file | Error note; **Send file** disabled | Pass |
| 13 | Large-file warning | Select a simulated 600 MB file | Warning note; send remains available after connecting | Pass |
| 14 | Download integrity | Send 2 MiB + 12,345 bytes; SHA-256 the downloaded file | Downloaded hash matches the sender's hash | Pass |
| 15 | Larger browser transfer | Send 8 MiB + 12,345 bytes between two tabs | Both sides reach 100% / Done; receiver Blob is 8,400,953 bytes; no console errors | Pass |
| 16 | Responsive layout | 375 px-wide iframe viewport; landing, receiver, sender, transfer panel; long filename | No horizontal overflow; long filename truncates | Pass |
| 17 | Lighthouse | Chrome Lighthouse on the landing page | High accessibility/best-practices/SEO scores | Pass (100 / 100 / 100) |
| 18 | Reset | **Start over** after a completed transfer | Panel hidden, code returns to `------`, file input cleared, Blob URL revoked | Pass |

### Test notes

- The 8 MiB browser test verified the receiver's in-page Blob size; the embedded browser's download capture was unreliable above roughly 5 MiB, so the 2 MiB case was used for byte-for-byte SHA-256 verification. The app itself produced the full Blob in both cases.
- The protocol harness is a temporary development tool and is not part of the deployed `v1/` folder.
- No physical mobile device, Safari, Firefox, real 1 GB transfer, or TURN-only network test was run. Those are the first checks to repeat before treating this as production software.
- The test suite is manual/scripted rather than a committed CI pipeline. The table above is the reproducible acceptance checklist.

## Local development

The app is plain HTML, CSS, and JavaScript. There is no build step and no npm dependency.

Browsers require a secure context for WebRTC and clipboard access, so do not open `index.html` with `file://`. Serve the `v1` folder over HTTP:

```sh
cd v1
python -m http.server 8080
```

Then open <http://localhost:8080> in two tabs or two browsers. `localhost` counts as a secure context.

Any static server works, for example:

```sh
npx serve v1
```

## Deploying to GitHub Pages

All paths are relative, so there is no base-path configuration.

**Option A — publish the app at the repository root.** Copy the contents of `v1/` to the root of the branch you publish (often `main` or `gh-pages`), then in **Settings → Pages** choose **Deploy from a branch**, select the branch, and select `/ (root)`. The app is served at `https://<user>.github.io/<repo>/`.

**Option B — keep the `v1/` folder.** Publish from the repository root and open `https://<user>.github.io/<repo>/v1/`. The relative paths inside `v1/` continue to work.

**Option C — GitHub Actions.** Use `actions/upload-pages-artifact` with `path: v1` and deploy the resulting Pages artifact. This keeps the app in its own folder while publishing it at the site root.

GitHub Pages serves over HTTPS, which satisfies the secure-context requirement for WebRTC and clipboard access.

## Configuration

Edit `js/config.js`:

| Setting | Default | Purpose |
| --- | --- | --- |
| `roomPrefix` | `p2p-room-` | Prefix for PeerJS room IDs. Change it if the public PeerJS namespace is crowded. |
| `codeLength` | `6` | Number of digits in a room code. Also update the input `maxlength`/pattern in `index.html` if you change this. |
| `chunkSize` | `64 KB` | Size of each binary chunk. |
| `highWaterMark` | `4 MB` | Sender pauses when the data channel buffer exceeds this. |
| `lowWaterMark` | `1 MB` | Sender resumes when the buffer drains below this. |
| `bufferWaitTimeoutMs` | `30 s` | Stall timeout while waiting for the buffer to drain. |
| `maxFileSize` | `1 GB` | Hard cap for the in-memory MVP. |
| `largeFileWarning` | `512 MB` | Show a warning above this size. |
| `ackBytes` / `ackIntervalMs` | `256 KB` / `500 ms` | How often the receiver acknowledges progress. |
| `maxChunkSize` | `1 MB` | Largest accepted binary chunk on the receiver. |
| `maxControlLength` | `16 KB` | Largest accepted JSON control message. |
| `peerOpenTimeoutMs` | `25 s` | How long to wait for the signaling connection. |
| `connectTimeoutMs` | `30 s` | How long the receiver waits for the sender. |
| `completeTimeoutMs` | `60 s` | How long the sender waits for final confirmation. |
| `reconnectMaxAttempts` | `6` | Signaling reconnect attempts before giving up. |
| `cancelFlushTimeoutMs` | `3 s` | How long a canceled session waits for queued data and the cancel message to drain before closing. |
| `peer` | `{ debug: 0 }` | PeerJS options. Leave host/port/path unset to use the public PeerJS cloud. |

### Using a self-hosted PeerServer

The public PeerJS cloud is convenient but has no SLA. For production, run your own [PeerServer](https://github.com/peers/peerjs-server) and set:

```js
peer: {
  host: 'peer.example.com',
  port: 443,
  path: '/',
  secure: true,
  debug: 0,
},
```

If you provide a custom `config` object (ICE servers), include your own STUN/TURN entries; otherwise PeerJS's defaults, including its public TURN server, are used. TURN credentials are visible to clients either way, so use short-lived credentials from your own TURN service for anything important.

## Browser support

A modern browser with WebRTC data channel support is required: current Chrome, Edge, Firefox, and Safari. Both tabs must remain open for the duration of the transfer.

## Security notes

- WebRTC data channels use DTLS in transit. The app does not add end-to-end identity or key verification on top of that.
- The room code is generated with `crypto.getRandomValues`, but six digits are not a strong secret. A determined attacker who can reach the signaling service could guess or enumerate a code.
- The receiver sanitizes the download filename and uses a Blob URL, not a server path.
- Do not send secrets to an untrusted peer. A peer that knows the room code can connect before the intended receiver.
- A TURN relay may carry the encrypted WebRTC traffic if a direct connection fails. It cannot read the file contents, but it can observe connection metadata.
- For high-assurance transfers, compare a file hash out of band and use a private signaling/TURN deployment.

## License

App code is provided as-is for this project. PeerJS is included under the MIT license; see `vendor/peerjs.LICENSE`.
