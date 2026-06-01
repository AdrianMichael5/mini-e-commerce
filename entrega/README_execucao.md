# Mini E-commerce Distribuído — Guia de Execução

Arquitetura de microsserviços com API Gateway, replicação de produtos e heartbeat automático.

```
Você (navegador/terminal)
        │
        ▼
   Gateway :3000        ← único ponto de entrada
        │
        ├──► Users          :5001   (cadastro e login)
        ├──► Products       :5002   (catálogo — instância primária)
        │         └──sync──► Products-Replica :5012  (cópia do catálogo)
        └──► Orders         :5003   (pedidos)
```

Toda a comunicação interna usa **HTTPS** com certificados automáticos em `certs/`.

---

## Pré-requisitos

- **Docker Desktop** instalado e aberto
- **VS Code** com terminal integrado em **Git Bash**

> Para abrir o terminal Git Bash no VS Code:
> pressione `` Ctrl + ` ``, clique na seta `∨` ao lado do `+` e selecione **Git Bash**.
> Os comandos abaixo **não funcionam no PowerShell** — use Git Bash.

---

## 1. Subir o projeto

No terminal Git Bash, dentro da pasta `entrega/`:

```bash
cd entrega
docker compose up -d
```

Aguarde aparecer `Started` para todos os 5 containers.
O `npm install` roda automaticamente dentro de cada container — espere ~30 segundos.

**Verifique se está tudo funcionando:**

```bash
curl -sk https://localhost:3000/gateway/health
```

Resposta esperada — todos os serviços com `"status": "up"`:

```json
{
  "gateway": "up",
  "services": {
    "users":             { "status": "up", "lastCheck": "..." },
    "products-primary":  { "status": "up", "lastCheck": "..." },
    "products-replica":  { "status": "up", "lastCheck": "..." },
    "orders":            { "status": "up", "lastCheck": "..." }
  }
}
```

Se algum serviço aparecer como `"down"`, aguarde mais 15 segundos e tente de novo.

---

## 2. Dashboard de monitoramento

Abra o navegador e acesse:

```
https://localhost:3000/dashboard
```

> **Importante:** acesse esse endereço digitando na barra de URL do navegador.
> Não abra o arquivo `dashboard.html` pelo VS Code ou pelo explorador de arquivos — assim não funciona.

O navegador vai exibir um aviso de certificado. Clique em **Avançado → Continuar para localhost**.
O dashboard exibe os cards de status de cada serviço e atualiza automaticamente a cada 5 segundos.

---

## 3. Fluxo completo de teste

Cole os comandos abaixo **em sequência** no terminal Git Bash.

### 3.1 Registrar usuário

```bash
curl -sk -X POST https://localhost:3000/users/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@email.com","password":"minhasenha"}'
```

Resposta esperada:
```json
{"id":"xxxx","name":"Alice","email":"alice@email.com","role":"user"}
```

Copie o valor do `id` — você vai usá-lo no próximo passo.

---

### 3.2 Promover para admin

Substitua `<ID>` pelo id que você copiou:

```bash
curl -sk -X POST https://localhost:3000/users/make-admin/<ID>
```

Resposta esperada:
```json
{"message":"Papel atualizado para admin","user":{"role":"admin",...}}
```

---

### 3.3 Login e salvar o token

```bash
TOKEN=$(curl -sk -X POST https://localhost:3000/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@email.com","password":"minhasenha"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo "Token: $TOKEN"
```

Deve aparecer `Token: eyJhbG...` (uma string longa). Se aparecer vazio, refaça o login.

---

### 3.4 Criar produto (exige admin)

```bash
PRODUTO=$(curl -sk -X POST https://localhost:3000/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Notebook","description":"Para estudo","price":2500,"stock":10}')

echo $PRODUTO
PROD_ID=$(echo $PRODUTO | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "ID do produto: $PROD_ID"
```

Resposta esperada:
```json
{"id":"xxxx","name":"Notebook","description":"Para estudo","price":2500,"stock":10}
```

---

### 3.5 Verificar replicação

O produto deve aparecer igual nos dois arquivos:

```bash
echo "=== Primária ===" && docker compose exec products cat /app/data/products.json
echo "=== Réplica ===" && docker compose exec products-replica cat /app/data/products.json
```

Os dois devem conter o mesmo produto com o mesmo `id`.

---

### 3.6 Listar produtos

```bash
curl -sk https://localhost:3000/products
```

A cada chamada o gateway alterna entre primária e réplica (round-robin). Para ver isso nos logs:

```bash
docker compose logs gateway | grep round-robin
```

---

### 3.7 Criar pedido

```bash
curl -sk -X POST https://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"productId\":\"$PROD_ID\",\"quantity\":2}"
```

Resposta esperada:
```json
{"id":"xxxx","userId":"...","productId":"...","quantity":2,"status":"pending","createdAt":"..."}
```

---

### 3.8 Listar pedidos do usuário

Substitua `<USER_ID>` pelo id do passo 3.1:

```bash
curl -sk https://localhost:3000/orders/<USER_ID> \
  -H "Authorization: Bearer $TOKEN"
```

Deve retornar o pedido criado no passo anterior.

---

## 4. Testando o Heartbeat (detecção de falha)

O gateway verifica cada serviço a cada **5 segundos**. Após **2 falhas consecutivas** marca o serviço como `down` e retorna `503` para quem tentar acessá-lo.

**1. Abra o log do gateway** em um terminal separado:

```bash
docker compose logs -f gateway
```

**2. Em outro terminal, derrube a réplica:**

```bash
docker compose stop products-replica
```

**3. Aguarde ~10 segundos.** No log aparece:
```
[FAILURE] products-replica marcado como DOWN em ...
```

No dashboard o card da réplica fica vermelho.

**4. Confirme via health:**

```bash
curl -sk https://localhost:3000/gateway/health
```

**5. Leitura de produtos ainda funciona** (gateway usa só a primária):

```bash
curl -sk https://localhost:3000/products
```

**6. Religue a réplica:**

```bash
docker compose start products-replica
```

Após ~5 segundos no log aparece:
```
[RECOVERY] products-replica voltou ao ar em ...
```

No dashboard o card fica verde novamente.

---

## 5. Testando falha na sincronização

**1. Derrube a réplica:**

```bash
docker compose stop products-replica
```

**2. Crie um produto e observe o header de aviso:**

```bash
curl -ski -X POST https://localhost:3000/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Teclado","price":120,"stock":15}'
```

A resposta virá com o header:
```
X-Replica-Warning: replica sync failed
```

O produto é salvo na primária, mas **não** na réplica — inconsistência temporária.

**3. Religue a réplica.** Os produtos criados durante a falha não são sincronizados automaticamente.

```bash
docker compose start products-replica
```

---

## 6. Parar o projeto

```bash
docker compose down
```

Os dados sobrevivem ao `down` (ficam nos volumes Docker). Para apagar tudo:

```bash
docker compose down -v
```

---

## Estrutura de Arquivos

```
entrega/
├── .env.example
├── docker-compose.yml
├── README_execucao.md
├── certs/                      ← Certificados TLS
│   ├── ca.crt                  ← CA interna
│   ├── ca.key
│   ├── service.crt             ← Cert compartilhado entre serviços
│   └── service.key
├── gateway/
│   ├── index.js                ← Proxy + heartbeat + round-robin + TLS
│   ├── dashboard.html          ← Dashboard de monitoramento
│   └── package.json
├── users/
│   ├── index.js                ← Cadastro, login, JWT
│   ├── middleware/auth.js
│   ├── data/users.json
│   └── package.json
├── products/                   ← Instância PRIMÁRIA (porta 5002)
│   ├── index.js
│   ├── middleware/auth.js
│   ├── data/products.json
│   └── package.json
├── products-replica/           ← Instância SECUNDÁRIA (porta 5012)
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

Todos os endpoints passam pelo gateway em `https://localhost:3000`.

| Método | Endpoint | Auth | Descrição |
|--------|----------|------|-----------|
| `POST` | `/users/register` | — | Registra novo usuário |
| `POST` | `/users/login` | — | Retorna JWT |
| `GET`  | `/users/:id` | Bearer (próprio ou admin) | Dados do usuário |
| `POST` | `/users/make-admin/:id` | — | Dev only: promove a admin |
| `GET`  | `/products` | — | Lista produtos (round-robin entre instâncias) |
| `GET`  | `/products/:id` | — | Produto por ID |
| `POST` | `/products` | Bearer admin | Cria produto e sincroniza réplica |
| `POST` | `/orders` | Bearer | Cria pedido |
| `GET`  | `/orders/:userId` | Bearer (próprio ou admin) | Lista pedidos do usuário |
| `GET`  | `/gateway/health` | — | Status JSON de todos os serviços |
| `GET`  | `/dashboard` | — | Dashboard visual (abrir no navegador) |

---

## Execução SEM Docker (alternativa)

Instale as dependências em cada pasta de serviço:

```bash
cd entrega/users            && npm install
cd entrega/products         && npm install
cd entrega/products-replica && npm install
cd entrega/orders           && npm install
cd entrega/gateway          && npm install
```

Inicie cada serviço em um terminal separado, nesta ordem, a partir da pasta `entrega/`:

```bash
# Terminal 1
node users/index.js

# Terminal 2
REPLICA_URL=http://localhost:5012 node products/index.js

# Terminal 3
PORT=5012 node products-replica/index.js

# Terminal 4
PRODUCTS_URL=http://localhost:5002 node orders/index.js

# Terminal 5 (por último)
node gateway/index.js
```

> Sem Docker os serviços sobem em HTTP (sem TLS) pois os certificados ficam em `/app/certs/` que só existe dentro dos containers.
> Use `http://localhost:3000` no lugar de `https://localhost:3000` neste modo.
