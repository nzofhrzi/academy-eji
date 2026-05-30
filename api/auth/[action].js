// api/auth/[action].js
// Sistem autentikasi Academy Eji
// Actions: register, login, verify, upgrade, list-users, delete-user
// Storage: GitHub API (users.json) — pola sama seperti save-data.js
// Versi: 2.0.0

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    switch (action) {
      case 'register':    return await handleRegister(req, res);
      case 'login':       return await handleLogin(req, res);
      case 'verify':      return await handleVerify(req, res);
      case 'upgrade':     return await handleUpgrade(req, res);
      case 'list-users':  return await handleListUsers(req, res);
      case 'delete-user': return await handleDeleteUser(req, res);
      default:
        return res.status(404).json({ error: `Action tidak dikenal: ${action}` });
    }
  } catch (err) {
    console.error(`[auth/${action}] Unhandled error:`, err);
    return res.status(500).json({ error: 'Terjadi kesalahan server. Silakan coba lagi.' });
  }
};

// ─── GITHUB API HELPERS ───────────────────────────────────────────────────────

const USERS_FILE = 'users.json';

function getGHConfig() {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_PAT } = process.env;
  if (!GITHUB_OWNER || !GITHUB_REPO || !GITHUB_PAT) return null;
  return {
    url: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${USERS_FILE}`,
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  };
}

async function getUsers() {
  const gh = getGHConfig();
  if (!gh) throw new Error('ENV_MISSING');

  const r = await fetch(gh.url, { headers: gh.headers });
  if (!r.ok) throw new Error(`GitHub GET error: ${r.status}`);

  const j = await r.json();
  const decoded = Buffer.from(j.content, 'base64').toString('utf-8');
  return { data: JSON.parse(decoded), sha: j.sha };
}

async function saveUsers(data, sha) {
  const gh = getGHConfig();
  if (!gh) throw new Error('ENV_MISSING');

  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64');
  const r = await fetch(gh.url, {
    method: 'PUT',
    headers: gh.headers,
    body: JSON.stringify({
      message: 'Update users.json via auth API',
      content,
      sha,
    })
  });

  if (!r.ok) {
    const errBody = await r.text();
    throw new Error(`GitHub PUT error ${r.status}: ${errBody}`);
  }
  return true;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function checkAdmin(req, res) {
  const { ADMIN_KEY } = process.env;
  const key = req.headers['x-admin-key']
    || (req.body && (req.body.adminKey || req.body.key))
    || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    res.status(403).json({ error: 'Akses ditolak. Admin key tidak valid.' });
    return false;
  }
  return true;
}

async function makeToken(username, role) {
  const secret = process.env.SESSION_SECRET || 'academy-eji-secret';
  const payload = `${username}|${role}|${Date.now()}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(payload);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return btoa(`${payload}|${sigHex}`);
}

async function verifyToken(token) {
  try {
    const secret = process.env.SESSION_SECRET || 'academy-eji-secret';
    const decoded = atob(token);
    const parts = decoded.split('|');
    if (parts.length < 4) return null;

    const sigHex = parts[parts.length - 1];
    const payload = parts.slice(0, parts.length - 1).join('|');
    const [username, role, tsStr] = parts;

    const ts = parseInt(tsStr);
    if (isNaN(ts)) return null;

    const now = Date.now();
    const tokenDate = new Date(ts);
    const midnight = new Date(tokenDate);
    midnight.setHours(24, 0, 0, 0);
    if (now >= midnight.getTime()) return null;
    if (now - ts > 24 * 60 * 60 * 1000) return null;

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(payload);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const expectedHex = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (sigHex !== expectedHex) return null;
    return { username, role };
  } catch {
    return null;
  }
}

// ─── REGISTER ────────────────────────────────────────────────────────────────

