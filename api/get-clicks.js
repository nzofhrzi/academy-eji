// api/get-clicks.js
// Mengambil semua data klik dari clicks.json di GitHub
// Method: GET
// Returns: { clicks: [...], summary: { by_article: {...}, by_date: {...}, by_kategori: {...} } }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_PAT } = process.env;

  if (!GITHUB_OWNER || !GITHUB_REPO || !GITHUB_PAT) {
    return res.status(500).json({ message: 'Environment variables belum dikonfigurasi.' });
  }

  const CLICKS_FILE = 'clicks.json';
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${CLICKS_FILE}`;
  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    const getR = await fetch(url, { headers: ghHeaders });

    // Jika file belum ada, kembalikan data kosong
    if (getR.status === 404) {
      return res.status(200).json({ clicks: [], summary: { by_article: {}, by_date: {}, by_kategori: {} } });
    }

    if (!getR.ok) {
      const errBody = await getR.text();
      return res.status(getR.status).json({ message: `GitHub error: ${errBody}` });
    }

    const getJ = await getR.json();
    const raw = Buffer.from(getJ.content, 'base64').toString('utf-8');
    const clicksData = JSON.parse(raw);
    const clicks = clicksData.clicks || [];

    // ── Buat ringkasan / summary ──
    const by_article = {};
    const by_date = {};
    const by_kategori = {};

    clicks.forEach(c => {
      // Per artikel
      if (!by_article[c.artikel_id]) {
        by_article[c.artikel_id] = { artikel_id: c.artikel_id, judul: c.artikel_judul, count: 0 };
      }
      by_article[c.artikel_id].count++;

      // Per tanggal
      if (!by_date[c.date]) by_date[c.date] = 0;
      by_date[c.date]++;

      // Per kategori
      if (c.kategori_id) {
        if (!by_kategori[c.kategori_id]) by_kategori[c.kategori_id] = 0;
        by_kategori[c.kategori_id]++;
      }
    });

    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate');
    return res.status(200).json({
      clicks,
      summary: { by_article, by_date, by_kategori },
    });

  } catch (e) {
    return res.status(500).json({ message: 'Server error: ' + e.message });
  }
}
