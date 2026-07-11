const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const QRCode = require('qrcode');
const JSONbig = require('json-bigint')({ storeAsString: true });
const fs = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const http = require('node:http');
const dns = require('node:dns').promises;
const execFileAsync = promisify(execFile);
const path = require('node:path');
const PUBLIC_NODES = ['https://node1.mbgcoin.my.id', 'https://node2.mbgcoin.my.id'];
const PUBLIC_NODE_URL = PUBLIC_NODES[0];
let activePublicNode = PUBLIC_NODE_URL;
let primaryRetryAfter = 0;

async function probePublicNode(origin) {
  const response = await fetch(`${origin}/getinfo`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000), cache: 'no-store' });
  if (!response.ok) throw new Error(`${origin} HTTP ${response.status}`);
  const info = await response.json();
  if (info.status && info.status !== 'OK') throw new Error(`${origin} status ${info.status}`);
  return info;
}

async function selectPublicNode() {
  const now = Date.now();
  if (activePublicNode === PUBLIC_NODE_URL || now >= primaryRetryAfter) {
    try { const info = await probePublicNode(PUBLIC_NODE_URL); activePublicNode = PUBLIC_NODE_URL; primaryRetryAfter = 0; return { origin: PUBLIC_NODE_URL, info }; }
    catch (_) { primaryRetryAfter = now + 15000; }
  }
  try { const info = await probePublicNode(PUBLIC_NODES[1]); activePublicNode = PUBLIC_NODES[1]; return { origin: PUBLIC_NODES[1], info }; }
  catch (secondaryError) {
    if (activePublicNode !== PUBLIC_NODE_URL) {
      try { const info = await probePublicNode(PUBLIC_NODE_URL); activePublicNode = PUBLIC_NODE_URL; primaryRetryAfter = 0; return { origin: PUBLIC_NODE_URL, info }; } catch (_) { /* both offline */ }
    }
    throw new Error(`Semua node publik MBG offline: ${secondaryError.message}`);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f5f7fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  window.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('node-info', async (_event, rpcUrl) => {
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//i.test(rpcUrl)) throw new Error('Invalid RPC URL');
  if (/^https:\/\/node\d+\.mbgcoin\.my\.id\/?$/i.test(rpcUrl)) { const selected = await selectPublicNode(); return { ...selected.info, active_node: selected.origin, failover: selected.origin !== PUBLIC_NODE_URL }; }
  const response = await fetch(`${rpcUrl.replace(/\/$/, '')}/getinfo`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  return response.json();
});

ipcMain.handle('public-node-status', async () => { const selected = await selectPublicNode(); return { activeNode: selected.origin, primaryNode: PUBLIC_NODE_URL, nodes: PUBLIC_NODES, failover: selected.origin !== PUBLIC_NODE_URL, height: Number(selected.info.height || 0) }; });

ipcMain.handle('qr-code', async (_event, text) => {
  if (typeof text !== 'string' || !/^RMBG[A-Za-z0-9]+$/.test(text)) throw new Error('Address MBG tidak valid.');
  return QRCode.toDataURL(text, { width: 320, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#101b36', light: '#ffffff' } });
});

ipcMain.handle('copy-text', (_event, text) => {
  if (typeof text !== 'string' || text.length > 500) throw new Error('Teks tidak valid.');
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('open-transaction', async (_event, hash) => {
  if (typeof hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Transaction hash tidak valid.');
  const url = `https://explorer.mbgcoin.my.id/?hash=${encodeURIComponent(hash)}#blockchain_transaction`;
  await shell.openExternal(url);
  return true;
});

const TLS_BRIDGE_PORT = 52692;
const defaultConfig = { rpcUrl: PUBLIC_NODE_URL, walletBinary: path.join(__dirname, '..', 'bin', 'mbgcoin-wallet.exe'), serviceBinary: path.join(__dirname, '..', 'bin', 'mbgcoin-service.exe'), daemonBinary: path.join(__dirname, '..', 'bin', 'mbgcoind.exe'), daemonAddress: PUBLIC_NODE_URL, servicePort: 52682 };
function configPath() { return path.join(app.getPath('userData'), 'mbg-wallet-config.json'); }
function transactionCachePath() { return path.join(app.getPath('userData'), 'transaction-history.json'); }
ipcMain.handle('config-read', async () => {
  try {
    const config = { ...defaultConfig, ...JSON.parse(await fs.readFile(configPath(), 'utf8')) };
    if (config.daemonAddress === '127.0.0.1:52691') config.daemonAddress = PUBLIC_NODE_URL;
    if (config.rpcUrl === 'https://explorer.mbgcoin.my.id/rpc') config.rpcUrl = PUBLIC_NODE_URL;
    return config;
  }
  catch (_) { return defaultConfig; }
});
ipcMain.handle('config-write', async (_event, config) => {
  const safeConfig = {
    rpcUrl: typeof config.rpcUrl === 'string' ? config.rpcUrl : defaultConfig.rpcUrl,
    walletBinary: typeof config.walletBinary === 'string' ? config.walletBinary : defaultConfig.walletBinary,
    serviceBinary: typeof config.serviceBinary === 'string' ? config.serviceBinary : defaultConfig.serviceBinary,
    daemonBinary: typeof config.daemonBinary === 'string' ? config.daemonBinary : defaultConfig.daemonBinary,
    daemonAddress: typeof config.daemonAddress === 'string' ? config.daemonAddress : defaultConfig.daemonAddress,
    servicePort: Number.isInteger(config.servicePort) ? config.servicePort : defaultConfig.servicePort
  };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(safeConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
  return safeConfig;
});

ipcMain.handle('transaction-cache-load', async (_event, address) => {
  if (typeof address !== 'string' || !/^RMBG[1-9A-HJ-NP-Za-km-z]{94}$/.test(address)) return [];
  try {
    const cache = JSON.parse(await fs.readFile(transactionCachePath(), 'utf8'));
    return Array.isArray(cache[address]) ? cache[address] : [];
  } catch (_) { return []; }
});

ipcMain.handle('transaction-cache-save', async (_event, address, transactions) => {
  if (typeof address !== 'string' || !/^RMBG[1-9A-HJ-NP-Za-km-z]{94}$/.test(address)) throw new Error('Address cache tidak valid.');
  if (!Array.isArray(transactions)) throw new Error('Data transaksi tidak valid.');
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(transactionCachePath(), 'utf8')); } catch (_) { /* new cache */ }
  cache[address] = transactions.slice(0, 5000).map(item => ({
    transactionHash: typeof item.transactionHash === 'string' ? item.transactionHash.slice(0, 64) : '',
    localId: typeof item.localId === 'string' ? item.localId.slice(0, 80) : '',
    status: ['Pending', 'Confirmed', 'Failed', 'Dropped'].includes(item.status) ? item.status : 'Pending',
    direction: item.direction === 'Incoming' ? 'Incoming' : 'Outgoing',
    amount: String(item.amount || '0').slice(0, 40), fee: String(item.fee || '0').slice(0, 40),
    address: typeof item.address === 'string' ? item.address.slice(0, 110) : '',
    paymentId: typeof item.paymentId === 'string' ? item.paymentId.slice(0, 64) : '',
    timestamp: Number(item.timestamp || 0), submittedHeight: Number(item.submittedHeight || 0),
    blockIndex: Number(item.blockIndex || 0), confirmations: Number(item.confirmations || 0),
    lastSeenAt: Number(item.lastSeenAt || Date.now()), error: typeof item.error === 'string' ? item.error.slice(0, 300) : ''
  }));
  await fs.mkdir(path.dirname(transactionCachePath()), { recursive: true });
  await fs.writeFile(transactionCachePath(), JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, count: cache[address].length };
});

let walletServiceProcess = null;
let walletServicePort = defaultConfig.servicePort;
let tlsBridgeServer = null;
let tlsBridgeTarget = '';

function validatePublicNodeUrl(value) {
  let target;
  try { target = new URL(String(value)); }
  catch (_) { throw new Error('URL node publik tidak valid.'); }
  if (target.protocol !== 'https:' || target.port || target.username || target.password || target.search || target.hash) {
    throw new Error('Node publik harus memakai URL HTTPS tanpa port, credential, query, atau fragment.');
  }
  if (!/^node\d+\.mbgcoin\.my\.id$/i.test(target.hostname)) throw new Error('TLS bridge hanya mengizinkan node resmi MBG Coin.');
  target.pathname = target.pathname.replace(/\/$/, '');
  return target;
}

async function stopTlsBridge() {
  if (!tlsBridgeServer) return;
  const server = tlsBridgeServer;
  tlsBridgeServer = null;
  tlsBridgeTarget = '';
  await new Promise(resolve => server.close(resolve));
}

async function startTlsBridge(targetValue) {
  validatePublicNodeUrl(targetValue);
  if (tlsBridgeServer && tlsBridgeTarget === 'failover') return { host: '127.0.0.1', port: TLS_BRIDGE_PORT };
  await stopTlsBridge();
  const server = http.createServer((request, response) => {
    if (!['GET', 'POST'].includes(request.method || '')) { response.writeHead(405); response.end(); return; }
    let requestSize = 0;
    const chunks = [];
    request.on('data', chunk => {
      requestSize += chunk.length;
      if (requestSize > 4 * 1024 * 1024) request.destroy(new Error('Request RPC terlalu besar.'));
      else chunks.push(chunk);
    });
    request.on('error', () => { if (!response.headersSent) response.writeHead(400); response.end(); });
    request.on('end', async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const selected = await selectPublicNode();
        const upstreamUrl = new URL(request.url || '/', `${selected.origin}/`);
        if (upstreamUrl.origin !== selected.origin) throw new Error('Path RPC tidak valid.');
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const upstream = await fetch(upstreamUrl, {
          method: request.method,
          headers: { 'Content-Type': request.headers['content-type'] || 'application/json', Accept: request.headers.accept || 'application/json', 'User-Agent': 'MBG-Coin-Wallet-TLS-Bridge/0.1' },
          body,
          redirect: 'error',
          signal: controller.signal
        });
        const payload = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
        response.end(payload);
      } catch (error) {
        const payload = Buffer.from(JSON.stringify({ error: 'TLS bridge gagal menghubungi node publik.' }));
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
        response.end(payload);
      } finally { clearTimeout(timer); }
    });
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 35000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(TLS_BRIDGE_PORT, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  tlsBridgeServer = server;
  tlsBridgeTarget = 'failover';
  return { host: '127.0.0.1', port: TLS_BRIDGE_PORT };
}

async function prepareWalletDaemon(value) {
  if (/^https:\/\//i.test(String(value))) return startTlsBridge(value);
  await stopTlsBridge();
  return splitDaemonAddress(value);
}

async function walletServiceRpc(method, params = {}, port = walletServicePort) {
  const response = await fetch(`http://127.0.0.1:${port}/json_rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSONbig.stringify({ jsonrpc: '2.0', id: 'mbg-gui', method, params })
  });
  if (!response.ok) throw new Error(`Wallet service HTTP ${response.status}`);
  const payload = JSONbig.parse(await response.text());
  if (payload.error) throw new Error(payload.error.message || `Wallet service error ${payload.error.code}`);
  return payload.result;
}

function splitDaemonAddress(value) {
  const match = String(value).match(/^(.+):(\d+)$/);
  if (!match) throw new Error('Daemon address harus menggunakan format host:port.');
  return { host: match[1], port: Number(match[2]) };
}

let activeMiningDaemon = null;
let activeMiningThreads = 0;
let localDaemonProcess = null;
let localDaemonStarting = false;
const LOCAL_DAEMON_ADDRESS = '127.0.0.1:52691';
let applicationQuitting = false;
const daemonSession = { miningStartedAt: 0, blocksFound: 0, difficultySum: 0, logOffset: 0, sizeCheckedAt: 0, blockchainSize: 0 };

async function directorySize(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) total += Number((await fs.stat(entryPath)).size || 0);
  }
  return total;
}

async function consumeDaemonMiningLog() {
  const logFile = path.join(app.getPath('userData'), 'blockchain', 'mbgcoind.log');
  const stat = await fs.stat(logFile).catch(() => null);
  if (!stat) return;
  if (stat.size < daemonSession.logOffset) daemonSession.logOffset = 0;
  if (stat.size === daemonSession.logOffset) return;
  const handle = await fs.open(logFile, 'r');
  try {
    const length = Math.min(stat.size - daemonSession.logOffset, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    daemonSession.logOffset = stat.size;
    for (const match of buffer.toString('utf8').matchAll(/Found block for difficulty:\s*(\d+)/g)) {
      daemonSession.blocksFound += 1;
      daemonSession.difficultySum += Number(match[1] || 0);
    }
  } finally { await handle.close(); }
}

async function getDaemonCpuPercent() {
  if (!localDaemonProcess || localDaemonProcess.exitCode !== null) return 0;
  try {
    const script = `(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter \"IDProcess=${localDaemonProcess.pid}\").PercentProcessorTime`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 4000 });
    return Math.min(100, Math.max(0, Number(String(stdout).trim()) || 0));
  } catch (_) { return 0; }
}

async function ensureLocalDaemon(daemonBinary) {
  if (localDaemonProcess && localDaemonProcess.exitCode === null) {
    const info = await daemonRequest(LOCAL_DAEMON_ADDRESS, 'getinfo', {});
    return { address: LOCAL_DAEMON_ADDRESS, info };
  }
  if (typeof daemonBinary !== 'string' || !daemonBinary) throw new Error('Binary mbgcoind belum dikonfigurasi.');
  localDaemonStarting = true;
  await fs.access(daemonBinary);
  const dataDir = path.join(app.getPath('userData'), 'blockchain');
  await fs.mkdir(dataDir, { recursive: true });
  const seed = await dns.lookup('node1.mbgcoin.my.id', { family: 4 });
  const child = spawn(daemonBinary, [
    `--data-dir=${dataDir}`,
    '--p2p-bind-ip=127.0.0.1',
    '--p2p-bind-port=52670',
    '--rpc-bind-ip=127.0.0.1',
    '--rpc-bind-port=52691',
    '--hide-my-port',
    `--add-priority-node=${seed.address}:52680`,
    `--log-file=${path.join(dataDir, 'mbgcoind.log')}`,
    '--log-level=2'
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  localDaemonProcess = child;
  child.on('close', () => {
    if (localDaemonProcess === child) localDaemonProcess = null;
    if (activeMiningDaemon === LOCAL_DAEMON_ADDRESS) activeMiningDaemon = null;
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const info = await daemonRequest(LOCAL_DAEMON_ADDRESS, 'getinfo', {});
      localDaemonStarting = false;
      return { address: LOCAL_DAEMON_ADDRESS, info };
    } catch (_) { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (child.exitCode === null) child.kill();
  localDaemonProcess = null;
  localDaemonStarting = false;
  throw new Error('Daemon lokal tidak dapat dimulai. Periksa log blockchain/mbgcoind.log.');
}

async function getPublicNodeInfo() {
  return (await selectPublicNode()).info;
}

async function stopLocalDaemon() {
  if (!localDaemonProcess) return;
  const child = localDaemonProcess;
  if (activeMiningDaemon === LOCAL_DAEMON_ADDRESS) {
    try { await daemonRequest(LOCAL_DAEMON_ADDRESS, 'stop_mining', {}); } catch (_) { /* daemon may be stopping */ }
    activeMiningDaemon = null;
  }
  try { child.stdin.write('exit\n'); child.stdin.end(); } catch (_) { /* process may already be closing */ }
  await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 12000))]);
  if (child.exitCode === null) child.kill();
  if (localDaemonProcess === child) localDaemonProcess = null;
  activeMiningDaemon = null;
  activeMiningThreads = 0;
}

async function daemonRequest(daemonAddress, endpoint, body = {}) {
  if (/^https:\/\//i.test(String(daemonAddress))) throw new Error('Mining tidak tersedia melalui public node. Gunakan daemon lokal.');
  const daemon = splitDaemonAddress(daemonAddress);
  if (!['127.0.0.1', 'localhost', '::1'].includes(daemon.host.toLowerCase())) throw new Error('Mining hanya diizinkan melalui daemon localhost atau SSH tunnel.');
  const response = await fetch(`http://${daemon.host}:${daemon.port}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSONbig.stringify(body) });
  if (!response.ok) throw new Error(`Daemon HTTP ${response.status}`);
  const payload = JSONbig.parse(await response.text());
  if (payload.status && payload.status !== 'OK') throw new Error(payload.status);
  return payload;
}

ipcMain.handle('mining-start', async (_event, request) => {
  const address = String(request && request.address || '');
  const threads = Number(request && request.threads);
  let daemonAddress = String(request && request.daemonAddress || '');
  if (!/^RMBG[1-9A-HJ-NP-Za-km-z]{94}$/.test(address)) return { ok: false, message: 'Address mining MBG tidak valid.' };
  if (!Number.isInteger(threads) || threads < 1 || threads > 64) return { ok: false, message: 'Jumlah thread harus antara 1 dan 64.' };
  try {
    if (/^https:\/\//i.test(daemonAddress)) {
      const local = await ensureLocalDaemon(request && request.daemonBinary);
      daemonAddress = local.address;
      const publicInfo = await getPublicNodeInfo();
      const knownHeight = Number(publicInfo.height || 0);
      if (Number(local.info.peerCount || local.info.outgoing_connections_count || 0) < 1 || Number(local.info.height || 0) < knownHeight) return { ok: false, syncing: true, message: `Daemon lokal masih sinkronisasi ${local.info.height || 0} / ${knownHeight}.` };
    }
    const result = await daemonRequest(daemonAddress, 'start_mining', { miner_address: address, threads_count: threads });
    activeMiningDaemon = daemonAddress;
    activeMiningThreads = threads;
    daemonSession.miningStartedAt = Date.now();
    daemonSession.blocksFound = 0;
    daemonSession.difficultySum = 0;
    const log = await fs.stat(path.join(app.getPath('userData'), 'blockchain', 'mbgcoind.log')).catch(() => null);
    daemonSession.logOffset = log ? log.size : 0;
    return { ok: true, status: result.status || 'OK' };
  }
  catch (error) { const restricted = /restricted/i.test(error.message); return { ok: false, restricted, message: restricted ? 'Node memakai restricted RPC dan tidak mengizinkan mining.' : `Mining gagal dimulai: ${error.message}` }; }
});

ipcMain.handle('mining-stop', async (_event, daemonAddress) => {
  try {
    const target = /^https:\/\//i.test(String(daemonAddress || '')) ? LOCAL_DAEMON_ADDRESS : (daemonAddress || activeMiningDaemon);
    const result = await daemonRequest(target, 'stop_mining', {});
    activeMiningDaemon = null;
    activeMiningThreads = 0;
    return { ok: true, status: result.status || 'OK' };
  }
  catch (error) { return { ok: false, message: `Mining gagal dihentikan: ${error.message}` }; }
});

ipcMain.handle('daemon-mining-info', async (_event, request) => {
  try {
    let daemonAddress = String(request && request.daemonAddress || request || '');
    const usesPublicNode = /^https:\/\//i.test(daemonAddress);
    if (usesPublicNode) daemonAddress = (await ensureLocalDaemon(request && request.daemonBinary)).address;
    const info = await daemonRequest(daemonAddress, 'getinfo', {});
    if (usesPublicNode) info.network_target = Number((await getPublicNodeInfo()).height || 0);
    return { ok: true, info, local: daemonAddress === LOCAL_DAEMON_ADDRESS };
  }
  catch (error) { return { ok: false, message: `Info daemon tidak tersedia: ${error.message}` }; }
});

ipcMain.handle('local-daemon-telemetry', async () => {
  const dataDir = path.join(app.getPath('userData'), 'blockchain');
  const running = Boolean(localDaemonProcess && localDaemonProcess.exitCode === null);
  let info = null;
  let networkTarget = 0;
  if (running) {
    info = await daemonRequest(LOCAL_DAEMON_ADDRESS, 'getinfo', {}).catch(() => null);
    networkTarget = Number((await getPublicNodeInfo().catch(() => null))?.height || info?.height || 0);
    if (activeMiningDaemon === LOCAL_DAEMON_ADDRESS) await consumeDaemonMiningLog();
    else {
      const log = await fs.stat(path.join(app.getPath('userData'), 'blockchain', 'mbgcoind.log')).catch(() => null);
      daemonSession.logOffset = log ? log.size : 0;
    }
  }
  if (!daemonSession.sizeCheckedAt || Date.now() - daemonSession.sizeCheckedAt > 15000) {
    daemonSession.blockchainSize = await directorySize(dataDir);
    daemonSession.sizeCheckedAt = Date.now();
  }
  const height = Number(info?.height || 0);
  const peers = Number(info?.outgoing_connections_count || 0) + Number(info?.incoming_connections_count || 0);
  const mining = activeMiningDaemon === LOCAL_DAEMON_ADDRESS;
  const status = localDaemonStarting ? 'Starting' : !running ? 'Stopped' : (height < networkTarget || peers < 1) ? 'Synchronizing' : mining ? 'Mining' : 'Ready';
  const elapsedSeconds = daemonSession.miningStartedAt ? Math.max(1, (Date.now() - daemonSession.miningStartedAt) / 1000) : 0;
  return { ok: true, status, running, mining, height, target: networkTarget, peers, cpuPercent: await getDaemonCpuPercent(), threads: mining ? activeMiningThreads : 0, localHashrate: elapsedSeconds ? daemonSession.difficultySum / elapsedSeconds : 0, blocksFound: daemonSession.blocksFound, dataDir, blockchainSize: daemonSession.blockchainSize, pid: running ? localDaemonProcess.pid : 0 };
});

ipcMain.handle('local-daemon-resync', async event => {
  const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), { type: 'warning', buttons: ['Cancel', 'Backup & Resync'], defaultId: 0, cancelId: 0, title: 'Resync blockchain lokal', message: 'Hentikan daemon dan bangun ulang blockchain lokal?', detail: 'Data blockchain lama akan dipindahkan ke folder backup. Wallet file dan private key tidak ikut dipindahkan.' });
  if (answer.response !== 1) return { ok: false, cancelled: true };
  await stopLocalDaemon();
  const dataDir = path.join(app.getPath('userData'), 'blockchain');
  const backupDir = `${dataDir}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.rename(dataDir, backupDir).catch(error => { if (error.code !== 'ENOENT') throw error; });
  daemonSession.sizeCheckedAt = 0; daemonSession.blockchainSize = 0; daemonSession.blocksFound = 0; daemonSession.difficultySum = 0; daemonSession.miningStartedAt = 0;
  return { ok: true, backupDir };
});

ipcMain.handle('local-daemon-stop', async () => { await stopLocalDaemon(); return { ok: true }; });

async function stopWalletService() {
  if (walletServiceProcess) {
    try { await walletServiceRpc('save'); } catch (_) { /* service may already be down */ }
    const child = walletServiceProcess;
    child.kill();
    await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    walletServiceProcess = null;
  }
  await stopTlsBridge();
}

async function startWalletServiceInternal(request) {
  const serviceBinary = request && request.serviceBinary;
  const walletFile = request && request.walletFile;
  const password = request && request.password;
  const daemonAddress = request && request.daemonAddress;
  const port = Number(request && request.servicePort) || defaultConfig.servicePort;
  try {
    await fs.access(serviceBinary);
    await fs.access(walletFile);
    await stopWalletService();
    const daemon = await prepareWalletDaemon(daemonAddress);
    const logFile = path.join(app.getPath('userData'), 'mbgcoin-service.log');
    const child = spawn(serviceBinary, ['-w', walletFile, '-p', password, '--bind-address', '127.0.0.1', '--bind-port', String(port), '--daemon-address', daemon.host, '--daemon-port', String(daemon.port), '--log-file', logFile, '--log-level', '2'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    walletServiceProcess = child;
    walletServicePort = port;
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { output += data.toString(); });
    child.on('close', () => { if (walletServiceProcess === child) walletServiceProcess = null; });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const addresses = await walletServiceRpc('getAddresses', {}, port);
        const status = await walletServiceRpc('getStatus', {}, port);
        const balance = await walletServiceRpc('getBalance', {}, port);
        return { ok: true, addresses: addresses.addresses || [], status, balance, servicePort: port };
      } catch (_) { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    child.kill();
    walletServiceProcess = null;
    await stopTlsBridge();
    const safe = output.split(/\r?\n/).filter(line => line && !/password|private|mnemonic|key/i.test(line)).slice(-1)[0];
    return { ok: false, message: safe ? `Wallet service gagal: ${safe.slice(0, 180)}` : 'Wallet service tidak dapat dimulai. File mungkin memakai format wallet CLI lama.' };
  } catch (error) {
    await stopTlsBridge().catch(() => {});
    return { ok: false, message: error.message || 'Wallet service gagal dimulai.' };
  }
}

ipcMain.handle('service-start', async (_event, request) => startWalletServiceInternal(request));

ipcMain.handle('service-call', async (_event, method, params) => {
  const allowed = new Set(['getStatus', 'getBalance', 'getAddresses', 'getTransactions', 'getUnconfirmedTransactionHashes', 'getTransaction', 'sendTransaction', 'estimateFusion', 'sendFusionTransaction', 'save']);
  if (!allowed.has(method)) throw new Error('Wallet service method tidak diizinkan.');
  if (method === 'sendTransaction') {
    params = { ...params, fee: BigInt(params.fee), unlockTime: BigInt(params.unlockTime || 0), transfers: (params.transfers || []).map(transfer => ({ ...transfer, amount: BigInt(transfer.amount) })) };
    if (!params.extra) delete params.extra;
    if (!params.paymentId) delete params.paymentId;
    if (params.extra && params.paymentId) throw new Error('Gunakan extra atau payment ID, bukan keduanya.');
  }
  if (method === 'estimateFusion' || method === 'sendFusionTransaction') {
    params = { ...params, threshold: BigInt(params.threshold) };
    if (method === 'sendFusionTransaction') params.anonymity = Number(params.anonymity || 0);
  }
  let result;
  try { result = await walletServiceRpc(method, params || {}); }
  catch (error) {
    if (method === 'sendTransaction' && params.addresses && params.addresses[0]) {
      try {
        const address = params.addresses[0]; let cache = {};
        try { cache = JSON.parse(await fs.readFile(transactionCachePath(), 'utf8')); } catch (_) { /* first attempt */ }
        const total = (params.transfers || []).reduce((sum, transfer) => sum + BigInt(transfer.amount), BigInt(params.fee || 0));
        const failed = { transactionHash: '', localId: `failed-${Date.now()}`, status: 'Failed', direction: 'Outgoing', amount: String(-total), fee: String(params.fee || 0), address: params.transfers[0]?.address || '', paymentId: params.paymentId || '', timestamp: Math.floor(Date.now() / 1000), submittedHeight: 0, blockIndex: 0, confirmations: 0, lastSeenAt: Date.now(), error: String(error.message || 'Transaction failed').slice(0, 300) };
        cache[address] = [failed, ...(Array.isArray(cache[address]) ? cache[address] : [])].slice(0, 5000);
        await fs.writeFile(transactionCachePath(), JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
      } catch (_) { /* preserve original RPC error */ }
    }
    throw error;
  }
  if (method === 'sendTransaction' && result && result.transactionHash && params.addresses && params.addresses[0]) {
    const address = params.addresses[0];
    try {
      let cache = {};
      try { cache = JSON.parse(await fs.readFile(transactionCachePath(), 'utf8')); } catch (_) { /* first transaction */ }
      const total = (params.transfers || []).reduce((sum, transfer) => sum + BigInt(transfer.amount), BigInt(params.fee || 0));
      const pending = { transactionHash: result.transactionHash, localId: '', status: 'Pending', direction: 'Outgoing', amount: String(-total), fee: String(params.fee || 0), address: params.transfers[0]?.address || '', paymentId: params.paymentId || '', timestamp: Math.floor(Date.now() / 1000), submittedHeight: 0, blockIndex: 0, confirmations: 0, lastSeenAt: Date.now(), error: '' };
      cache[address] = [pending, ...(Array.isArray(cache[address]) ? cache[address].filter(tx => tx.transactionHash !== result.transactionHash) : [])].slice(0, 5000);
      await fs.writeFile(transactionCachePath(), JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (_) { /* sending succeeded even if local cache write fails */ }
  }
  return result;
});

ipcMain.handle('transaction-preflight', async (_event, request) => {
  const params = { ...request, fee: BigInt(request.fee), unlockTime: BigInt(request.unlockTime || 0), transfers: (request.transfers || []).map(transfer => ({ ...transfer, amount: BigInt(transfer.amount) })), anonymity: Number(request.anonymity || 0) };
  if (!params.extra) delete params.extra;
  if (!params.paymentId) delete params.paymentId;
  let delayedHash = '';
  try {
    const [balance, fusion] = await Promise.all([
      walletServiceRpc('getBalance', { address: params.addresses?.[0] || '' }),
      walletServiceRpc('estimateFusion', { threshold: BigInt('100000000000000'), addresses: params.addresses || [] })
    ]);
    const delayed = await walletServiceRpc('createDelayedTransaction', params);
    delayedHash = delayed.transactionHash;
    await walletServiceRpc('deleteDelayedTransaction', { transactionHash: delayedHash });
    delayedHash = '';
    const spend = (params.transfers || []).reduce((sum, transfer) => sum + BigInt(transfer.amount), BigInt(params.fee));
    const available = BigInt(balance.availableBalance || 0);
    const totalOutputs = Math.max(1, Number(fusion.totalOutputCount || 1));
    const proportionalInputs = available > 0n ? Number((BigInt(totalOutputs) * spend + available - 1n) / available) : totalOutputs;
    const estimatedInputs = Math.max(1, Math.min(totalOutputs, Math.ceil(proportionalInputs * 1.35)));
    const bytesPerInput = 112 + (68 * params.anonymity);
    const estimatedBytes = 270 + (estimatedInputs * bytesPerInput);
    const mineableLimit = 11900;
    const maxRecommendedInputs = Math.max(1, Math.floor((mineableLimit * 0.9 - 270) / bytesPerInput));
    const tooLarge = estimatedBytes > mineableLimit * 0.9 || estimatedInputs > maxRecommendedInputs;
    return { ok: !tooLarge, constructible: true, estimatedBytes, estimatedInputs, totalOutputs, fusionReadyOutputs: Number(fusion.fusionReadyCount || 0), mineableLimit, maxRecommendedInputs, recommendOptimize: tooLarge || Number(fusion.fusionReadyCount || 0) >= 12, message: tooLarge ? `Transaksi diperkirakan memakai ${estimatedInputs} input (${estimatedBytes} byte), melebihi batas aman ${Math.floor(mineableLimit * 0.9)} byte. Jalankan Optimize Wallet terlebih dahulu.` : `Estimasi ${estimatedInputs} input, ${estimatedBytes} byte. Transaksi berada di bawah batas aman.` };
  } catch (error) {
    if (delayedHash) await walletServiceRpc('deleteDelayedTransaction', { transactionHash: delayedHash }).catch(() => {});
    const message = String(error.message || 'Preflight gagal.');
    const tooLarge = /size is too big|transaction size|too big|internal node error/i.test(message);
    return { ok: false, constructible: false, estimatedBytes: 0, estimatedInputs: 0, recommendOptimize: tooLarge, message: tooLarge ? 'Wallet membutuhkan terlalu banyak input sehingga transaksi akan ditolak node. Jalankan Optimize Wallet terlebih dahulu.' : `Transaksi tidak dapat dibuat: ${message}` };
  }
});

ipcMain.handle('service-stop', async () => { await stopWalletService(); return { ok: true }; });

async function sha256File(filePath) {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

ipcMain.handle('wallet-backup', async (event, request) => {
  const walletFile = request && request.walletFile;
  const password = request && request.password;
  const serviceBinary = request && request.serviceBinary;
  const daemonAddress = request && request.daemonAddress;
  const servicePort = Number(request && request.servicePort) || defaultConfig.servicePort;
  if (!walletServiceProcess) return { ok: false, message: 'Wallet service belum aktif.' };
  if (![walletFile, password, serviceBinary, daemonAddress].every(value => typeof value === 'string' && value.length > 0)) return { ok: false, message: 'Password dan konfigurasi service wajib diisi untuk backup.' };
  try {
    await fs.access(walletFile);
    const parsed = path.parse(walletFile);
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Backup MBG Wallet', defaultPath: path.join(parsed.dir, `${parsed.name}-backup${parsed.ext || '.wallet'}`),
      filters: [{ name: 'MBG wallet backup', extensions: ['wallet'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true, message: 'Backup dibatalkan.' };
    if (path.resolve(result.filePath).toLowerCase() === path.resolve(walletFile).toLowerCase()) return { ok: false, message: 'Lokasi backup tidak boleh sama dengan file wallet aktif.' };
    const before = await walletServiceRpc('getAddresses');
    await stopWalletService();
    let backupResult;
    try {
      await fs.copyFile(walletFile, result.filePath);
      const [sourceHash, backupHash, stat] = await Promise.all([sha256File(walletFile), sha256File(result.filePath), fs.stat(result.filePath)]);
      if (sourceHash !== backupHash) { await fs.unlink(result.filePath).catch(() => {}); backupResult = { ok: false, message: 'Verifikasi backup gagal; file salinan telah dihapus.' }; }
      else backupResult = { ok: true, filePath: result.filePath, sha256: backupHash, size: stat.size, message: 'Backup terenkripsi berhasil dibuat dan diverifikasi.' };
    } catch (error) { backupResult = { ok: false, message: `Backup gagal: ${error.message}` }; }
    const restarted = await startWalletServiceInternal({ serviceBinary, walletFile, password, daemonAddress, servicePort });
    if (!restarted.ok) return { ...backupResult, ok: false, message: `${backupResult.message} Wallet service gagal dimulai kembali: ${restarted.message}` };
    if ((before.addresses || [])[0] !== (restarted.addresses || [])[0]) return { ...backupResult, ok: false, message: 'Backup dibuat, tetapi verifikasi address setelah restart gagal.' };
    return backupResult;
  } catch (error) { return { ok: false, message: `Backup gagal: ${error.message}` }; }
});

ipcMain.handle('wallet-verify-file', async event => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: 'Verify MBG Wallet Backup', properties: ['openFile'], filters: [{ name: 'MBG wallet files', extensions: ['wallet'] }] });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true, message: 'Verifikasi dibatalkan.' };
  try { const filePath = result.filePaths[0]; const [sha256, stat] = await Promise.all([sha256File(filePath), fs.stat(filePath)]); return { ok: true, filePath, sha256, size: stat.size }; }
  catch (error) { return { ok: false, message: `File tidak dapat diverifikasi: ${error.message}` }; }
});

ipcMain.handle('wallet-check', async (_event, binaryPath) => {
  if (typeof binaryPath !== 'string' || !binaryPath.trim()) return { ok: false, message: 'Path binary wallet belum diisi.' };
  try {
    const result = await execFileAsync(binaryPath, ['--help'], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return { ok: true, message: 'Binary wallet dapat dijalankan.', help: output.slice(0, 2000) };
  } catch (error) {
    if (error.code === 'ETIMEDOUT') return { ok: false, message: 'Binary wallet tidak merespons dalam 10 detik.' };
    return { ok: false, message: `Binary wallet tidak dapat dijalankan: ${error.code || error.message}` };
  }
});

ipcMain.handle('wallet-balance', async (_event, request) => {
  const binaryPath = request && request.binaryPath;
  const walletFile = request && request.walletFile;
  const password = request && request.password;
  const daemonAddress = request && request.daemonAddress;
  if (![binaryPath, walletFile, password, daemonAddress].every(value => typeof value === 'string' && value.length > 0)) {
    return { ok: false, message: 'Binary, file wallet, password, dan daemon address wajib diisi.' };
  }
  try { await fs.access(binaryPath); } catch (_) { return { ok: false, message: 'Binary wallet tidak ditemukan. Periksa Settings > Wallet core binary.' }; }
  try { await fs.access(walletFile); } catch (_) { return { ok: false, message: 'File wallet tidak ditemukan atau tidak dapat dibaca.' }; }
  let daemon;
  try { daemon = await prepareWalletDaemon(daemonAddress); }
  catch (error) { return { ok: false, message: error.message }; }
  const cliDaemonAddress = `${daemon.host}:${daemon.port}`;
  const runBalance = pass => new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [`--wallet-file=${walletFile}`, `--password=${pass}`, `--daemon-address=${cliDaemonAddress}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let done = false;
    let balanceSent = false;
    let exitSent = false;
    let openedFallback = null;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); reject({ code: 'ETIMEDOUT', stdout: output, stderr: '' }); } }, 60000);
    const collect = data => {
      output += data.toString();
      if (!balanceSent && /Opened wallet:/i.test(output)) {
        balanceSent = true;
        child.stdin.write('balance\n');
        openedFallback = setTimeout(() => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            child.stdin.write('exit\n');
            resolve({ stdout: output, stderr: '', syncing: true });
            setTimeout(() => child.kill(), 1500);
          }
        }, 2500);
      }
      if (!exitSent && /available balance:/i.test(output)) {
        exitSent = true;
        child.stdin.write('exit\n');
        if (!done) {
          done = true;
          clearTimeout(timer);
          if (openedFallback) clearTimeout(openedFallback);
          resolve({ stdout: output, stderr: '' });
          setTimeout(() => child.kill(), 1500);
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { if (!done) { done = true; clearTimeout(timer); reject({ code: error.code, stdout: output, stderr: error.message }); } });
    child.on('close', code => { if (!done) { done = true; clearTimeout(timer); if (code === 0 || /available balance:/i.test(output)) resolve({ stdout: output, stderr: '' }); else reject({ code, stdout: output, stderr: '' }); } });
  });
  const parseBalance = output => {
    const available = output.match(/available balance:\s*([0-9]+(?:\.[0-9]+)?)/i);
    const locked = output.match(/locked (?:amount|balance):\s*([0-9]+(?:\.[0-9]+)?)/i);
    const address = output.match(/Opened wallet:\s*(RMBG[A-Za-z0-9]+)/i);
    return { available: available ? available[1] : '0.00000000', locked: locked ? locked[1] : '0.00000000', address: address ? address[1] : '' };
  };
  try {
    const result = await runBalance(password);
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return { ok: true, ...parseBalance(output), syncing: Boolean(result.syncing) };
  } catch (error) {
    const details = `${error.stdout || ''}\n${error.stderr || ''}`;
    if (/failed to connect to daemon|connectex failed|connection refused|remote node/i.test(details)) return { ok: false, message: 'Daemon tidak dapat dihubungi. Jalankan mbgcoind lokal atau gunakan SSH tunnel ke port RPC.' };
    if (/can't load wallet file|check password|failed to load wallet/i.test(details)) {
      try {
        const legacy = await runBalance('');
        const legacyOutput = `${legacy.stdout || ''}\n${legacy.stderr || ''}`;
        if (/available balance:/i.test(legacyOutput)) return { ok: true, ...parseBalance(legacyOutput), warning: 'Wallet ini memakai password kosong dari versi generator lama. Segera gunakan Change Password untuk mengamankannya.' };
      } catch (_) { /* supplied password is required */ }
    }
    if (error.code === 'ETIMEDOUT') return { ok: false, message: 'Wallet tidak merespons dalam 60 detik. Pastikan daemon RPC aktif.' };
    const safeLine = details.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/password|private|key:/i.test(line)).slice(-1)[0];
    return { ok: false, message: safeLine ? `Wallet gagal dibuka: ${safeLine.slice(0, 180)}` : 'Wallet gagal dibuka. Periksa password dan file wallet.' };
  }
});

ipcMain.handle('wallet-create', async (_event, request) => {
  const serviceBinary = request && request.serviceBinary || defaultConfig.serviceBinary;
  const requestedPath = request && request.walletPath;
  const password = request && request.password;
  if (![serviceBinary, requestedPath, password].every(value => typeof value === 'string' && value.length > 0)) {
    return { ok: false, message: 'Wallet service, lokasi wallet, dan password wajib diisi.' };
  }
  const walletPath = requestedPath.toLowerCase().endsWith('.wallet') ? requestedPath : `${requestedPath}.wallet`;
  try {
    await fs.access(serviceBinary);
    try { await fs.access(walletPath); return { ok: false, message: 'File wallet sudah ada. Gunakan nama lain.' }; } catch (_) { /* expected */ }
    await execFileAsync(serviceBinary, ['-g', '-w', walletPath, '-p', password, '--deterministic', '--log-level', '1'], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const addressResult = await execFileAsync(serviceBinary, ['-w', walletPath, '-p', password, '--address', '--log-level', '1'], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = `${addressResult.stdout || ''}\n${addressResult.stderr || ''}`;
    const address = output.match(/RMBG[A-Za-z0-9]+/);
    return { ok: true, address: address ? address[0] : '', walletFile: walletPath, message: 'Wallet service baru berhasil dibuat.' };
  } catch (error) {
    return { ok: false, message: error.code === 'ETIMEDOUT' ? 'Pembuatan wallet service melebihi batas waktu.' : 'Wallet service gagal dibuat. Periksa lokasi dan binary.' };
  }
});

ipcMain.handle('wallet-import', async (_event, request) => {
  const serviceBinary = request && request.serviceBinary || defaultConfig.serviceBinary;
  const requestedPath = request && request.walletPath;
  const password = request && request.password;
  const method = request && request.method;
  const restoreMode = String(request && request.restoreMode || 'genesis');
  const expectedAddress = String(request && request.expectedAddress || '').trim();
  if (![serviceBinary, requestedPath, password, method].every(value => typeof value === 'string' && value.length > 0)) return { ok: false, message: 'Data import belum lengkap.' };
  const walletPath = requestedPath.toLowerCase().endsWith('.wallet') ? requestedPath : `${requestedPath}.wallet`;
  try {
    await fs.access(serviceBinary);
    try { await fs.access(walletPath); return { ok: false, message: 'File wallet sudah ada. Gunakan nama lain.' }; } catch (_) { /* expected */ }
    let restoreTimestamp = 0;
    if (restoreMode === 'date') {
      const parsed = Date.parse(String(request.restoreDate || ''));
      if (!Number.isFinite(parsed) || parsed > Date.now()) return { ok: false, message: 'Restore date tidak valid atau berada di masa depan.' };
      restoreTimestamp = Math.max(0, Math.floor(parsed / 1000) - 86400);
    } else if (restoreMode === 'height') {
      const restoreHeight = Number(request.restoreHeight);
      if (!Number.isInteger(restoreHeight) || restoreHeight < 0) return { ok: false, message: 'Restore height harus berupa bilangan bulat minimal 0.' };
      const network = await getPublicNodeInfo();
      const currentHeight = Number(network.height || 0);
      if (restoreHeight > currentHeight) return { ok: false, message: `Restore height melebihi height jaringan ${currentHeight}.` };
      const topTimestamp = Number(network.last_block_timestamp || Math.floor(Date.now() / 1000));
      restoreTimestamp = Math.max(0, topTimestamp - (currentHeight - restoreHeight) * 120 - 86400);
    } else if (restoreMode !== 'genesis') return { ok: false, message: 'Restore mode tidak didukung.' };
    const args = ['-g', '-w', walletPath, '-p', password, '--restore-timestamp', String(restoreTimestamp), '--log-level', '1'];
    if (method === 'mnemonic') {
      const mnemonic = String(request.mnemonic || '').trim().replace(/\s+/g, ' ');
      if (mnemonic.split(' ').length !== 25) return { ok: false, message: 'Mnemonic MBG harus terdiri dari 25 kata.' };
      args.push('--mnemonic-seed', mnemonic);
    } else if (method === 'keys') {
      const spendKey = String(request.spendKey || '').trim();
      const viewKey = String(request.viewKey || '').trim();
      if (!/^[a-fA-F0-9]{64}$/.test(spendKey) || !/^[a-fA-F0-9]{64}$/.test(viewKey)) return { ok: false, message: 'Private spend key dan private view key harus 64 karakter hexadecimal.' };
      args.push('--spend-key', spendKey, '--view-key', viewKey);
    } else return { ok: false, message: 'Metode import tidak didukung.' };
    await execFileAsync(serviceBinary, args, { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const addressResult = await execFileAsync(serviceBinary, ['-w', walletPath, '-p', password, '--address', '--log-level', '1'], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = `${addressResult.stdout || ''}\n${addressResult.stderr || ''}`;
    const address = output.match(/RMBG[A-Za-z0-9]+/);
    const restoredAddress = address ? address[0] : '';
    if (expectedAddress && restoredAddress !== expectedAddress) {
      await fs.unlink(walletPath).catch(() => {});
      return { ok: false, address: restoredAddress, addressMismatch: true, message: 'Address hasil restore tidak cocok dengan address lama. Wallet hasil restore telah dihapus untuk keamanan.' };
    }
    return { ok: true, address: restoredAddress, walletFile: walletPath, restoreTimestamp, addressVerified: Boolean(expectedAddress), message: expectedAddress ? 'Wallet berhasil direstore dan address terverifikasi.' : 'Wallet berhasil direstore. Verifikasi address sebelum menerima atau mengirim MBG.' };
  } catch (error) {
    return { ok: false, message: error.code === 'ETIMEDOUT' ? 'Import wallet melebihi batas waktu.' : 'Wallet gagal diimpor. Periksa mnemonic/keys dan password.' };
  }
});

ipcMain.handle('select-wallet-folder', async event => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0];
});

ipcMain.handle('select-wallet-file', async event => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: ['openFile'],
    filters: [{ name: 'MBG wallet files', extensions: ['wallet'] }, { name: 'All files', extensions: ['*'] }]
  });
  return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', event => {
  if (applicationQuitting) return;
  if (activeMiningDaemon || localDaemonProcess || walletServiceProcess || tlsBridgeServer) {
    event.preventDefault();
    applicationQuitting = true;
    (async () => {
      if (activeMiningDaemon) await daemonRequest(activeMiningDaemon, 'stop_mining', {}).catch(() => {});
      activeMiningDaemon = null;
      await stopWalletService().catch(() => {});
      await stopLocalDaemon().catch(() => {});
      app.exit(0);
    })();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
