# Mini E-commerce Distribuído — Guia de Execução

Arquitetura de microsserviços com API Gateway, replicação de produtos e heartbeat automático.

```
Cliente → Gateway :3000
              ├── Users          :5001
              ├── Products       :5002  ←→  Products-Replica :5012
              └── Orders         :5003
```

---

## Pré-requisitos

| Modo | Requisito |
|------|-----------|
| Sem Docker | Node.js 18+ e npm |
| Com Docker | Docker 24+ e Docker Compose v2 |

---

## Execução SEM Docker

### 1. Instalar dependências em cada serviço

Abra **cinco terminais** (ou execute em sequência):

```bash
cd entrega/users            && npm install
cd entrega/products         && npm install
cd entrega/products-replica && npm install
cd entrega/orders           && npm install
cd entrega/gateway          && npm install
```

### 2. Configurar variáveis de ambiente (opcional)

Copie o arquivo de exemplo e ajuste se necessário:

```bash
cp entrega/.env.example entrega/.env
```

As variáveis com seus valores padrão:

```
JWT_SECRET=supersecret
INTERNAL_KEY=internalkey123
USERS_PORT=5001
PRODUCTS_PORT=5002
PRODUCTS_REPLICA_PORT=5012
ORDERS_PORT=5003
GATEWAY_PORT=3000
```

### 3. Iniciar os serviços (respeite a ordem)

Cada comando em um terminal separado, a partir da pasta `entrega/`:

```bash
# Terminal 1 — Users
node users/index.js

# Terminal 2 — Products (primária)
REPLICA_URL=http://localhost:5012 node products/index.js

# Terminal 3 — Products Replica
PORT=5012 node products-replica/index.js

# Terminal 4 — Orders
PRODUCTS_URL=http://localhost:5002 node orders/index.js

# Terminal 5 — Gateway (inicia por último)
node gateway/index.js
```

> **Windows (PowerShell):** substitua `VAR=valor node ...` por:
> ```powershell
> $env:REPLICA_URL="http://localhost:5012"; node products/index.js
> ```

---

## Execução COM Docker

```bash
cd entrega
docker-compose up --build
```

Para rodar em segundo plano:

```bash
docker-compose up --build -d
docker-compose logs -f gateway   # acompanha logs do gateway
```

Para parar tudo:

```bash
docker-compose down
```

Os dados são persistidos em volumes Docker nomeados (`users-data`, `products-data`, etc.) e sobrevivem ao `down`. Para apagar os dados também:

```bash
docker-compose down -v
```

---

## Exemplos de Uso com cURL

> Todos os exemplos assumem que o Gateway está em `http://localhost:3000`.
> Substitua pela URL direta do serviço (ex: `http://localhost:5001`) se quiser chamar sem gateway.

### Registrar usuário comum

```bash
curl -s -X POST http://localhost:3000/users/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@email.com", "password": "minhasenha"}'
```

Resposta esperada `201`:
```json
{
  "id": "uuid-aqui",
  "name": "Alice",
  "email": "alice@email.com",
  "role": "user"
}
```

---

### Tornar um usuário admin (desenvolvimento)

**Opção A — via endpoint de dev** (mais fácil):

```bash
# 1. Registre o usuário e copie o "id" da resposta
curl -s -X POST http://localhost:3000/users/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Admin", "email": "admin@email.com", "password": "adminsenha"}'

# 2. Promova para admin usando o id retornado
curl -s -X POST http://localhost:3000/users/make-admin/<ID_DO_USUARIO>
```

**Opção B — editando o JSON diretamente**:

Abra `entrega/users/data/users.json` e troque `"role": "user"` por `"role": "admin"` no registro desejado. A mudança é imediata (sem reiniciar o serviço).

---

### Login e salvar o token

```bash
# Salva o token em variável de ambiente
TOKEN=$(curl -s -X POST http://localhost:3000/users/login \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@email.com", "password": "minhasenha"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo "Token: $TOKEN"
```

> **PowerShell:**
> ```powershell
> $resp = Invoke-RestMethod http://localhost:3000/users/login -Method Post `
>   -ContentType "application/json" `
>   -Body '{"email":"alice@email.com","password":"minhasenha"}'
> $TOKEN = $resp.token
> ```

---

### Criar produto (requer token de admin)

```bash
# Faça login como admin primeiro e salve o ADMIN_TOKEN
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/users/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@email.com", "password": "adminsenha"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -s -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "name": "Notebook Gamer",
    "description": "16GB RAM, RTX 4060",
    "price": 5500,
    "stock": 10
  }'
```

Resposta esperada `201`:
```json
{
  "id": "uuid-do-produto",
  "name": "Notebook Gamer",
  "description": "16GB RAM, RTX 4060",
  "price": 5500,
  "stock": 10
}
```

> Se a réplica estiver indisponível, a resposta virá com o header `X-Replica-Warning: replica sync failed` mas o produto ainda será salvo na primária.

---

### Listar produtos

```bash
# GET sem autenticação — o gateway faz round-robin entre primária e réplica
curl -s http://localhost:3000/products
```

Buscar produto por ID:

```bash
curl -s http://localhost:3000/products/<ID_DO_PRODUTO>
```

---

### Criar pedido (qualquer usuário autenticado)

```bash
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "productId": "<ID_DO_PRODUTO>",
    "quantity": 2
  }'
```

Resposta esperada `201`:
```json
{
  "id": "uuid-do-pedido",
  "userId": "uuid-do-user",
  "productId": "uuid-do-produto",
  "quantity": 2,
  "status": "pending",
  "createdAt": "2026-01-01T12:00:00.000Z"
}
```

