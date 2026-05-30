// auth/[action].js
// Sistem autentikasi Academy Eji
// Actions: register, login, verify, upgrade, list-users, delete-user
// ⚡ Storage: Upstash Redis (gratis, <20ms)
// Versi: 1.1.0 — tambah timeout Redis, try/catch tiap handler, error lebih deskriptif

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
}

// ─── UPSTASH REDIS HELPERS ────────────────────────────────────────────────────

const USERS_KEY = 'academy_eji_users';
const REDIS_TIMEOUT_MS = 8000; // 8 detik timeout ke Upstash

function checkRedisEnv(res) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    res.status(500).json({
      error: 'Konfigurasi Redis belum diatur. Tambahkan UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN di Vercel.'
    });
    return null;
  }
  return { url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN };
}

// fetch ke Upstash dengan timeout agar tidak hang selamanya
async function redisFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return r;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('REDIS_TIMEOUT');
    throw e;
  }
}

async function redisGet(env, key) {
  const r = await redisFetch(`${env.url}/get/${key}`, {
    headers: { Authorization: `Bearer ${env.token}` }
  });
  if (!r.ok) throw new Error(`Redis GET gagal: ${r.status}`);
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}

async function redisSet(env, key, value) {
  const r = await redisFetch(`${env.url}/set/${key}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(value))
  });
  if (!r.ok) throw new Error(`Redis SET gagal: ${r.status}`);
  const j = await r.json();
  return j.result === 'OK';
}

async function getUsers(env) {
  const data = await redisGet(env, USERS_KEY);
  return data || { users: [] };
}

async function saveUsers(env, data) {
  return await redisSet(env, USERS_KEY, data);
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
  const env = checkRedisEnv(res); if (!env) return;

  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username diperlukan.' });
  }

  const clean = username.trim().replace(/[^a-zA-Z0-9 \-_.]/g, '');
  if (clean.length < 2 || clean.length > 40) {
    return res.status(400).json({ error: 'Nama harus 2–40 karakter.' });
  }

  let data;
  try {
    data = await getUsers(env);
  } catch (e) {
    console.error('[register] getUsers error:', e.message);
    const msg = e.message === 'REDIS_TIMEOUT'
      ? 'Koneksi ke database timeout. Coba lagi.'
      : 'Gagal membaca data user.';
    return res.status(500).json({ error: msg });
  }

  const users = data.users || [];
  const exists = users.find(u => u.username.toLowerCase() === clean.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: 'Nama sudah terdaftar. Silakan login.' });
  }

  const newUser = {
    id: `usr_${Date.now()}`,
    username: clean,
    role: 'tamu',
    created_at: new Date().toISOString()
  };
  users.push(newUser);
  data.users = users;

  try {
    const saved = await saveUsers(env, data);
    if (!saved) return res.status(500).json({ error: 'Gagal menyimpan data user.' });
  } catch (e) {
    console.error('[register] saveUsers error:', e.message);
    const msg = e.message === 'REDIS_TIMEOUT'
      ? 'Koneksi ke database timeout saat menyimpan. Coba lagi.'
      : 'Gagal menyimpan data user.';
    return res.status(500).json({ error: msg });
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
  const env = checkRedisEnv(res); if (!env) return;

  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username diperlukan.' });
  }

  const clean = username.trim();

  let data;
  try {
    data = await getUsers(env);
  } catch (e) {
    console.error('[login] getUsers error:', e.message);
    const msg = e.message === 'REDIS_TIMEOUT'
      ? 'Koneksi ke database timeout. Coba lagi.'
      : 'Gagal membaca data user.';
    return res.status(500).json({ error: msg });
  }

  const users = data.users || [];
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
  const env = checkRedisEnv(res); if (!env) return;

  const { username, role } = req.body || {};
  if (!username || !role) return res.status(400).json({ error: 'username dan role diperlukan.' });
  if (!['tamu', 'vip'].includes(role)) return res.status(400).json({ error: 'Role harus "tamu" atau "vip".' });

  let data;
  try {
    data = await getUsers(env);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal membaca data user.' });
  }

  const users = data.users || [];
  const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'User tidak ditemukan.' });

  users[idx].role = role;
  users[idx].upgraded_at = new Date().toISOString();
  data.users = users;

  try {
    const saved = await saveUsers(env, data);
    if (!saved) return res.status(500).json({ error: 'Gagal menyimpan.' });
  } catch (e) {
    return res.status(500).json({ error: 'Gagal menyimpan.' });
  }

  return res.status(200).json({ message: `User ${username} berhasil diubah ke role ${role}.` });
}

// ─── LIST USERS (Admin only) ──────────────────────────────────────────────────

async function handleListUsers(req, res) {
  if (!checkAdmin(req, res)) return;
  const env = checkRedisEnv(res); if (!env) return;

  let data;
  try {
    data = await getUsers(env);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal membaca data user.' });
  }

  return res.status(200).json({ users: data.users || [] });
}

// ─── DELETE USER (Admin only) ─────────────────────────────────────────────────

async function handleDeleteUser(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  if (!checkAdmin(req, res)) return;
  const env = checkRedisEnv(res); if (!env) return;

  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username diperlukan.' });

  let data;
  try {
    data = await getUsers(env);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal membaca data user.' });
  }

  const before = (data.users || []).length;
  data.users = (data.users || []).filter(u => u.username.toLowerCase() !== username.toLowerCase());

  if (data.users.length === before) return res.status(404).json({ error: 'User tidak ditemukan.' });

  try {
    const saved = await saveUsers(env, data);
    if (!saved) return res.status(500).json({ error: 'Gagal menyimpan.' });
  } catch (e) {
    return res.status(500).json({ error: 'Gagal menyimpan.' });
  }

  return res.status(200).json({ message: `User ${username} berhasil dihapus.` });
}

