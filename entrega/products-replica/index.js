const express = require("express");
const https = require("https");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5012;
const INTERNAL_KEY = process.env.INTERNAL_KEY || "internalkey123";
const PRODUCTS_FILE = path.join(__dirname, "data", "products.json");

// ── Persistência ─────────────────────────────────────────────────────────────

function ensureDataFile() {
  const dir = path.dirname(PRODUCTS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[init] Diretório criado: ${dir}`);
  }
  if (!fs.existsSync(PRODUCTS_FILE)) {
    fs.writeFileSync(PRODUCTS_FILE, "[]");
    console.log(`[init] Arquivo criado: ${PRODUCTS_FILE}`);
  }
}

function readProducts() {
  try {
    return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf-8"));
  } catch (err) {
    console.error("[storage] Erro ao ler products.json:", err.message);
    return [];
  }
}

function writeProducts(products) {
  try {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
  } catch (err) {
    console.error("[storage] Erro ao gravar products.json:", err.message);
    throw err;
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "products-replica" });
});

app.get("/products", (req, res) => {
  res.json(readProducts());
});

app.get("/products/:id", (req, res) => {
  const product = readProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Produto não encontrado" });
  res.json(product);
});

// Endpoint interno — recebe dados sincronizados da primária e valida INTERNAL_KEY
app.post("/internal/sync", (req, res) => {
  const key = req.headers["x-internal-key"];
  if (key !== INTERNAL_KEY) {
    console.warn("[internal-sync] Chave interna inválida recebida");
    return res.status(403).json({ error: "Chave interna inválida" });
  }

  const product = req.body;
  if (!product || !product.id) {
    return res.status(400).json({ error: "Payload de sincronização inválido" });
  }

  const products = readProducts();
  if (!products.find((p) => p.id === product.id)) {
    products.push(product);
    writeProducts(products);
    console.log(`[internal-sync] Produto ${product.id} recebido e salvo (réplica)`);
  } else {
    console.log(`[internal-sync] Produto ${product.id} já existe — ignorado (idempotente)`);
  }

  res.json({ synced: true });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

ensureDataFile();

const TLS_KEY = "/app/certs/service.key";
const TLS_CERT = "/app/certs/service.crt";
const boot = () => {
  console.log(`[boot] Products REPLICA service iniciado na porta ${PORT}`);
  console.log(`[boot] INTERNAL_KEY configurada: ${INTERNAL_KEY !== "internalkey123" ? "customizada" : "padrão (dev)"}`);
};

if (fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT)) {
  https.createServer({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }, app)
    .listen(PORT, () => { console.log("[boot] TLS ativo"); boot(); });
} else {
  app.listen(PORT, boot);
}
