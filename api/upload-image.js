// api/upload-image.js
// Upload gambar ke GitHub repo (folder /images/) dan kembalikan URL raw-nya
// Method: POST
// Body (JSON): { filename: "nama-file.jpg", base64: "<base64 string tanpa prefix>" }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed. Gunakan POST.' });
  }

  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_PAT, GITHUB_BRANCH } = process.env;

  if (!GITHUB_OWNER || !GITHUB_REPO || !GITHUB_PAT) {
    return res.status(500).json({ message: 'Environment variables belum dikonfigurasi di Vercel.' });
  }

  const { filename, base64 } = req.body;

  if (!filename || !base64) {
    return res.status(400).json({ message: 'Body harus berisi "filename" dan "base64".' });
  }

  // Sanitasi nama file: hanya huruf, angka, titik, strip, underscore
  const safeName = filename
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.\-_]/g, '')
    .replace(/\.+/g, '.') // cegah double dot
    .slice(0, 120);

  if (!safeName) {
    return res.status(400).json({ message: 'Nama file tidak valid.' });
  }

  // Tambahkan timestamp agar nama file unik
  const ext = safeName.includes('.') ? safeName.split('.').pop() : 'jpg';
  const baseName = safeName.includes('.')
    ? safeName.slice(0, safeName.lastIndexOf('.'))
    : safeName;
  const uniqueName = `${baseName}-${Date.now()}.${ext}`;
  const filePath = `images/${uniqueName}`;

  const branch = GITHUB_BRANCH || 'main';
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `Upload gambar: ${uniqueName} via admin panel`,
        content: base64, // sudah base64, GitHub API minta format ini
        branch,
      }),
    });

    if (!putRes.ok) {
      const errBody = await putRes.text();
      return res.status(putRes.status).json({
        message: `GitHub PUT error ${putRes.status}: ${errBody}`,
      });
    }

    // URL raw GitHub agar bisa langsung dipakai di <img>
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${branch}/${filePath}`;

    return res.status(200).json({
      message: 'Gambar berhasil diupload.',
      url: rawUrl,
      path: filePath,
    });
  } catch (e) {
    return res.status(500).json({ message: 'Server error: ' + e.message });
  }
}
