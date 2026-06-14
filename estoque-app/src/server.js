'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const Database  = require('better-sqlite3');

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const PORT   = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'estoque.db');

// ─────────────────────────────────────────
//  BANCO DE DADOS
// ─────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS itens (
    cod      TEXT PRIMARY KEY,
    desc     TEXT NOT NULL,
    ref      TEXT DEFAULT '',
    qt       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS movimentacoes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo        TEXT NOT NULL CHECK(tipo IN ('saida','ajuste')),
    cod         TEXT NOT NULL,
    desc        TEXT NOT NULL,
    ref         TEXT DEFAULT '',
    qty         INTEGER,
    anterior_qt INTEGER,
    novo_qt     INTEGER,
    diff        INTEGER,
    motivo      TEXT NOT NULL,
    pessoa      TEXT NOT NULL,
    os          TEXT DEFAULT '',
    obs         TEXT DEFAULT '',
    setor       TEXT DEFAULT '',
    criado_em   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cod         TEXT NOT NULL,
    desc        TEXT NOT NULL,
    ref         TEXT DEFAULT '',
    qty         INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','atendido','cancelado')),
    solicitante TEXT NOT NULL,
    obs         TEXT DEFAULT '',
    criado_em   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    atualizado_em TEXT
  );
`);

// Seed inicial de itens (só se a tabela estiver vazia)
const count = db.prepare('SELECT COUNT(*) as n FROM itens').get().n;
if (count === 0) {
  console.log('Populando banco com itens do estoque...');
  const ITENS = require('./itens.json');
  const insert = db.prepare('INSERT OR IGNORE INTO itens (cod, desc, ref, qt) VALUES (?,?,?,?)');
  const insertMany = db.transaction(itens => {
    for (const i of itens) insert.run(i.cod, i.desc, i.ref || '', i.qt);
  });
  insertMany(ITENS);
  console.log(`${ITENS.length} itens inseridos.`);
}

// ─────────────────────────────────────────
//  EXPRESS
// ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── ITENS ──────────────────────────────
app.get('/api/itens', (req, res) => {
  const { q } = req.query;
  let rows;
  if (q && q.length >= 2) {
    const like = `%${q}%`;
    rows = db.prepare(`SELECT * FROM itens WHERE cod LIKE ? OR desc LIKE ? OR ref LIKE ? ORDER BY desc LIMIT 40`).all(like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM itens ORDER BY desc').all();
  }
  res.json(rows);
});

app.get('/api/itens/:cod', (req, res) => {
  const row = db.prepare('SELECT * FROM itens WHERE cod = ?').get(req.params.cod);
  if (!row) return res.status(404).json({ error: 'Item não encontrado' });
  res.json(row);
});

// ── SAÍDAS ─────────────────────────────
app.post('/api/saidas', (req, res) => {
  const { cod, qty, motivo, pessoa, os, obs, setor } = req.body;
  if (!cod || !qty || !motivo || !pessoa) return res.status(400).json({ error: 'Campos obrigatórios faltando' });

  const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(cod);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  if (qty > item.qt) return res.status(400).json({ error: `Quantidade maior que o estoque atual (${item.qt})` });

  const registrar = db.transaction(() => {
    db.prepare('UPDATE itens SET qt = qt - ? WHERE cod = ?').run(qty, cod);
    const info = db.prepare(`
      INSERT INTO movimentacoes (tipo, cod, desc, ref, qty, anterior_qt, novo_qt, diff, motivo, pessoa, os, obs, setor)
      VALUES ('saida',?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(cod, item.desc, item.ref, qty, item.qt, item.qt - qty, -qty, motivo, pessoa, os||'', obs||'', setor||'');
    return db.prepare('SELECT * FROM movimentacoes WHERE id = ?').get(info.lastInsertRowid);
  });

  const mov = registrar();
  const itemAtualizado = db.prepare('SELECT * FROM itens WHERE cod = ?').get(cod);
  broadcast({ tipo: 'nova_saida', mov, item: itemAtualizado });
  res.json({ ok: true, mov, item: itemAtualizado });
});

// ── AJUSTES ────────────────────────────
app.post('/api/ajustes', (req, res) => {
  const { cod, novoQt, motivo, pessoa, obs, setor } = req.body;
  if (cod === undefined || novoQt === undefined || !motivo || !pessoa)
    return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  if (novoQt < 0) return res.status(400).json({ error: 'Valor inválido' });

  const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(cod);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });

  const registrar = db.transaction(() => {
    const diff = novoQt - item.qt;
    db.prepare('UPDATE itens SET qt = ? WHERE cod = ?').run(novoQt, cod);
    const info = db.prepare(`
      INSERT INTO movimentacoes (tipo, cod, desc, ref, qty, anterior_qt, novo_qt, diff, motivo, pessoa, obs, setor)
      VALUES ('ajuste',?,?,?,?,?,?,?,?,?,?,?)
    `).run(cod, item.desc, item.ref, Math.abs(diff), item.qt, novoQt, diff, motivo, pessoa, obs||'', setor||'');
    return db.prepare('SELECT * FROM movimentacoes WHERE id = ?').get(info.lastInsertRowid);
  });

  const mov = registrar();
  const itemAtualizado = db.prepare('SELECT * FROM itens WHERE cod = ?').get(cod);
  broadcast({ tipo: 'novo_ajuste', mov, item: itemAtualizado });
  res.json({ ok: true, mov, item: itemAtualizado });
});

