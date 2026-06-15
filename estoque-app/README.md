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

## Login e usuários

O sistema exige login com usuário e senha.

### Primeiro acesso

Na primeira vez que o sistema sobe, é criado um administrador:
- **Usuário:** `admin`
- **Senha:** `admin123` (ou o valor da variável de ambiente `ADMIN_SENHA`)

No primeiro login, o sistema obriga a trocar essa senha.

> **Dica de segurança:** defina a variável de ambiente `ADMIN_SENHA` no Render/Railway com uma senha forte, em vez de usar a padrão.

### Gerenciar usuários (admin)

O administrador vê o botão **⚙ Usuários** no topo. Lá é possível:
- Criar novos usuários (com nome, login e senha inicial)
- Marcar quem é administrador
- Resetar a senha de alguém (a pessoa troca no próximo acesso)
- Remover usuários

Cada usuário criado é obrigado a trocar a senha no primeiro acesso. As senhas são guardadas com hash (PBKDF2), nunca em texto puro.

---

## Tecnologias

- **Node.js** + **Express** — servidor HTTP
- **better-sqlite3** — banco de dados local (arquivo .db)
- **ws** — WebSocket para atualizações em tempo real
- HTML/CSS/JS puro — frontend sem frameworks

---

## Importação de NF-e (XML)

O sistema lê o XML de notas fiscais de **entrada** (compras) e soma os itens ao estoque automaticamente.

### Como funciona o casamento de itens

Como o código do produto na nota do fornecedor (cProd) nem sempre bate com o código do seu cadastro (Neski), o sistema tenta casar nesta ordem:

1. **Vínculo memorizado** — se você já vinculou aquele produto daquele fornecedor antes, casa sozinho
2. **Referência interna** — se o cProd da nota bate com a "Ref. Interna" do seu cadastro
3. **Descrição** — comparação aproximada pela descrição do produto

### Fluxo de uso

1. Aba **Importar NF-e** → suba o arquivo XML da nota
2. O sistema mostra todos os itens, já casando o que conseguir automaticamente
3. Para os que não casaram, você vincula manualmente buscando no seu cadastro
4. Marque "memorizar" para que da próxima vez aquele item case sozinho
5. Clique em **Confirmar** — as quantidades são somadas ao estoque

A mesma nota não é importada duas vezes por engano (o sistema avisa pela chave de acesso).
