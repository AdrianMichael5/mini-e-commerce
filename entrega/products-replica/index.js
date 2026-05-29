const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5012;
const INTERNAL_KEY = process.env.INTERNAL_KEY || "internalkey123";
const PRODUCTS_FILE = path.join(__dirname, "data", "products.json");

function readProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf-8"));
}

function writeProducts(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

// ── Endpoints ──────────────────────────────────────────────────────────────

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

// Endpoint interno — recebe dados sincronizados da primária
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
  console.log(`Products REPLICA service running on port ${PORT}`);
});
