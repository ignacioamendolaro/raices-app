const NOTION_API = 'https://api.notion.com/v1';
const KNOWN_CLIENTS = ['OCD','Suralnor','Cafaratti','Pagani','Conexxo','Artico','Lactosur','Alianzas','ADIA','Raíces','Marca Personal','General'];

function parseCSV(text) {
  const rows = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let inQuote = false, cell = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { row.push(cell.trim()); cell = ''; }
      else { cell += ch; }
    }
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

function parseDate(str) {
  if (!str) return null;
  // DD/MM/YYYY o DD-MM-YYYY
  let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  // YYYY-MM-DD (ya está bien)
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return str;
  return null;
}

function isClientHeader(row) {
  const b = row[1]?.trim(); // col B
  const c = row[2]?.trim(); // col C (inicio)
  const d = row[3]?.trim(); // col D (fin)
  if (!b) return false;
  // Si C y D están vacíos y B coincide (parcial, sin importar mayúsculas) con algún cliente
  const isEmpty = !c && !d;
  const matchesClient = KNOWN_CLIENTS.some(cl => b.toLowerCase().includes(cl.toLowerCase()) || cl.toLowerCase().includes(b.toLowerCase()));
  return isEmpty && matchesClient;
}

async function getSheetTasks(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=Empresas%20Gantt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo leer el Sheet (${res.status}). ¿Está publicado?`);
  const csv = await res.text();
  const rows = parseCSV(csv);

  const tasks = [];
  let currentClient = null;

  for (const row of rows) {
    const b = row[1]?.trim(); // nombre tarea
    const c = row[2]?.trim(); // inicio
    const d = row[3]?.trim(); // fin
    const e = row[4]?.trim(); // responsable
    const g = row[6]?.trim(); // estado

    if (!b) continue;

    // Detectar fila de encabezado de cliente
    if (isClientHeader(row)) {
      // Buscar cuál cliente coincide
      const matched = KNOWN_CLIENTS.find(cl =>
        b.toLowerCase().includes(cl.toLowerCase()) || cl.toLowerCase().includes(b.toLowerCase())
      );
      currentClient = matched || b;
      continue;
    }

    // Fila de tarea
    if (currentClient) {
      const estadoMap = { 'realizado': 'Realizado', 'en progreso': 'En Progreso', 'pendiente': 'Pendiente' };
      const estadoNorm = estadoMap[g?.toLowerCase()] || 'Pendiente';
      tasks.push({
        nombre: b,
        cliente: currentClient,
        inicio: parseDate(c),
        fin: parseDate(d),
        responsable: e || '',
        estado: estadoNorm,
      });
    }
  }
  return tasks;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const DB_ID = process.env.NOTION_DATABASE_ID;
  const TOKEN = process.env.NOTION_API_KEY;

  try {
    const sheetTasks = await getSheetTasks(SHEET_ID);

    // GET: solo devolver las tareas del sheet (preview)
    if (req.method === 'GET') {
      return res.json({ tasks: sheetTasks, total: sheetTasks.length });
    }

    // POST: sincronizar a Notion
    if (req.method === 'POST') {
      const notionHeaders = {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      };

      // Traer todas las tareas existentes en Notion (incluyendo Realizadas)
      let allExisting = [];
      let cursor = undefined;
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`${NOTION_API}/databases/${DB_ID}/query`, {
          method: 'POST', headers: notionHeaders, body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!data.results) break;
        allExisting = allExisting.concat(
          data.results.map(p => p.properties.Tarea?.title?.[0]?.plain_text?.trim().toLowerCase())
        );
        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);

      const existingSet = new Set(allExisting.filter(Boolean));

      // Filtrar tareas nuevas (no en Notion)
      const toCreate = sheetTasks.filter(t => !existingSet.has(t.nombre.toLowerCase()));

      let created = 0;
      for (const task of toCreate) {
        const props = {
          Tarea: { title: [{ text: { content: task.nombre } }] },
          Cliente: { select: { name: task.cliente } },
          Estado: { select: { name: task.estado } },
        };
        if (task.inicio) props.Inicio = { date: { start: task.inicio } };
        if (task.fin) props.Fin = { date: { start: task.fin } };
        if (task.responsable) props.Responsable = { select: { name: task.responsable } };

        const r = await fetch(`${NOTION_API}/pages`, {
          method: 'POST', headers: notionHeaders,
          body: JSON.stringify({ parent: { database_id: DB_ID }, properties: props }),
        });
        const result = await r.json();
        if (result.id) created++;
      }

      return res.json({ synced: created, total: sheetTasks.length, skipped: sheetTasks.length - created });
    }

    res.status(405).json({ error: 'Método no permitido' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
