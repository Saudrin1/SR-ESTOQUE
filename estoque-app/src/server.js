'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const crypto    = require('crypto');
const ExcelJS   = require('exceljs');
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
    tipo        TEXT NOT NULL CHECK(tipo IN ('saida','ajuste','entrada')),
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

  -- Vínculos memorizados: código do fornecedor -> código do nosso cadastro
  CREATE TABLE IF NOT EXISTS vinculos_fornecedor (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fornec_cnpj   TEXT NOT NULL,
    fornec_cprod  TEXT NOT NULL,
    cod           TEXT NOT NULL,
    criado_em     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(fornec_cnpj, fornec_cprod)
  );

  -- Histórico de notas importadas (evita importar a mesma nota 2x)
  CREATE TABLE IF NOT EXISTS notas_importadas (
    chave        TEXT PRIMARY KEY,
    numero       TEXT,
    fornec_nome  TEXT,
    fornec_cnpj  TEXT,
    total_itens  INTEGER,
    criado_em    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- Usuários do sistema (login + senha)
  CREATE TABLE IF NOT EXISTS usuarios (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario      TEXT NOT NULL UNIQUE,
    nome         TEXT NOT NULL,
    senha_hash   TEXT NOT NULL,
    salt         TEXT NOT NULL,
    is_admin     INTEGER NOT NULL DEFAULT 0,
    deve_trocar  INTEGER NOT NULL DEFAULT 0,
    criado_em    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- Sessões ativas (token -> usuário)
  CREATE TABLE IF NOT EXISTS sessoes (
    token      TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    criado_em  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- Códigos de barras vinculados a itens do cadastro
  CREATE TABLE IF NOT EXISTS codigos_barras (
    ean        TEXT PRIMARY KEY,
    cod        TEXT NOT NULL,
    criado_em  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// Adiciona coluna 'entrada' ao CHECK de movimentacoes (migração para bancos já existentes)
try {
  const tipoCheck = db.prepare("SELECT sql FROM sqlite_master WHERE name='movimentacoes'").get();
  if (tipoCheck && !tipoCheck.sql.includes("'entrada'")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS movimentacoes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL CHECK(tipo IN ('saida','ajuste','entrada')),
        cod TEXT NOT NULL, desc TEXT NOT NULL, ref TEXT DEFAULT '',
        qty INTEGER, anterior_qt INTEGER, novo_qt INTEGER, diff INTEGER,
        motivo TEXT NOT NULL, pessoa TEXT NOT NULL, os TEXT DEFAULT '',
        obs TEXT DEFAULT '', setor TEXT DEFAULT '',
        criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO movimentacoes_new SELECT * FROM movimentacoes;
      DROP TABLE movimentacoes;
      ALTER TABLE movimentacoes_new RENAME TO movimentacoes;
    `);
    console.log('Migração: tipo "entrada" adicionado a movimentacoes.');
  }
} catch(e) { console.log('Aviso migração:', e.message); }

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
//  AUTENTICAÇÃO — helpers
// ─────────────────────────────────────────
function hashSenha(senha, salt) {
  return crypto.pbkdf2Sync(senha, salt, 100000, 64, 'sha512').toString('hex');
}
function criarUsuario(usuario, nome, senha, isAdmin = 0, deveTrocar = 0) {
  const salt = crypto.randomBytes(16).toString('hex');
  const senha_hash = hashSenha(senha, salt);
  return db.prepare(`INSERT INTO usuarios (usuario, nome, senha_hash, salt, is_admin, deve_trocar) VALUES (?,?,?,?,?,?)`)
    .run(usuario.toLowerCase().trim(), nome.trim(), senha_hash, salt, isAdmin ? 1 : 0, deveTrocar ? 1 : 0);
}
function verificarSenha(user, senha) {
  return hashSenha(senha, user.salt) === user.senha_hash;
}
function gerarToken() {
  return crypto.randomBytes(32).toString('hex');
}
function usuarioPorToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT usuario_id FROM sessoes WHERE token = ?').get(token);
  if (!s) return null;
  return db.prepare('SELECT id, usuario, nome, is_admin, deve_trocar FROM usuarios WHERE id = ?').get(s.usuario_id);
}

// Seed do admin inicial (só se não houver nenhum usuário)
const nUsuarios = db.prepare('SELECT COUNT(*) as n FROM usuarios').get().n;
if (nUsuarios === 0) {
  const SENHA_ADMIN_INICIAL = process.env.ADMIN_SENHA || 'admin123';
  criarUsuario('admin', 'Administrador', SENHA_ADMIN_INICIAL, 1, 1);
  console.log('\n========================================');
  console.log('  USUARIO ADMIN CRIADO');
  console.log('  Usuario: admin');
  console.log(`  Senha:   ${SENHA_ADMIN_INICIAL}`);
  console.log('  (troque a senha no primeiro acesso)');
  console.log('========================================\n');
}

// Middleware de autenticação
function autenticar(req, res, next) {
  const token = req.headers['x-token'] || (req.headers.authorization || '').replace('Bearer ', '');
  const user = usuarioPorToken(token);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  req.user = user;
  next();
}
function somenteAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  next();
}

// ─────────────────────────────────────────
//  EXPRESS
// ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── AUTH ───────────────────────────────
app.post('/api/login', (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) return res.status(400).json({ error: 'Informe usuário e senha' });
  const user = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(usuario.toLowerCase().trim());
  if (!user || !verificarSenha(user, senha)) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  const token = gerarToken();
  db.prepare('INSERT INTO sessoes (token, usuario_id) VALUES (?,?)').run(token, user.id);
  res.json({ ok: true, token, nome: user.nome, usuario: user.usuario, is_admin: !!user.is_admin, deve_trocar: !!user.deve_trocar });
});

app.post('/api/logout', autenticar, (req, res) => {
  const token = req.headers['x-token'] || (req.headers.authorization || '').replace('Bearer ', '');
  db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/me', autenticar, (req, res) => {
  res.json({ nome: req.user.nome, usuario: req.user.usuario, is_admin: !!req.user.is_admin, deve_trocar: !!req.user.deve_trocar });
});

// Trocar a própria senha
app.post('/api/trocar-senha', autenticar, (req, res) => {
  const { senhaAtual, senhaNova } = req.body;
  if (!senhaNova || senhaNova.length < 4) return res.status(400).json({ error: 'A nova senha deve ter ao menos 4 caracteres' });
  const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  if (!verificarSenha(user, senhaAtual)) return res.status(401).json({ error: 'Senha atual incorreta' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE usuarios SET senha_hash = ?, salt = ?, deve_trocar = 0 WHERE id = ?')
    .run(hashSenha(senhaNova, salt), salt, req.user.id);
  res.json({ ok: true });
});

// ── ADMIN: gestão de usuários ──────────
app.get('/api/usuarios', autenticar, somenteAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, usuario, nome, is_admin, deve_trocar, criado_em FROM usuarios ORDER BY nome').all());
});

app.post('/api/usuarios', autenticar, somenteAdmin, (req, res) => {
  const { usuario, nome, senha, is_admin } = req.body;
  if (!usuario || !nome || !senha) return res.status(400).json({ error: 'Preencha usuário, nome e senha' });
  if (senha.length < 4) return res.status(400).json({ error: 'A senha deve ter ao menos 4 caracteres' });
  try {
    const info = criarUsuario(usuario, nome, senha, is_admin ? 1 : 0, 1);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(400).json({ error: 'Esse nome de usuário já existe' });
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

app.post('/api/usuarios/:id/resetar-senha', autenticar, somenteAdmin, (req, res) => {
  const { senha } = req.body;
  if (!senha || senha.length < 4) return res.status(400).json({ error: 'A senha deve ter ao menos 4 caracteres' });
  const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE usuarios SET senha_hash = ?, salt = ?, deve_trocar = 1 WHERE id = ?')
    .run(hashSenha(senha, salt), salt, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/usuarios/:id', autenticar, somenteAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.usuario === 'admin') return res.status(400).json({ error: 'O usuário admin não pode ser removido' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Você não pode remover a si mesmo' });
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(user.id);
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

// ── ITENS ──────────────────────────────
app.get('/api/itens', autenticar, (req, res) => {
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

app.get('/api/itens/:cod', autenticar, (req, res) => {
  const row = db.prepare('SELECT * FROM itens WHERE cod = ?').get(req.params.cod);
  if (!row) return res.status(404).json({ error: 'Item não encontrado' });
  res.json(row);
});

// ── SAÍDAS ─────────────────────────────
app.post('/api/saidas', autenticar, (req, res) => {
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
app.post('/api/ajustes', autenticar, (req, res) => {
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
app.get('/api/pedidos', autenticar, (req, res) => {
  const { status } = req.query;
  let rows;
  if (status) {
    rows = db.prepare('SELECT * FROM pedidos WHERE status = ? ORDER BY criado_em DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM pedidos ORDER BY criado_em DESC LIMIT 200').all();
  }
  res.json(rows);
});

app.post('/api/pedidos', autenticar, (req, res) => {
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

app.patch('/api/pedidos/:id', autenticar, (req, res) => {
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
app.get('/api/movimentacoes', autenticar, (req, res) => {
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

app.delete('/api/movimentacoes/:id', autenticar, (req, res) => {
  const mov = db.prepare('SELECT * FROM movimentacoes WHERE id = ?').get(req.params.id);
  if (!mov) return res.status(404).json({ error: 'Não encontrado' });

  const desfazer = db.transaction(() => {
    if (mov.tipo === 'saida')   db.prepare('UPDATE itens SET qt = qt + ? WHERE cod = ?').run(mov.qty, mov.cod);
    if (mov.tipo === 'entrada') db.prepare('UPDATE itens SET qt = qt - ? WHERE cod = ?').run(mov.qty, mov.cod);
    if (mov.tipo === 'ajuste')  db.prepare('UPDATE itens SET qt = ? WHERE cod = ?').run(mov.anterior_qt, mov.cod);
    db.prepare('DELETE FROM movimentacoes WHERE id = ?').run(mov.id);
  });
  desfazer();

  const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(mov.cod);
  broadcast({ tipo: 'movimentacao_removida', id: mov.id, item });
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  IMPORTAÇÃO DE NF-e (XML)
// ─────────────────────────────────────────

// Parser leve de NF-e: extrai emitente e itens do XML.
// Funciona com o layout 4.00 da SEFAZ (padrão nacional).
function parseNFe(xml) {
  const limpo = xml.replace(/\r?\n/g, ' ').replace(/>\s+</g, '><');

  const tag = (str, t) => {
    const m = str.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i'));
    return m ? m[1].trim() : '';
  };

  // Chave de acesso (44 dígitos) no atributo Id de <infNFe Id="NFe...">
  let chave = '';
  const idMatch = limpo.match(/<infNFe[^>]*Id="NFe(\d{44})"/i);
  if (idMatch) chave = idMatch[1];

  const numero = tag(limpo, 'nNF');

  // Emitente (fornecedor)
  let emitBlock = '';
  const emitM = limpo.match(/<emit>([\s\S]*?)<\/emit>/i);
  if (emitM) emitBlock = emitM[1];
  const fornecNome = tag(emitBlock, 'xNome');
  const fornecCnpj = tag(emitBlock, 'CNPJ') || tag(emitBlock, 'CPF');

  // Itens: cada <det nItem="N"> ... <prod> ... </prod> </det>
  const itens = [];
  const detRegex = /<det[^>]*>([\s\S]*?)<\/det>/gi;
  let m;
  while ((m = detRegex.exec(limpo)) !== null) {
    const det = m[1];
    const prodM = det.match(/<prod>([\s\S]*?)<\/prod>/i);
    if (!prodM) continue;
    const prod = prodM[1];
    const cProd  = tag(prod, 'cProd');
    const cEAN   = tag(prod, 'cEAN');
    const xProd  = tag(prod, 'xProd');
    const qComM  = tag(prod, 'qCom');
    const uCom   = tag(prod, 'uCom');
    const vUnM   = tag(prod, 'vUnCom');
    const qtd = Math.round(parseFloat((qComM || '0').replace(',', '.')) || 0);
    if (!cProd && !xProd) continue;
    itens.push({
      cProd,
      cEAN: (cEAN && cEAN.toUpperCase() !== 'SEM GTIN') ? cEAN : '',
      xProd,
      unidade: uCom,
      qtd,
      valorUnit: parseFloat((vUnM || '0').replace(',', '.')) || 0
    });
  }

  return { chave, numero, fornecNome, fornecCnpj, itens };
}

// Normaliza texto para comparação
function norm(s) {
  return (s || '').toString().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

// Tenta casar um item da nota com o cadastro
function casarItem(itemNota, fornecCnpj) {
  // 1) Vínculo memorizado (fornecedor + cProd)
  if (fornecCnpj && itemNota.cProd) {
    const v = db.prepare('SELECT cod FROM vinculos_fornecedor WHERE fornec_cnpj = ? AND fornec_cprod = ?')
      .get(fornecCnpj, itemNota.cProd);
    if (v) {
      const it = db.prepare('SELECT * FROM itens WHERE cod = ?').get(v.cod);
      if (it) return { item: it, metodo: 'memorizado', confianca: 'alta' };
    }
  }
  // 2) Casamento por referência interna
  if (itemNota.cProd) {
    const porRef = db.prepare('SELECT * FROM itens WHERE ref = ?').get(itemNota.cProd);
    if (porRef) return { item: porRef, metodo: 'referencia', confianca: 'alta' };
    const todos = db.prepare('SELECT * FROM itens').all();
    const alvo = norm(itemNota.cProd);
    const matchRef = todos.find(it => it.ref && norm(it.ref) === alvo);
    if (matchRef) return { item: matchRef, metodo: 'referencia', confianca: 'media' };
  }
  // 3) Casamento por descrição aproximada
  if (itemNota.xProd) {
    const todos = db.prepare('SELECT * FROM itens').all();
    const alvoDesc = norm(itemNota.xProd);
    let match = todos.find(it => norm(it.desc) === alvoDesc);
    if (match) return { item: match, metodo: 'descricao', confianca: 'media' };
    if (itemNota.cProd && itemNota.cProd.length >= 4) {
      const alvoCod = norm(itemNota.cProd);
      match = todos.find(it => norm(it.desc).includes(alvoCod) || (it.ref && norm(it.ref).includes(alvoCod)));
      if (match) return { item: match, metodo: 'descricao', confianca: 'baixa' };
    }
  }
  return { item: null, metodo: null, confianca: null };
}

// Analisar XML (pré-visualização, não aplica nada)
app.post('/api/nfe/analisar', autenticar, (req, res) => {
  const { xml } = req.body;
  if (!xml || typeof xml !== 'string') return res.status(400).json({ error: 'XML não enviado' });

  let nfe;
  try { nfe = parseNFe(xml); }
  catch (e) { return res.status(400).json({ error: 'Não foi possível ler o XML. Verifique se é uma NF-e válida.' }); }

  if (!nfe.itens.length) return res.status(400).json({ error: 'Nenhum item encontrado no XML.' });

  let jaImportada = false;
  if (nfe.chave) jaImportada = !!db.prepare('SELECT chave FROM notas_importadas WHERE chave = ?').get(nfe.chave);

  const itensAnalisados = nfe.itens.map((it, idx) => {
    const match = casarItem(it, nfe.fornecCnpj);
    return {
      idx,
      nota: it,
      casado: !!match.item,
      sugestao: match.item ? {
        cod: match.item.cod, desc: match.item.desc, ref: match.item.ref,
        qtAtual: match.item.qt, metodo: match.metodo, confianca: match.confianca
      } : null
    };
  });

  res.json({
    nota: { chave: nfe.chave, numero: nfe.numero, fornecNome: nfe.fornecNome, fornecCnpj: nfe.fornecCnpj },
    jaImportada,
    itens: itensAnalisados
  });
});

// Confirmar importação (aplica as entradas no estoque)
app.post('/api/nfe/confirmar', autenticar, (req, res) => {
  const { nota, itens, pessoa } = req.body;
  if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ error: 'Nenhum item para importar' });
  if (!pessoa) return res.status(400).json({ error: 'Informe o responsável' });

  const resultado = { aplicados: 0, ignorados: 0, erros: [] };

  const aplicar = db.transaction(() => {
    for (const it of itens) {
      if (!it.cod) { resultado.ignorados++; continue; }
      const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(it.cod);
      if (!item) { resultado.erros.push(`Item ${it.cod} não encontrado`); continue; }
      const qtd = parseInt(it.qtd) || 0;
      if (qtd <= 0) { resultado.ignorados++; continue; }

      const anterior = item.qt;
      const novo = anterior + qtd;
      db.prepare('UPDATE itens SET qt = ? WHERE cod = ?').run(novo, it.cod);
      db.prepare(`
        INSERT INTO movimentacoes (tipo, cod, desc, ref, qty, anterior_qt, novo_qt, diff, motivo, pessoa, os, obs, setor)
        VALUES ('entrada',?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(it.cod, item.desc, item.ref, qtd, anterior, novo, qtd, 'nfe',
             pessoa, nota?.numero ? `NF ${nota.numero}` : '',
             it.xProd ? `NF-e: ${it.xProd.substring(0,60)}` : 'Importado de NF-e', 'estoque');

      if (it.memorizar && nota?.fornecCnpj && it.cProd) {
        try {
          db.prepare(`INSERT OR REPLACE INTO vinculos_fornecedor (fornec_cnpj, fornec_cprod, cod) VALUES (?,?,?)`)
            .run(nota.fornecCnpj, it.cProd, it.cod);
        } catch(e) {}
      }
      // Salva o código de barras (EAN) do item, se a nota trouxe um válido
      if (it.cEAN && String(it.cEAN).trim()) {
        try {
          db.prepare(`INSERT OR IGNORE INTO codigos_barras (ean, cod) VALUES (?,?)`)
            .run(String(it.cEAN).trim(), it.cod);
        } catch(e) {}
      }
      resultado.aplicados++;
    }

    if (nota?.chave) {
      try {
        db.prepare(`INSERT OR IGNORE INTO notas_importadas (chave, numero, fornec_nome, fornec_cnpj, total_itens) VALUES (?,?,?,?,?)`)
          .run(nota.chave, nota.numero || '', nota.fornecNome || '', nota.fornecCnpj || '', resultado.aplicados);
      } catch(e) {}
    }
  });

  aplicar();
  broadcast({ tipo: 'nfe_importada', resultado, nota });
  res.json({ ok: true, resultado });
});

// Listar notas já importadas
app.get('/api/nfe/historico', autenticar, (req, res) => {
  res.json(db.prepare('SELECT * FROM notas_importadas ORDER BY criado_em DESC LIMIT 100').all());
});

// ─────────────────────────────────────────
//  CÓDIGO DE BARRAS — leitura rápida
// ─────────────────────────────────────────

// Consulta um código de barras: retorna o item vinculado (ou null se desconhecido)
app.get('/api/barras/:ean', autenticar, (req, res) => {
  const ean = String(req.params.ean).trim();
  const vinc = db.prepare('SELECT cod FROM codigos_barras WHERE ean = ?').get(ean);
  if (!vinc) return res.json({ vinculado: false, ean });
  const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(vinc.cod);
  if (!item) return res.json({ vinculado: false, ean });
  res.json({ vinculado: true, ean, item });
});

// Escaneia e dá baixa de 1 unidade (modo rápido). Se o EAN não estiver
// vinculado, retorna vinculado:false e NÃO baixa nada.
app.post('/api/barras/scan', autenticar, (req, res) => {
  const ean = String(req.body.ean || '').trim();
  if (!ean) return res.status(400).json({ error: 'Código de barras vazio' });

  const vinc = db.prepare('SELECT cod FROM codigos_barras WHERE ean = ?').get(ean);
  if (!vinc) return res.json({ vinculado: false, ean });

  const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(vinc.cod);
  if (!item) return res.json({ vinculado: false, ean });
  if (item.qt <= 0) return res.status(400).json({ error: 'Estoque zerado', item, vinculado: true, semEstoque: true });

  const registrar = db.transaction(() => {
    db.prepare('UPDATE itens SET qt = qt - 1 WHERE cod = ?').run(item.cod);
    const info = db.prepare(`
      INSERT INTO movimentacoes (tipo, cod, desc, ref, qty, anterior_qt, novo_qt, diff, motivo, pessoa, os, obs, setor)
      VALUES ('saida',?,?,?,1,?,?,-1,'venda',?,'','Leitura de código de barras','estoque')
    `).run(item.cod, item.desc, item.ref, item.qt, item.qt - 1, req.user.nome);
    return db.prepare('SELECT * FROM movimentacoes WHERE id = ?').get(info.lastInsertRowid);
  });

  const mov = registrar();
  const itemAtualizado = db.prepare('SELECT * FROM itens WHERE cod = ?').get(item.cod);
  broadcast({ tipo: 'nova_saida', mov, item: itemAtualizado });
  res.json({ vinculado: true, ok: true, mov, item: itemAtualizado });
});

// Vincula um código de barras a um item do cadastro (e opcionalmente baixa 1)
app.post('/api/barras/vincular', autenticar, (req, res) => {
  const ean = String(req.body.ean || '').trim();
  const cod = String(req.body.cod || '').trim();
  const baixar = !!req.body.baixar;
  if (!ean || !cod) return res.status(400).json({ error: 'EAN e item são obrigatórios' });

  const item = db.prepare('SELECT * FROM itens WHERE cod = ?').get(cod);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });

  db.prepare('INSERT OR REPLACE INTO codigos_barras (ean, cod) VALUES (?,?)').run(ean, cod);

  let mov = null, itemAtualizado = item;
  if (baixar && item.qt > 0) {
    const registrar = db.transaction(() => {
      db.prepare('UPDATE itens SET qt = qt - 1 WHERE cod = ?').run(item.cod);
      const info = db.prepare(`
        INSERT INTO movimentacoes (tipo, cod, desc, ref, qty, anterior_qt, novo_qt, diff, motivo, pessoa, os, obs, setor)
        VALUES ('saida',?,?,?,1,?,?,-1,'venda',?,'','Leitura de código de barras','estoque')
      `).run(item.cod, item.desc, item.ref, item.qt, item.qt - 1, req.user.nome);
      return db.prepare('SELECT * FROM movimentacoes WHERE id = ?').get(info.lastInsertRowid);
    });
    mov = registrar();
    itemAtualizado = db.prepare('SELECT * FROM itens WHERE cod = ?').get(item.cod);
    broadcast({ tipo: 'nova_saida', mov, item: itemAtualizado });
  }
  res.json({ ok: true, item: itemAtualizado, mov });
});

