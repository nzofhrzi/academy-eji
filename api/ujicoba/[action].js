// api/ujicoba/[action].js
// Dynamic route Vercel — semua endpoint ujicoba dalam 1 file
// Akses via: /api/ujicoba/get-soal, /api/ujicoba/get-hasil, dst

export default async function handler(req, res) {
  const action = req.query.action;

  switch (action) {
    case 'get-soal':      return handleGetSoal(req, res);
    case 'get-hasil':     return handleGetHasil(req, res);
    case 'simpan-hasil':  return handleSimpanHasil(req, res);
    case 'save-soal':     return handleSaveSoal(req, res);
    case 'verify-admin':  return handleVerifyAdmin(req, res);
    case 'delete-hasil':  return handleDeleteHasil(req, res);
    default:
      return res.status(404).json({ error: `Action tidak dikenal: ${action}` });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function ghHeaders(pat) {
  return {
    'Authorization': `Bearer ${pat}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function ghUrl(owner, repo, path) {
  return `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
}

function checkEnv(res) {
  const { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO } = process.env;
  if (!GITHUB_PAT || !GITHUB_OWNER || !GITHUB_REPO) {
    res.status(500).json({ error: 'Environment variable belum dikonfigurasi.' });
    return null;
  }
  return { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO };
}

function checkAdmin(req, res) {
  const { ADMIN_KEY } = process.env;
  // Accept key from header OR body (adminKey / key field)
  const key = req.headers['x-admin-key']
    || (req.body && (req.body.adminKey || req.body.key))
    || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    res.status(403).json({ error: 'Akses ditolak. Admin key tidak valid.' });
    return false;
  }
  return true;
}

async function ghGet(url, pat) {
  const res = await fetch(url, { headers: ghHeaders(pat) });
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json();
  const raw = Buffer.from(json.content, 'base64').toString('utf-8');
  return { ok: true, sha: json.sha, data: JSON.parse(raw) };
}

async function ghPut(url, pat, message, data, sha) {
  const body = { message, content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64') };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, status: res.status };
}

// ─── GET SOAL ─────────────────────────────────────────────────────────────────

async function handleGetSoal(req, res) {
  const { tes } = req.query;
  if (!tes) return res.status(400).json({ error: 'Parameter ?tes diperlukan.' });
  const env = checkEnv(res); if (!env) return;
  const { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO } = env;
  try {
    const result = await ghGet(ghUrl(GITHUB_OWNER, GITHUB_REPO, `data/soal-${tes}.json`), GITHUB_PAT);
    if (!result.ok) {
      if (result.status === 404) return res.status(404).json({ error: `Soal "${tes}" belum tersedia.` });
      return res.status(result.status).json({ error: `GitHub API error ${result.status}` });
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).json(normalizeFormatSoal(result.data, tes));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function normalizeFormatSoal(data, tesKey) {
  const durasiDefault = { toefl: 3600, iq: 2700, ukbi: 4500, reading: 1800 };
  const namaDefault   = { toefl: 'TOEFL', iq: 'Tes IQ', ukbi: 'UKBI', reading: 'Pemahaman Bacaan' };
  if (data.nama && data.soal && Array.isArray(data.soal) && data.soal[0]?.teks !== undefined) return data;
  if (data.soal && data.soal[0]?.pertanyaan !== undefined) {
    const li = { A:0, B:1, C:2, D:3 };
    return {
      nama: data.judul || namaDefault[tesKey] || tesKey.toUpperCase(),
      durasi: (data.durasiMenit || durasiDefault[tesKey]/60) * 60,
      soal: data.soal.map(s => ({
        id: s.id, kategori: s.kategori||'Umum', teks: s.pertanyaan,
        hint: s.pembahasan||null,
        opsi: typeof s.opsi==='object'&&!Array.isArray(s.opsi)
          ? [s.opsi.A,s.opsi.B,s.opsi.C,s.opsi.D] : s.opsi,
        jawaban: typeof s.jawaban==='string'
          ? (li[s.jawaban.toUpperCase()]??0) : s.jawaban
      }))
    };
  }
  return {
    nama: data.nama||namaDefault[tesKey]||tesKey,
    durasi: data.durasi||durasiDefault[tesKey]||3600,
    soal: data.soal||[]
  };
}

// ─── GET HASIL ────────────────────────────────────────────────────────────────

async function handleGetHasil(req, res) {
  const env = checkEnv(res); if (!env) return;
  const { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO } = env;
  try {
    const result = await ghGet(ghUrl(GITHUB_OWNER, GITHUB_REPO, 'data/hasil-tes.json'), GITHUB_PAT);
    if (!result.ok) {
      if (result.status === 404) return res.status(200).json([]);
      return res.status(result.status).json({ error: `GitHub API error ${result.status}` });
    }
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
    return res.status(200).json(Array.isArray(result.data) ? result.data : []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── SIMPAN HASIL ─────────────────────────────────────────────────────────────

async function handleSimpanHasil(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  const env = checkEnv(res); if (!env) return;
  const { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO } = env;
  const body = req.body;
  if (!body?.tesKey || body.skor === undefined)
    return res.status(400).json({ error: 'Body harus mengandung tesKey dan skor.' });
  try {
    const url = ghUrl(GITHUB_OWNER, GITHUB_REPO, 'data/hasil-tes.json');
    const existing = await ghGet(url, GITHUB_PAT);
    let list = (existing.ok && Array.isArray(existing.data)) ? existing.data : [];
    list.push({
      tesKey: body.tesKey,
      tesNama: body.tesNama || body.tesKey.toUpperCase(),
      pesertaNama: (body.pesertaNama||'Anonim').substring(0,60),
      skor: Number(body.skor)||0,
      totalSoal: Number(body.totalSoal)||0,
      waktuDipakai: Number(body.waktuDipakai)||0,
      timestamp: body.timestamp || new Date().toISOString()
    });
    if (list.length > 1000) list = list.slice(list.length - 1000);
    const put = await ghPut(url, GITHUB_PAT,
      `[ujicoba] Hasil: ${body.tesNama} - ${body.pesertaNama}`, list, existing.sha||null);
    if (!put.ok) return res.status(put.status).json({ error: `Gagal simpan: ${put.status}` });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── SAVE SOAL (ADMIN) ────────────────────────────────────────────────────────

async function handleSaveSoal(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  const env = checkEnv(res); if (!env) return;
  if (!checkAdmin(req, res)) return;
  const { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO } = env;
  const body = req.body;
  if (!body?.tesKey || !Array.isArray(body.soal))
    return res.status(400).json({ error: 'Body harus mengandung tesKey dan array soal.' });
  try {
    const url = ghUrl(GITHUB_OWNER, GITHUB_REPO, `data/soal-${body.tesKey}.json`);
    const existing = await ghGet(url, GITHUB_PAT);
    const payload = { nama: body.nama||body.tesKey.toUpperCase(), durasi: body.durasi||3600, soal: body.soal };
    const put = await ghPut(url, GITHUB_PAT,
      `[admin] Update soal: ${body.tesKey} (${body.soal.length} soal)`, payload, existing.sha||null);
    if (!put.ok) return res.status(put.status).json({ error: `Gagal simpan: ${put.status}` });
    return res.status(200).json({ success: true, message: `Soal ${body.tesKey} berhasil disimpan.` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── VERIFY ADMIN ─────────────────────────────────────────────────────────────

async function handleVerifyAdmin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Gunakan POST.' });
  const { ADMIN_KEY } = process.env;
  if (!ADMIN_KEY) return res.status(500).json({ error: 'ADMIN_KEY belum dikonfigurasi.' });
  // Accept key from header OR body
  const key = req.headers['x-admin-key']
    || (req.body && (req.body.adminKey || req.body.key))
    || '';
  if (key !== ADMIN_KEY) {
    await new Promise(r => setTimeout(r, 400));
    return res.status(403).json({ error: 'Admin key tidak valid.' });
  }
  return res.status(200).json({ ok: true });
}

// ─── DELETE HASIL (ADMIN) ─────────────────────────────────────────────────────

async function handleDeleteHasil(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE')
    return res.status(405).json({ error: 'Gunakan POST.' });
  const env = checkEnv(res); if (!env) return;
  if (!checkAdmin(req, res)) return;
  const { GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO } = env;
  const body = req.body;
  const mode = body?.mode || 'single';
  try {
    const url = ghUrl(GITHUB_OWNER, GITHUB_REPO, 'data/hasil-tes.json');
    const existing = await ghGet(url, GITHUB_PAT);
    if (!existing.ok) return res.status(404).json({ error: 'File hasil-tes.json tidak ditemukan.' });
    let list = Array.isArray(existing.data) ? existing.data : [];
    let deleted = 0;
    if (mode === 'reset') {
      deleted = list.length; list = [];
    } else if (mode === 'single') {
      const i = Number(body?.index);
      if (isNaN(i) || i < 0 || i >= list.length)
        return res.status(400).json({ error: `Index ${i} tidak valid.` });
      list.splice(i, 1); deleted = 1;
    } else if (mode === 'filter') {
      const before = list.length;
      list = list.filter(e => !(e.pesertaNama === body.pesertaNama &&
        (!body.tesKey || e.tesKey === body.tesKey)));
      deleted = before - list.length;
    }
    const put = await ghPut(url, GITHUB_PAT,
      `[admin] Hapus ${deleted} entri scoreboard`, list, existing.sha);
    if (!put.ok) return res.status(put.status).json({ error: `Gagal simpan: ${put.status}` });
    return res.status(200).json({ success: true, message: `${deleted} entri berhasil dihapus.`, deletedCount: deleted, remaining: list.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
