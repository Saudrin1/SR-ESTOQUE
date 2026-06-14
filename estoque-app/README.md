# Estoque.ctrl — Sistema de Controle de Estoque

Sistema web em tempo real para os setores de **Estoque** e **Vendas**.

---

## O que o sistema faz

- **Setor de Estoque**: registra saídas, ajusta saldos, vê alertas de estoque baixo, atende pedidos de vendas
- **Setor de Vendas**: consulta estoque disponível, faz solicitações ao estoque, acompanha status dos pedidos
- **Tempo real**: qualquer ação aparece instantaneamente para todos os usuários conectados (via WebSocket)
- **Banco de dados compartilhado**: todos veem e registram os mesmos dados

---

## Como fazer o deploy no Railway (gratuito)

### Passo 1 — Criar conta no GitHub
Acesse https://github.com e crie uma conta gratuita se ainda não tiver.

### Passo 2 — Criar repositório
1. Clique em **New repository**
2. Nome: `estoque-ctrl`
3. Deixe **público** (necessário para o plano gratuito)
4. Clique em **Create repository**

### Passo 3 — Subir os arquivos
Na página do repositório criado, clique em **uploading an existing file** e suba todos os arquivos desta pasta:
```
estoque-ctrl/
├── package.json
├── Procfile
├── .gitignore
├── src/
│   ├── server.js
│   └── itens.json
└── public/
    └── index.html
```

### Passo 4 — Criar conta no Railway
Acesse https://railway.app e clique em **Login with GitHub**.

### Passo 5 — Novo projeto
1. Clique em **New Project**
2. Selecione **Deploy from GitHub repo**
3. Escolha o repositório `estoque-ctrl`
4. Railway detecta automaticamente que é Node.js e faz o deploy

### Passo 6 — Gerar o link público
1. No painel do projeto, clique em **Settings**
2. Em **Networking**, clique em **Generate Domain**
3. Você recebe um link tipo: `https://estoque-ctrl-production.up.railway.app`

### Passo 7 — Compartilhar
Envie esse link para os dois setores. Cada colaborador acessa pelo navegador, escolhe o setor (Estoque ou Vendas) e começa a usar.

---

## Como usar localmente (para testar)

### Pré-requisitos
- Node.js instalado (baixe em https://nodejs.org — versão LTS)

### Passos
```bash
# 1. Instalar dependências
npm install

# 2. Iniciar o servidor
npm start

# 3. Acessar no navegador
# http://localhost:3000
```

Para outros computadores na **mesma rede local**, descubra seu IP e acesse:
```
http://192.168.X.X:3000
```
(Substitua pelo IP do seu computador — veja nas configurações de rede do Windows)

---

## Variáveis de ambiente (opcional)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `DB_PATH` | `./estoque.db` | Caminho do banco SQLite |

---

## Estrutura do projeto

```
src/
  server.js    — servidor Express + WebSocket + SQLite
  itens.json   — dados iniciais do estoque (2176 itens)
public/
  index.html   — frontend completo (Estoque + Vendas)
estoque.db     — banco de dados (criado automaticamente)
```

---

## Tecnologias

- **Node.js** + **Express** — servidor HTTP
- **better-sqlite3** — banco de dados local (arquivo .db)
- **ws** — WebSocket para atualizações em tempo real
- HTML/CSS/JS puro — frontend sem frameworks
