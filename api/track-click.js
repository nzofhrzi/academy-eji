// api/track-click.js
// Mencatat setiap klik artikel ke clicks.json di GitHub
// Method: POST
// Body: { artikel_id, artikel_judul, kategori_id }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_PAT } = process.env;

  if (!GITHUB_OWNER || !GITHUB_REPO || !GITHUB_PAT) {
    return res.status(500).json({ message: 'Environment variables belum dikonfigurasi.' });
  }

  const { artikel_id, artikel_judul, kategori_id } = req.body;
  if (!artikel_id) {
    return res.status(400).json({ message: 'artikel_id diperlukan.' });
  }

  const CLICKS_FILE = 'clicks.json';
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${CLICKS_FILE}`;
  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // ── 1. Ambil clicks.json (buat baru jika belum ada) ──
  let clicksData = { clicks: [] };
  let currentSha = null;

  try {
    const getR = await fetch(url, { headers: ghHeaders });
    if (getR.ok) {
      const getJ = await getR.json();
      currentSha = getJ.sha;
      const raw = Buffer.from(getJ.content, 'base64').toString('utf-8');
      clicksData = JSON.parse(raw);
    } else if (getR.status !== 404) {
      const errBody = await getR.text();
      return res.status(getR.status).json({ message: `GitHub error: ${errBody}` });
    }
    // Jika 404 → file belum ada, kita buat baru (currentSha tetap null)
  } catch (e) {
    return res.status(500).json({ message: 'Gagal membaca clicks.json: ' + e.message });
  }

  // ── 2. Tambahkan record klik baru ──
  const now = new Date().toISOString();
  if (!clicksData.clicks) clicksData.clicks = [];

  clicksData.clicks.push({
    artikel_id,
    artikel_judul: artikel_judul || '',
    kategori_id: kategori_id || '',
    timestamp: now,
    // Tanggal saja untuk grouping harian
    date: now.slice(0, 10),
  });

  // ── 3. Simpan kembali ke GitHub ──
  const jsonString = JSON.stringify(clicksData, null, 2);
  const content = Buffer.from(jsonString, 'utf-8').toString('base64');

  const putBody = {
    message: `Track click: ${artikel_id} at ${now}`,
    content,
  };
  if (currentSha) putBody.sha = currentSha;

  try {
    const putR = await fetch(url, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(putBody),
    });

    if (!putR.ok) {
      const errBody = await putR.text();
      return res.status(putR.status).json({ message: `GitHub PUT error: ${errBody}` });
    }

    return res.status(200).json({ message: 'Klik berhasil dicatat.' });
  } catch (e) {
    return res.status(500).json({ message: 'Server error: ' + e.message });
  }
}
