// api/save-data.js
// Menyimpan data.json ke GitHub via PUT
// SHA diambil otomatis dari GitHub jika tidak dikirim dari client (mencegah 422)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH, GITHUB_PAT } = process.env;

  if (!GITHUB_OWNER || !GITHUB_REPO || !GITHUB_PAT) {
    return res.status(500).json({ message: 'Environment variables belum dikonfigurasi di Vercel.' });
  }

  const filePath = GITHUB_PATH || 'data.json';
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let { kategori, artikel, _sha } = req.body;

  // ── Jika SHA tidak dikirim atau kosong, ambil SHA terbaru dari GitHub ──
  // Ini mencegah error 422 "sha does not match" / missing sha
  if (!_sha) {
    try {
      const getR = await fetch(url, { headers: ghHeaders });
      if (!getR.ok) {
        const errBody = await getR.text();
        return res.status(getR.status).json({ message: `Gagal ambil SHA dari GitHub: ${errBody}` });
      }
      const getJ = await getR.json();
      _sha = getJ.sha;
    } catch (e) {
      return res.status(500).json({ message: 'Gagal fetch SHA: ' + e.message });
    }
  }

  // Encode konten ke base64 (format yang diminta GitHub API)
  const jsonString = JSON.stringify({ kategori, artikel }, null, 2);
  const content = Buffer.from(jsonString, 'utf-8').toString('base64');

  const body = {
    message: 'Update data.json via admin panel',
    content,
    sha: _sha,
  };

  try {
    const putR = await fetch(url, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(body),
    });

    if (!putR.ok) {
      const errBody = await putR.text();
      return res.status(putR.status).json({ message: `GitHub PUT error ${putR.status}: ${errBody}` });
    }

    const putJ = await putR.json();
    // Kembalikan SHA baru ke frontend agar simpan berikutnya juga berhasil
    return res.status(200).json({ sha: putJ.content.sha, message: 'Berhasil disimpan.' });

  } catch (e) {
    return res.status(500).json({ message: 'Server error: ' + e.message });
  }
}