async function handleRegister(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });

  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username diperlukan.' });
  }

  const clean = username.trim().replace(/[^a-zA-Z0-9 \-_.]/g, '');
  if (clean.length < 2 || clean.length > 40) {
    return res.status(400).json({ error: 'Nama harus 2–40 karakter.' });
  }

  let result;
  try {
    result = await getUsers();
  } catch (e) {
    const msg = e.message === 'ENV_MISSING'
      ? 'Konfigurasi GitHub belum diatur di Vercel.'
      : 'Gagal membaca data user dari GitHub.';
    return res.status(500).json({ error: msg });
  }

  const { data, sha } = result;
  const users = data.users || [];

  const exists = users.find(u => u.username.toLowerCase() === clean.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: 'Nama sudah terdaftar. Silakan login.' });
  }

  users.push({
    id: `usr_${Date.now()}`,
    username: clean,
    role: 'tamu',
    created_at: new Date().toISOString()
  });
  data.users = users;

  try {
    await saveUsers(data, sha);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal menyimpan data user.' });
  }

  const token = await makeToken(clean, 'tamu');
  return res.status(200).json({
    message: 'Registrasi berhasil!',
    token,
    user: { username: clean, role: 'tamu' }
  });
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────

async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });

  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username diperlukan.' });
  }

  const clean = username.trim();

  let result;
  try {
    result = await getUsers();
  } catch (e) {
    return res.status(500).json({ error: 'Gagal membaca data user.' });
  }

  const users = result.data.users || [];
  const user = users.find(u => u.username.toLowerCase() === clean.toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'Nama tidak ditemukan. Silakan daftar terlebih dahulu.' });
  }

  const token = await makeToken(user.username, user.role);
  return res.status(200).json({
    message: 'Login berhasil!',
    token,
    user: { username: user.username, role: user.role }
  });
}

// ─── VERIFY ──────────────────────────────────────────────────────────────────

async function handleVerify(req, res) {
  const token = req.headers['x-session-token'] || (req.body && req.body.token);
  if (!token) return res.status(401).json({ valid: false, error: 'Token tidak ada.' });

  const session = await verifyToken(token);
  if (!session) return res.status(401).json({ valid: false, error: 'Sesi tidak valid atau sudah expired.' });

  return res.status(200).json({ valid: true, user: session });
}

// ─── UPGRADE (Admin only) ─────────────────────────────────────────────────────

async function handleUpgrade(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  if (!checkAdmin(req, res)) return;

  const { username, role } = req.body || {};
  if (!username || !role) return res.status(400).json({ error: 'username dan role diperlukan.' });
  if (!['tamu', 'vip'].includes(role)) return res.status(400).json({ error: 'Role harus "tamu" atau "vip".' });

  let result;
  try { result = await getUsers(); } catch (e) {
    return res.status(500).json({ error: 'Gagal membaca data user.' });
  }

  const { data, sha } = result;
  const users = data.users || [];
  const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'User tidak ditemukan.' });

  users[idx].role = role;
  users[idx].upgraded_at = new Date().toISOString();
  data.users = users;

  try { await saveUsers(data, sha); } catch (e) {
    return res.status(500).json({ error: 'Gagal menyimpan.' });
  }

  return res.status(200).json({ message: `User ${username} berhasil diubah ke role ${role}.` });
}

// ─── LIST USERS (Admin only) ──────────────────────────────────────────────────

async function handleListUsers(req, res) {
  if (!checkAdmin(req, res)) return;

  let result;
  try { result = await getUsers(); } catch (e) {
    return res.status(500).json({ error: 'Gagal membaca data user.' });
  }

  return res.status(200).json({ users: result.data.users || [] });
}

// ─── DELETE USER (Admin only) ─────────────────────────────────────────────────

async function handleDeleteUser(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  if (!checkAdmin(req, res)) return;

  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username diperlukan.' });

  let result;
  try { result = await getUsers(); } catch (e) {
    return res.status(500).json({ error: 'Gagal membaca data user.' });
  }

  const { data, sha } = result;
  const before = (data.users || []).length;
  data.users = (data.users || []).filter(u => u.username.toLowerCase() !== username.toLowerCase());

  if (data.users.length === before) return res.status(404).json({ error: 'User tidak ditemukan.' });

  try { await saveUsers(data, sha); } catch (e) {
    return res.status(500).json({ error: 'Gagal menyimpan.' });
  }

  return res.status(200).json({ message: `User ${username} berhasil dihapus.` });
}