// ── PEDIDOS (Vendas → Estoque) ─────────
app.get('/api/pedidos', (req, res) => {
  const { status } = req.query;
  let rows;
  if (status) {
    rows = db.prepare('SELECT * FROM pedidos WHERE status = ? ORDER BY criado_em DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM pedidos ORDER BY criado_em DESC LIMIT 200').all();
  }
  res.json(rows);
});

app.post('/api/pedidos', (req, res) => {
  const { cod, qty, solicitante, obs } = req.body;
  if (!cod || !qty || !solicitante) return res.status(400).json({ error: 'Campos obrigatórios faltando' });

  const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(cod);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });

  const info = db.prepare(`
    INSERT INTO pedidos (cod, desc, ref, qty, solicitante, obs)
    VALUES (?,?,?,?,?,?)
  `).run(cod, item.desc, item.ref, qty, solicitante, obs||'');

  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(info.lastInsertRowid);
  broadcast({ tipo: 'novo_pedido', pedido, item });
  res.json({ ok: true, pedido });
});

app.patch('/api/pedidos/:id', (req, res) => {
  const { status, obs } = req.body;
  const { id } = req.params;
  if (!['pendente','atendido','cancelado'].includes(status))
    return res.status(400).json({ error: 'Status inválido' });

  db.prepare(`UPDATE pedidos SET status = ?, obs = COALESCE(?, obs), atualizado_em = datetime('now','localtime') WHERE id = ?`)
    .run(status, obs, id);

  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
  if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
  broadcast({ tipo: 'pedido_atualizado', pedido });
  res.json({ ok: true, pedido });
});

// ── MOVIMENTAÇÕES ──────────────────────
app.get('/api/movimentacoes', (req, res) => {
  const { tipo, periodo } = req.query;
  let sql = 'SELECT * FROM movimentacoes WHERE 1=1';
  const params = [];
  if (tipo) { sql += ' AND tipo = ?'; params.push(tipo); }
  if (periodo === 'hoje')   { sql += " AND DATE(criado_em) = DATE('now','localtime')"; }
  if (periodo === 'semana') { sql += " AND criado_em >= DATE('now','-7 days','localtime')"; }
  if (periodo === 'mes')    { sql += " AND strftime('%Y-%m',criado_em) = strftime('%Y-%m','now','localtime')"; }
  sql += ' ORDER BY criado_em DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

app.delete('/api/movimentacoes/:id', (req, res) => {
  const mov = db.prepare('SELECT * FROM movimentacoes WHERE id = ?').get(req.params.id);
  if (!mov) return res.status(404).json({ error: 'Não encontrado' });

  const desfazer = db.transaction(() => {
    if (mov.tipo === 'saida')  db.prepare('UPDATE itens SET qt = qt + ? WHERE cod = ?').run(mov.qty, mov.cod);
    if (mov.tipo === 'ajuste') db.prepare('UPDATE itens SET qt = ? WHERE cod = ?').run(mov.anterior_qt, mov.cod);
    db.prepare('DELETE FROM movimentacoes WHERE id = ?').run(mov.id);
  });
  desfazer();

  const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(mov.cod);
  broadcast({ tipo: 'movimentacao_removida', id: mov.id, item });
  res.json({ ok: true });
});

// ── STATS ──────────────────────────────
app.get('/api/stats', (req, res) => {
  const hoje = db.prepare(`SELECT COUNT(*) as n FROM movimentacoes WHERE tipo='saida' AND DATE(criado_em)=DATE('now','localtime')`).get().n;
  const ajustes = db.prepare(`SELECT COUNT(*) as n FROM movimentacoes WHERE tipo='ajuste' AND DATE(criado_em)=DATE('now','localtime')`).get().n;
  const baixo  = db.prepare('SELECT COUNT(*) as n FROM itens WHERE qt > 0 AND qt <= 5').get().n;
  const zero   = db.prepare('SELECT COUNT(*) as n FROM itens WHERE qt = 0').get().n;
  const total  = db.prepare('SELECT COUNT(*) as n FROM itens').get().n;
  const pedidos_pendentes = db.prepare("SELECT COUNT(*) as n FROM pedidos WHERE status='pendente'").get().n;
  res.json({ hoje, ajustes, baixo, zero, total, pedidos_pendentes });
});

// ─────────────────────────────────────────
//  WEBSOCKET — tempo real
// ─────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const clientes = new Set();

wss.on('connection', ws => {
  clientes.add(ws);
  ws.on('close', () => clientes.delete(ws));
  ws.on('error', () => clientes.delete(ws));
  // envia stats ao conectar
  ws.send(JSON.stringify({ tipo: 'conectado', msg: 'Conectado ao servidor de estoque' }));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clientes) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n✓ Servidor rodando em http://localhost:${PORT}`);
  console.log(`  Acesso na rede local: http://SEU_IP:${PORT}\n`);
});