---

### Listar pedidos de um usuário

```bash
# Só o próprio usuário (ou admin) pode ver os pedidos
curl -s http://localhost:3000/orders/<USER_ID> \
  -H "Authorization: Bearer $TOKEN"
```

---

### Consultar saúde do gateway e serviços

```bash
curl -s http://localhost:3000/gateway/health | python3 -m json.tool
# ou
curl -s http://localhost:3000/gateway/health | jq .
```

Resposta:
```json
{
  "gateway": "up",
  "services": {
    "users":              { "status": "up", "lastCheck": "..." },
    "products-primary":   { "status": "up", "lastCheck": "..." },
    "products-replica":   { "status": "up", "lastCheck": "..." },
    "orders":             { "status": "up", "lastCheck": "..." }
  }
}
```

---

## Testando o Heartbeat (detecção de falha)

O gateway verifica o `/health` de cada serviço a cada **5 segundos**. Após **2 falhas consecutivas** o serviço é marcado como `"down"` e o gateway para de rotear para ele.

### Passo a passo

**1. Abra o log do gateway em um terminal:**

Sem Docker:
```bash
# O log aparece no terminal onde o gateway está rodando
```

Com Docker:
```bash
docker-compose logs -f gateway
```

**2. Em outro terminal, derrube um serviço:**

Sem Docker — pressione `Ctrl+C` no terminal do serviço, ou:
```bash
# Linux/macOS
kill $(lsof -ti:5012)

# Windows PowerShell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 5012 -State Listen).OwningProcess -Force
```

Com Docker:
```bash
docker-compose stop products-replica
```

**3. Aguarde ~10 segundos e observe no log do gateway:**
```
[FAILURE] products-replica caiu em 2026-01-01T12:00:05.000Z
```

**4. Consulte o health para confirmar:**
```bash
curl -s http://localhost:3000/gateway/health
# "products-replica": { "status": "down", ... }
```

**5. Durante a falha, GET /products ainda funciona** (round-robin usa só a primária):
```bash
curl -s http://localhost:3000/products   # continua respondendo
```

**6. Religue o serviço e veja o RECOVERY:**

Com Docker:
```bash
docker-compose start products-replica
```

Após ~5 segundos no log:
```
[RECOVERY] products-replica voltou em 2026-01-01T12:00:35.000Z
```

---

## Testando a Replicação de Produtos

A escrita é **síncrona**: a primária salva → sincroniza a réplica via `POST /internal/sync` → responde ao cliente.

### Passo a passo

**1. Crie um produto via gateway (escrita vai para a primária):**

```bash
curl -s -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name": "Mouse", "price": 80, "stock": 50}'
```

**2. Verifique o arquivo da primária:**

```bash
cat entrega/products/data/products.json
```

**3. Verifique o arquivo da réplica — deve ter o mesmo produto:**

```bash
cat entrega/products-replica/data/products.json
```

Ambos devem conter o produto com o mesmo `id`, `name`, `price` e `stock`.

**4. Consulte diretamente cada instância:**

```bash
# Primária
curl -s http://localhost:5002/products

# Réplica
curl -s http://localhost:5012/products
```

### Testando falha na sincronização

**1. Derrube a réplica antes de criar o produto.**

**2. Crie o produto e observe o header de aviso:**

```bash
curl -si -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name": "Teclado", "price": 120, "stock": 15}'
```

A resposta virá com:
```
HTTP/1.1 201 Created
X-Replica-Warning: replica sync failed
```

O produto estará salvo na primária, mas **não** na réplica (inconsistência temporária).

**3. Religue a réplica.** Os produtos criados durante a falha não serão sincronizados automaticamente — esta é a diferença entre consistência forte e eventual.

---

## Estrutura de Arquivos

```
entrega/
├── .env.example
├── docker-compose.yml
├── README_execucao.md
├── gateway/
│   ├── index.js            ← Proxy + heartbeat + round-robin
│   └── package.json
├── users/
│   ├── index.js            ← Registro, login, JWT, make-admin
│   ├── middleware/auth.js
│   ├── data/users.json     ← Persistência local
│   └── package.json
├── products/               ← Réplica PRIMÁRIA (porta 5002)
│   ├── index.js
│   ├── middleware/auth.js
│   ├── data/products.json
│   └── package.json
├── products-replica/       ← Réplica SECUNDÁRIA (porta 5012)
│   ├── index.js
│   ├── data/products.json
│   └── package.json
└── orders/
    ├── index.js
    ├── middleware/auth.js
    ├── data/orders.json
    └── package.json
```

---

## Endpoints Resumidos

| Método | Endpoint | Auth | Descrição |
|--------|----------|------|-----------|
| `POST` | `/users/register` | — | Registra novo usuário |
| `POST` | `/users/login` | — | Retorna JWT |
| `GET`  | `/users/:id` | Bearer (próprio ou admin) | Dados do usuário |
| `POST` | `/users/make-admin/:id` | — | ⚠️ Dev only: promove a admin |
| `GET`  | `/products` | — | Lista produtos (round-robin) |
| `GET`  | `/products/:id` | — | Produto por ID |
| `POST` | `/products` | Bearer admin | Cria produto + sincroniza réplica |
| `POST` | `/orders` | Bearer | Cria pedido |
| `GET`  | `/orders/:userId` | Bearer (próprio ou admin) | Lista pedidos do usuário |
| `GET`  | `/gateway/health` | — | Status de todos os serviços |
