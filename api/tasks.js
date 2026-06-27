const NOTION_API = 'https://api.notion.com/v1';
 
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const DB_ID = process.env.NOTION_DATABASE_ID;
  const TOKEN = process.env.NOTION_API_KEY;
 
  const notionHeaders = {
    'Authorization': `Bearer ${TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
 
  try {
    if (req.method === 'GET') {
      const r = await fetch(`${NOTION_API}/databases/${DB_ID}/query`, {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({ page_size: 5 }),
      });
      const raw = await r.json();
 
      if (raw.object === 'error') {
        return res.json({ debug: 'NOTION_ERROR', status: raw.status, message: raw.message, code: raw.code, db_id: DB_ID, token_starts: TOKEN ? TOKEN.substring(0, 12) + '...' : 'MISSING' });
      }
 
      const tasks = (raw.results || []).map(page => ({
        id: page.id,
        nombre: page.properties.Tarea?.title?.[0]?.plain_text || '',
        cliente: page.properties.Cliente?.select?.name || 'General',
        estado: page.properties.Estado?.select?.name || 'Pendiente',
        inicio: page.properties.Inicio?.date?.start || null,
        fin: page.properties.Fin?.date?.start || null,
        responsable: page.properties.Responsable?.select?.name || '',
        sub: page.properties.Subtarea?.rich_text?.[0]?.plain_text || '',
      }));
 
      return res.json({ debug: 'OK', total_in_notion: raw.results?.length, has_more: raw.has_more, tasks });
    }
 
    if (req.method === 'POST') {
      const { nombre, cliente, responsable, inicio, fin } = req.body;
      if (!nombre || !cliente) return res.status(400).json({ error: 'Faltan campos requeridos' });
      const props = {
        Tarea: { title: [{ text: { content: nombre } }] },
        Cliente: { select: { name: cliente } },
        Estado: { select: { name: 'Pendiente' } },
      };
      if (inicio) props.Inicio = { date: { start: inicio } };
      if (fin) props.Fin = { date: { start: fin } };
      if (responsable) props.Responsable = { select: { name: responsable } };
      const r = await fetch(`${NOTION_API}/pages`, {
        method: 'POST', headers: notionHeaders,
        body: JSON.stringify({ parent: { database_id: DB_ID }, properties: props }),
      });
      const page = await r.json();
      if (page.object === 'error') return res.status(400).json({ error: page.message });
      return res.json({ id: page.id });
    }
 
    if (req.method === 'PATCH') {
      const { id, estado, fin } = req.body;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const props = {};
      if (estado) props.Estado = { select: { name: estado } };
      if (fin) props.Fin = { date: { start: fin } };
      const r = await fetch(`${NOTION_API}/pages/${id}`, {
        method: 'PATCH', headers: notionHeaders,
        body: JSON.stringify({ properties: props }),
      });
      const result = await r.json();
      if (result.object === 'error') return res.status(400).json({ error: result.message });
      return res.json({ ok: true });
    }
 
    res.status(405).json({ error: 'Método no permitido' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