// Total de códigos de barras já cadastrados
app.get('/api/barras/stats/total', autenticar, (req, res) => {
  const n = db.prepare('SELECT COUNT(*) as n FROM codigos_barras').get().n;
  res.json({ total: n });
});

// ─────────────────────────────────────────
//  BACKUP — Exportar / Importar .xlsx
// ─────────────────────────────────────────

// Exportar: gera um .xlsx com abas "Estoque", "Movimentacoes" e "CodigosBarras"
app.get('/api/backup/exportar', autenticar, somenteAdmin, async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Estoque.ctrl';
    wb.created = new Date();

    const wsEst = wb.addWorksheet('Estoque');
    wsEst.columns = [
      { header: 'Código',       key: 'cod',  width: 12 },
      { header: 'Descrição',    key: 'desc', width: 55 },
      { header: 'Ref. Interna', key: 'ref',  width: 20 },
      { header: 'Estoque',      key: 'qt',   width: 12 }
    ];
    const itens = db.prepare('SELECT cod, desc, ref, qt FROM itens ORDER BY cod').all();
    itens.forEach(i => wsEst.addRow(i));

    const wsMov = wb.addWorksheet('Movimentacoes');
    wsMov.columns = [
      { header: 'tipo', key: 'tipo', width: 10 },
      { header: 'cod', key: 'cod', width: 12 },
      { header: 'desc', key: 'desc', width: 45 },
      { header: 'ref', key: 'ref', width: 18 },
      { header: 'qty', key: 'qty', width: 8 },
      { header: 'anterior_qt', key: 'anterior_qt', width: 12 },
      { header: 'novo_qt', key: 'novo_qt', width: 10 },
      { header: 'diff', key: 'diff', width: 8 },
      { header: 'motivo', key: 'motivo', width: 12 },
      { header: 'pessoa', key: 'pessoa', width: 18 },
      { header: 'os', key: 'os', width: 14 },
      { header: 'obs', key: 'obs', width: 35 },
      { header: 'setor', key: 'setor', width: 10 },
      { header: 'criado_em', key: 'criado_em', width: 20 }
    ];
    const movs = db.prepare('SELECT tipo,cod,desc,ref,qty,anterior_qt,novo_qt,diff,motivo,pessoa,os,obs,setor,criado_em FROM movimentacoes ORDER BY id').all();
    movs.forEach(m => wsMov.addRow(m));

    const wsBar = wb.addWorksheet('CodigosBarras');
    wsBar.columns = [
      { header: 'ean', key: 'ean', width: 20 },
      { header: 'cod', key: 'cod', width: 12 }
    ];
    const barras = db.prepare('SELECT ean, cod FROM codigos_barras ORDER BY ean').all();
    barras.forEach(b => wsBar.addRow(b));

    [wsEst, wsMov, wsBar].forEach(ws => {
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1C20' } };
    });

    const dataStr = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="backup_estoque_' + dataStr + '.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: 'Erro ao gerar o backup: ' + e.message });
  }
});

