// api/edit-data.js
// Mengedit satu artikel atau satu kategori di data.json GitHub
// Method: PUT
// Body artikel : { type: "art", id: "id_xxx", data: { judul, deskripsi, gambar, kategori_id, tanggal, featured } }
// Body kategori: { type: "kat", id: "id_xxx", data: { nama, warna } }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PUT') {
    return res.status(405).json({ message: 'Method not allowed. Gunakan PUT.' });
  }

  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH, GITHUB_PAT } = process.env;

  if (!GITHUB_OWNER || !GITHUB_REPO || !GITHUB_PAT) {
    return res.status(500).json({ message: 'Environment variables belum dikonfigurasi di Vercel.' });
  }

  const { type, id, data: newData } = req.body;

  if (!type || !id || !newData) {
    return res.status(400).json({ message: 'Body harus berisi "type", "id", dan "data".' });
  }
  if (type !== 'art' && type !== 'kat') {
    return res.status(400).json({ message: '"type" harus bernilai "art" atau "kat".' });
  }

  // Validasi field wajib berdasarkan tipe
  if (type === 'art' && !newData.judul) {
    return res.status(400).json({ message: 'Field "judul" wajib diisi untuk artikel.' });
  }
  if (type === 'kat' && !newData.nama) {
    return res.status(400).json({ message: 'Field "nama" wajib diisi untuk kategori.' });
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

  // ── 2. Temukan dan update item ──
  let found = false;

  if (type === 'art') {
    const idx = (currentData.artikel || []).findIndex(a => a.id === id);
    if (idx === -1) {
      return res.status(404).json({ message: `Artikel dengan id "${id}" tidak ditemukan.` });
    }
    // Gabung data lama dengan data baru; id tidak boleh diubah
    currentData.artikel[idx] = {
      ...currentData.artikel[idx],
      judul:       newData.judul       ?? currentData.artikel[idx].judul,
      deskripsi:   newData.deskripsi   ?? currentData.artikel[idx].deskripsi,
      gambar:      newData.gambar      ?? currentData.artikel[idx].gambar,
      kategori_id: newData.kategori_id ?? currentData.artikel[idx].kategori_id,
      tanggal:     newData.tanggal     ?? currentData.artikel[idx].tanggal,
      featured:    newData.featured    !== undefined ? newData.featured : currentData.artikel[idx].featured,
      id,  // pastikan id tidak berubah
    };
    found = true;
  } else {
    const idx = (currentData.kategori || []).findIndex(k => k.id === id);
    if (idx === -1) {
      return res.status(404).json({ message: `Kategori dengan id "${id}" tidak ditemukan.` });
    }
    currentData.kategori[idx] = {
      ...currentData.kategori[idx],
      nama:  newData.nama  ?? currentData.kategori[idx].nama,
      warna: newData.warna ?? currentData.kategori[idx].warna,
      id,
    };
    found = true;
  }

  if (!found) {
    return res.status(404).json({ message: 'Item tidak ditemukan.' });
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
        message: `Edit ${type === 'art' ? 'artikel' : 'kategori'} id:${id} via admin panel`,
        content,
        sha: currentSha,
      }),
    });

    if (!putR.ok) {
      const errBody = await putR.text();
      return res.status(putR.status).json({ message: `GitHub PUT error ${putR.status}: ${errBody}` });
    }

    const putJ = await putR.json();
    const updatedItem =
      type === 'art'
        ? currentData.artikel.find(a => a.id === id)
        : currentData.kategori.find(k => k.id === id);

    return res.status(200).json({
      message: `${type === 'art' ? 'Artikel' : 'Kategori'} berhasil diperbarui.`,
      sha: putJ.content.sha,
      item: updatedItem,
    });
  } catch (e) {
    return res.status(500).json({ message: 'Server error saat menyimpan: ' + e.message });
  }
}
