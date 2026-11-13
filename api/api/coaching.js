// api/coaching.js — almacena y recupera procesos de coaching en Notion
// La página Notion actúa como base de datos persistente en lugar de localStorage

const NOTION_API = 'https://api.notion.com/v1';
const PAGE_ID = '4175a6513abc810b8f40c920525c4182'; // raices_procesos_data
const CHUNK_SIZE = 1900;

function getHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}

async function getBlocks(pageId, token) {
  let blocks = [];
  let cursor = null;
  do {
    const url = `${NOTION_API}/blocks/${pageId}/children${cursor ? `?start_cursor=${cursor}` : ''}`;
    const r = await fetch(url, { headers: getHeaders(token) });
    const data = await r.json();
    blocks = blocks.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return blocks;
}

async function deleteBlock(blockId, token) {
  await fetch(`${NOTION_API}/blocks/${blockId}`, {
    method: 'DELETE',
    headers: getHeaders(token),
  });
}

async function appendBlocks(pageId, children, token) {
  await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: getHeaders(token),
    body: JSON.stringify({ children }),
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.NOTION_API_KEY;
  if (!token) return res.status(500).json({ error: 'NOTION_API_KEY not set' });

  // ── GET: leer datos desde Notion ─────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const blocks = await getBlocks(PAGE_ID, token);
      const dataBlocks = blocks.filter(b =>
        b.type === 'code' &&
        b.code?.language === 'json'
      );
      if (dataBlocks.length === 0) return res.status(200).json([]);

      // Concatenar todos los fragmentos de rich_text del bloque de código
      const jsonStr = dataBlocks
        .flatMap(b => b.code?.rich_text || [])
        .map(rt => rt.plain_text || '')
        .join('');

      return res.status(200).json(JSON.parse(jsonStr));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PUT: guardar datos en Notion ─────────────────────────────────────────
  if (req.method === 'PUT') {
    try {
      let body = '';
      await new Promise((resolve, reject) => {
        req.on('data', chunk => body += chunk);
        req.on('end', resolve);
        req.on('error', reject);
      });
      const procesos = JSON.parse(body);
      const jsonStr = JSON.stringify(procesos);

      // Eliminar bloques de código existentes
      const blocks = await getBlocks(PAGE_ID, token);
      for (const block of blocks) {
        if (block.type === 'code' && block.code?.language === 'json') {
          await deleteBlock(block.id, token);
        }
      }

      // Dividir JSON en fragmentos de CHUNK_SIZE chars
      const chunks = [];
      for (let i = 0; i < jsonStr.length; i += CHUNK_SIZE) {
        chunks.push({ type: 'text', text: { content: jsonStr.slice(i, i + CHUNK_SIZE) } });
      }

      // Crear un único bloque de código con todos los fragmentos como rich_text
      await appendBlocks(PAGE_ID, [{
        type: 'code',
        code: {
          language: 'json',
          rich_text: chunks,
        }
      }], token);

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
