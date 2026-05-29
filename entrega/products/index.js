const express = require("express");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");

const { verifyToken, requireAdmin } = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5002;
const REPLICA_URL = process.env.REPLICA_URL || "http://localhost:5012";
const INTERNAL_KEY = process.env.INTERNAL_KEY || "internalkey123";
const PRODUCTS_FILE = path.join(__dirname, "data", "products.json");

function readProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf-8"));
}

function writeProducts(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

// Faz POST síncrono para a réplica sem dependências externas (http nativo)
function syncToReplica(product) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(product);
    const url = new URL(`${REPLICA_URL}/internal/sync`);

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Internal-Key": INTERNAL_KEY,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Replica respondeu ${res.statusCode}: ${data}`));
        }
      });
    });

    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("Timeout ao sincronizar com a réplica"));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Endpoints ──────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "products-primary" });
});

app.get("/products", (req, res) => {
  res.json(readProducts());
});

app.get("/products/:id", (req, res) => {
  const product = readProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: "Produto não encontrado" });
  res.json(product);
});

app.post("/products", verifyToken, requireAdmin, async (req, res) => {
  const { name, description, price, stock } = req.body;

  if (!name || price == null || stock == null) {
    return res.status(400).json({ error: "name, price e stock são obrigatórios" });
  }

  const product = { id: uuidv4(), name, description: description || "", price, stock };

  const products = readProducts();
  products.push(product);
  writeProducts(products);

  // Sincronização síncrona com a réplica
  try {
    await syncToReplica(product);
  } catch (err) {
    console.error("[replica-sync] Falha ao sincronizar:", err.message);
    return res.status(201).set("X-Replica-Warning", "replica sync failed").json(product);
  }

  return res.status(201).json(product);
});

// Endpoint interno — aceita dados da primária (réplica usa este mesmo handler)
app.post("/internal/sync", (req, res) => {
  const key = req.headers["x-internal-key"];
  if (key !== INTERNAL_KEY) {
    return res.status(403).json({ error: "Chave interna inválida" });
  }

  const product = req.body;
  if (!product || !product.id) {
    return res.status(400).json({ error: "Payload de sincronização inválido" });
  }

  const products = readProducts();
  // Idempotente: ignora se já existe
  if (!products.find((p) => p.id === product.id)) {
    products.push(product);
    writeProducts(products);
  }

  res.json({ synced: true });
});

app.listen(PORT, () => {
  console.log(`Products PRIMARY service running on port ${PORT}`);
  console.log(`Replica URL: ${REPLICA_URL}`);
});
