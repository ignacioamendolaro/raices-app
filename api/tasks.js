const NOTION_API = 'https://api.notion.com/v1';

async function queryAllTasks(dbId, token, includeDone = false) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
  let tasks = [], cursor = undefined;
  do {
    const body = {
      sorts: [{ property: 'Fin', direction: 'ascending' }],
      page_size: 100,
    };
    if (!includeDone) {
      body.filter = { property: 'Estado', select: { does_not_equal: 'Realizado' } };
    }
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.object === 'error') throw new Error(data.message);
    tasks = tasks.concat((data.results || []).map(page => ({
      id: page.id,
      nombre: page.properties.Tarea?.title?.[0]?.plain_text || '',
      cliente: page.properties.Cliente?.select?.name || 'General',
      estado: page.properties.Estado?.select?.name || 'Pendiente',
      inicio: page.properties.Inicio?.date?.start || null,
      fin: page.properties.Fin?.date?.start || null,
      responsable: page.properties.Responsable?.select?.name || '',
      sub: page.properties.Subtarea?.rich_text?.[0]?.plain_text || '',
    })));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return tasks;
}

async function createPage(dbId, token, task) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
  const props = {
    Tarea: { title: [{ text: { content: task.nombre } }] },
    Cliente: { select: { name: task.cliente } },
    Estado: { select: { name: task.estado || 'Pendiente' } },
  };
  if (task.inicio) props.Inicio = { date: { start: task.inicio } };
  if (task.fin) props.Fin = { date: { start: task.fin } };
  if (task.responsable) props.Responsable = { select: { name: task.responsable } };
  if (task.sub) props.Subtarea = { rich_text: [{ text: { content: task.sub } }] };
  const r = await fetch(`${NOTION_API}/pages`, {
    method: 'POST', headers,
    body: JSON.stringify({ parent: { database_id: dbId }, properties: props }),
  });
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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
    // ── GET ──
    if (req.method === 'GET') {
      const includeDone = req.query?.include_done === 'true';
      const tasks = await queryAllTasks(DB_ID, TOKEN, includeDone);
      return res.json({ tasks });
    }

    // ── POST ──
    if (req.method === 'POST') {
      // Batch create (series periódicas)
      if (req.body.instances) {
        const { instances } = req.body;
        const ids = [];
        for (const inst of instances) {
          const page = await createPage(DB_ID, TOKEN, inst);
          if (page.object === 'error') throw new Error(page.message);
          ids.push(page.id);
        }
        return res.json({ ids, count: ids.length });
      }

      // Single create
      const { nombre, cliente, responsable, inicio, fin, sub } = req.body;
      if (!nombre || !cliente) return res.status(400).json({ error: 'Faltan campos requeridos' });
      const page = await createPage(DB_ID, TOKEN, { nombre, cliente, responsable, inicio, fin, sub });
      if (page.object === 'error') return res.status(400).json({ error: page.message });
      return res.json({ id: page.id });
    }

    // ── PATCH ──
    if (req.method === 'PATCH') {
      const { id, estado, inicio, fin, sub } = req.body;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const props = {};
      if (estado) props.Estado = { select: { name: estado } };
      if (inicio !== undefined) props.Inicio = inicio ? { date: { start: inicio } } : { date: null };
      if (fin !== undefined) props.Fin = fin ? { date: { start: fin } } : { date: null };
      if (sub !== undefined) props.Subtarea = { rich_text: sub ? [{ text: { content: sub } }] : [] };
      const r = await fetch(`${NOTION_API}/pages/${id}`, {
        method: 'PATCH', headers: notionHeaders,
        body: JSON.stringify({ properties: props }),
      });
      const result = await r.json();
      if (result.object === 'error') return res.status(400).json({ error: result.message });
      return res.json({ ok: true });
    }

    // ── DELETE ──
    if (req.method === 'DELETE') {
      const { id, serie_id } = req.body;

      // Eliminar toda la serie
      if (serie_id) {
        let allPages = [], cursor;
        do {
          const body = {
            filter: { property: 'Subtarea', rich_text: { contains: `[SID:${serie_id}]` } },
            page_size: 100,
          };
          if (cursor) body.start_cursor = cursor;
          const r = await fetch(`${NOTION_API}/databases/${DB_ID}/query`, {
            method: 'POST', headers: notionHeaders, body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.object === 'error') throw new Error(data.message);
          if (!data.results) break;
          allPages = allPages.concat(data.results.map(p => p.id));
          cursor = data.has_more ? data.next_cursor : undefined;
        } while (cursor);

        for (const pid of allPages) {
          await fetch(`${NOTION_API}/pages/${pid}`, {
            method: 'PATCH', headers: notionHeaders,
            body: JSON.stringify({ archived: true }),
          });
        }
        return res.json({ deleted: allPages.length });
      }

      // Eliminar una sola tarea
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const r = await fetch(`${NOTION_API}/pages/${id}`, {
        method: 'PATCH', headers: notionHeaders,
        body: JSON.stringify({ archived: true }),
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
