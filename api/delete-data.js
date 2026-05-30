// api/delete-data.js
// Menghapus satu artikel atau satu kategori dari data.json di GitHub
// Method: DELETE
// Body: { type: "art" | "kat", id: "id_xxx" }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') {
    return res.status(405).json({ message: 'Method not allowed. Gunakan DELETE.' });
  }

  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH, GITHUB_PAT } = process.env;

  if (!GITHUB_OWNER || !GITHUB_REPO || !GITHUB_PAT) {
    return res.status(500).json({ message: 'Environment variables belum dikonfigurasi di Vercel.' });
  }

  const { type, id } = req.body;

  if (!type || !id) {
    return res.status(400).json({ message: 'Body harus berisi "type" ("art" atau "kat") dan "id".' });
  }
  if (type !== 'art' && type !== 'kat') {
    return res.status(400).json({ message: '"type" harus bernilai "art" atau "kat".' });
  }

  const filePath = GITHUB_PATH || 'data.json';
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // ── 1. Ambil data & SHA terbaru dari GitHub ──
  let currentData, currentSha;
  try {
    const getR = await fetch(url, { headers: ghHeaders });
    if (!getR.ok) {
      const errBody = await getR.text();
      return res.status(getR.status).json({ message: `Gagal ambil data dari GitHub: ${errBody}` });
    }
    const getJ = await getR.json();
    currentSha = getJ.sha;
    const raw = Buffer.from(getJ.content, 'base64').toString('utf-8');
    currentData = JSON.parse(raw);
  } catch (e) {
    return res.status(500).json({ message: 'Gagal membaca data dari GitHub: ' + e.message });
  }

  // ── 2. Lakukan penghapusan ──
  let found = false;
  if (type === 'art') {
    const before = (currentData.artikel || []).length;
    currentData.artikel = (currentData.artikel || []).filter(a => a.id !== id);
    found = currentData.artikel.length < before;
  } else {
    const before = (currentData.kategori || []).length;
    currentData.kategori = (currentData.kategori || []).filter(k => k.id !== id);
    found = currentData.kategori.length < before;
  }

  if (!found) {
    return res.status(404).json({ message: `Item dengan id "${id}" tidak ditemukan.` });
  }

  // ── 3. Simpan kembali ke GitHub ──
  const jsonString = JSON.stringify(
    { kategori: currentData.kategori, artikel: currentData.artikel },
    null,
    2
  );
  const content = Buffer.from(jsonString, 'utf-8').toString('base64');

  try {
    const putR = await fetch(url, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `Delete ${type === 'art' ? 'artikel' : 'kategori'} id:${id} via admin panel`,
        content,
        sha: currentSha,
      }),
    });

    if (!putR.ok) {
      const errBody = await putR.text();
      return res.status(putR.status).json({ message: `GitHub PUT error ${putR.status}: ${errBody}` });
    }

    const putJ = await putR.json();
    return res.status(200).json({
      message: `${type === 'art' ? 'Artikel' : 'Kategori'} berhasil dihapus.`,
      sha: putJ.content.sha,
    });
  } catch (e) {
    return res.status(500).json({ message: 'Server error saat menyimpan: ' + e.message });
  }
}