// Importar: recebe o .xlsx (base64) e RESTAURA tudo (substitui o conteúdo)
app.post('/api/backup/importar', autenticar, somenteAdmin, async (req, res) => {
  const { arquivo } = req.body;
  if (!arquivo) return res.status(400).json({ error: 'Arquivo não enviado' });

  try {
    const buffer = Buffer.from(arquivo, 'base64');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const wsEst = wb.getWorksheet('Estoque');
    if (!wsEst) return res.status(400).json({ error: 'O arquivo não tem a aba "Estoque". Use um arquivo gerado pela exportação.' });

    const novosItens = [];
    wsEst.eachRow((row, n) => {
      if (n === 1) return;
      const cod = row.getCell(1).value;
      const desc = row.getCell(2).value;
      const ref = row.getCell(3).value;
      const qt = row.getCell(4).value;
      if (cod === null || cod === undefined || cod === '') return;
      novosItens.push({
        cod: String(cod).trim(),
        desc: desc != null ? String(desc).trim() : '',
        ref: ref != null ? String(ref).trim() : '',
        qt: parseInt(qt) || 0
      });
    });

    if (!novosItens.length) return res.status(400).json({ error: 'Nenhum item válido encontrado na aba Estoque.' });

    const wsMov = wb.getWorksheet('Movimentacoes') || wb.getWorksheet('Movimentações');
    const novasMovs = [];
    if (wsMov) {
      wsMov.eachRow((row, n) => {
        if (n === 1) return;
        const tipo = row.getCell(1).value;
        if (!tipo) return;
        novasMovs.push({
          tipo: String(tipo).trim(),
          cod: row.getCell(2).value != null ? String(row.getCell(2).value).trim() : '',
          desc: row.getCell(3).value != null ? String(row.getCell(3).value).trim() : '',
          ref: row.getCell(4).value != null ? String(row.getCell(4).value).trim() : '',
          qty: parseInt(row.getCell(5).value) || 0,
          anterior_qt: row.getCell(6).value != null ? parseInt(row.getCell(6).value) : null,
          novo_qt: row.getCell(7).value != null ? parseInt(row.getCell(7).value) : null,
          diff: row.getCell(8).value != null ? parseInt(row.getCell(8).value) : null,
          motivo: row.getCell(9).value != null ? String(row.getCell(9).value).trim() : 'outros',
          pessoa: row.getCell(10).value != null ? String(row.getCell(10).value).trim() : '',
          os: row.getCell(11).value != null ? String(row.getCell(11).value).trim() : '',
          obs: row.getCell(12).value != null ? String(row.getCell(12).value).trim() : '',
          setor: row.getCell(13).value != null ? String(row.getCell(13).value).trim() : '',
          criado_em: row.getCell(14).value != null ? String(row.getCell(14).value).trim() : null
        });
      });
    }

    const wsBar = wb.getWorksheet('CodigosBarras');
    const novasBarras = [];
    if (wsBar) {
      wsBar.eachRow((row, n) => {
        if (n === 1) return;
        const ean = row.getCell(1).value;
        const cod = row.getCell(2).value;
        if (!ean || !cod) return;
        novasBarras.push({ ean: String(ean).trim(), cod: String(cod).trim() });
      });
    }

    const restaurar = db.transaction(() => {
      db.prepare('DELETE FROM itens').run();
      const insItem = db.prepare('INSERT OR REPLACE INTO itens (cod, desc, ref, qt) VALUES (?,?,?,?)');
      for (const i of novosItens) insItem.run(i.cod, i.desc, i.ref, i.qt);

      if (wsMov) {
        db.prepare('DELETE FROM movimentacoes').run();
        const insMov = db.prepare("INSERT INTO movimentacoes (tipo,cod,desc,ref,qty,anterior_qt,novo_qt,diff,motivo,pessoa,os,obs,setor,criado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')))");
        for (const m of novasMovs) {
          insMov.run(m.tipo,m.cod,m.desc,m.ref,m.qty,m.anterior_qt,m.novo_qt,m.diff,m.motivo,m.pessoa,m.os,m.obs,m.setor,m.criado_em);
        }
      }

      if (wsBar) {
        db.prepare('DELETE FROM codigos_barras').run();
        const insBar = db.prepare('INSERT OR REPLACE INTO codigos_barras (ean, cod) VALUES (?,?)');
        for (const b of novasBarras) insBar.run(b.ean, b.cod);
      }
    });
    restaurar();

    broadcast({ tipo: 'backup_importado' });
    res.json({ ok: true, itens: novosItens.length, movs: novasMovs.length, barras: novasBarras.length });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao importar: ' + e.message });
  }
});

// ── STATS ──────────────────────────────
app.get('/api/stats', autenticar, (req, res) => {
  const hoje = db.prepare(`SELECT COUNT(*) as n FROM movimentacoes WHERE tipo='saida' AND DATE(criado_em)=DATE('now','localtime')`).get().n;
  const ajustes = db.prepare(`SELECT COUNT(*) as n FROM movimentacoes WHERE tipo='ajuste' AND DATE(criado_em)=DATE('now','localtime')`).get().n;
  const entradas = db.prepare(`SELECT COUNT(*) as n FROM movimentacoes WHERE tipo='entrada' AND DATE(criado_em)=DATE('now','localtime')`).get().n;
  const baixo  = db.prepare('SELECT COUNT(*) as n FROM itens WHERE qt > 0 AND qt <= 5').get().n;
  const zero   = db.prepare('SELECT COUNT(*) as n FROM itens WHERE qt = 0').get().n;
  const total  = db.prepare('SELECT COUNT(*) as n FROM itens').get().n;
  const pedidos_pendentes = db.prepare("SELECT COUNT(*) as n FROM pedidos WHERE status='pendente'").get().n;
  res.json({ hoje, ajustes, entradas, baixo, zero, total, pedidos_pendentes });
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
