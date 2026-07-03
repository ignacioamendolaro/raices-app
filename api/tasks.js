const NOTION_API = 'https://api.notion.com/v1';

// Escribe en Notion; si Subtarea no existe en la DB, reintenta sin ella
async function notionWrite(url, method, headers, body) {
  const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
  const result = await r.json();
  if (result.object === 'error' && result.message && result.message.includes('Subtarea')) {
    const body2 = JSON.parse(JSON.stringify(body));
    if (body2.properties) delete body2.properties.Subtarea;
    const r2 = await fetch(url, { method, headers, body: JSON.stringify(body2) });
    return r2.json();
  }
  return result;
}

async function queryAllTasks(dbId, token, includeDone) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
  let tasks = [], cursor;
  do {
    const body = { sorts: [{ property: 'Fin', direction: 'ascending' }], page_size: 100 };
    if (!includeDone) body.filter = { property: 'Estado', select: { does_not_equal: 'Realizado' } };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.object === 'error') throw new Error(data.message);
    tasks = tasks.concat((data.results || []).map(p => ({
      id: p.id,
      nombre: p.properties.Tarea?.title?.[0]?.plain_text || '',
      cliente: p.properties.Cliente?.select?.name || 'General',
      estado: p.properties.Estado?.select?.name || 'Pendiente',
      inicio: p.properties.Inicio?.date?.start || null,
      fin: p.properties.Fin?.date?.start || null,
      responsable: p.properties.Responsable?.select?.name || '',
      sub: p.properties.Subtarea?.rich_text?.[0]?.plain_text || '',
    })));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return tasks;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const DB_ID = process.env.NOTION_DATABASE_ID;
  const TOKEN = process.env.NOTION_API_KEY;
  const H = {
    'Authorization': `Bearer ${TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  try {
    // GET
    if (req.method === 'GET') {
      const includeDone = req.query?.include_done === 'true';
      const tasks = await queryAllTasks(DB_ID, TOKEN, includeDone);
      return res.json({ tasks });
    }

    // POST — crear una o varias tareas
    if (req.method === 'POST') {
      const makeProps = (t) => {
        const props = {
          Tarea: { title: [{ text: { content: t.nombre } }] },
          Cliente: { select: { name: t.cliente } },
          Estado: { select: { name: t.estado || 'Pendiente' } },
        };
        if (t.inicio) props.Inicio = { date: { start: t.inicio } };
        if (t.fin) props.Fin = { date: { start: t.fin } };
        if (t.responsable) props.Responsable = { select: { name: t.responsable } };
        if (t.sub) props.Subtarea = { rich_text: [{ text: { content: t.sub } }] };
        return props;
      };

      // Batch (tareas periódicas)
      if (req.body.instances) {
        const ids = [];
        for (const inst of req.body.instances) {
          const page = await notionWrite(
            `${NOTION_API}/pages`, 'POST', H,
            { parent: { database_id: DB_ID }, properties: makeProps(inst) }
          );
          if (page.object === 'error') throw new Error(page.message);
          ids.push(page.id);
        }
        return res.json({ ids, count: ids.length });
      }

      // Single
      const { nombre, cliente, responsable, inicio, fin, sub } = req.body;
      if (!nombre || !cliente) return res.status(400).json({ error: 'Faltan campos requeridos' });
      const page = await notionWrite(
        `${NOTION_API}/pages`, 'POST', H,
        { parent: { database_id: DB_ID }, properties: makeProps({ nombre, cliente, responsable, inicio, fin, sub }) }
      );
      if (page.object === 'error') return res.status(400).json({ error: page.message });
      return res.json({ id: page.id });
    }

    // PATCH — actualizar campos
    if (req.method === 'PATCH') {
      const { id, estado, inicio, fin, sub } = req.body;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const props = {};
      if (estado) props.Estado = { select: { name: estado } };
      if (inicio !== undefined) props.Inicio = inicio ? { date: { start: inicio } } : { date: null };
      if (fin !== undefined) props.Fin = fin ? { date: { start: fin } } : { date: null };
      if (sub !== undefined) props.Subtarea = { rich_text: sub ? [{ text: { content: sub } }] : [] };
      const result = await notionWrite(`${NOTION_API}/pages/${id}`, 'PATCH', H, { properties: props });
      if (result.object === 'error') return res.status(400).json({ error: result.message });
      return res.json({ ok: true });
    }

    // DELETE — una tarea o toda la serie
    if (req.method === 'DELETE') {
      const { id, serie_id } = req.body;

      if (serie_id) {
        // Buscar y archivar todas las tareas de la serie
        let allPages = [], cursor;
        do {
          const body = {
            filter: { property: 'Subtarea', rich_text: { contains: `[SID:${serie_id}]` } },
            page_size: 100,
          };
          if (cursor) body.start_cursor = cursor;
          const r = await fetch(`${NOTION_API}/databases/${DB_ID}/query`, {
            method: 'POST', headers: H, body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.object === 'error') throw new Error(data.message);
          if (!data.results) break;
          allPages = allPages.concat(data.results.map(p => p.id));
          cursor = data.has_more ? data.next_cursor : undefined;
        } while (cursor);

        for (const pid of allPages) {
          await fetch(`${NOTION_API}/pages/${pid}`, {
            method: 'PATCH', headers: H, body: JSON.stringify({ archived: true }),
          });
        }
        return res.json({ deleted: allPages.length });
      }

      if (!id) return res.status(400).json({ error: 'Falta id' });
      const r = await fetch(`${NOTION_API}/pages/${id}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ archived: true }),
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
