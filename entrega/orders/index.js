const express = require("express");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");

const { verifyToken } = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5003;
const PRODUCTS_URL = process.env.PRODUCTS_URL || "http://localhost:5002";
const ORDERS_FILE = path.join(__dirname, "data", "orders.json");

function readOrders() {
  return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// GET síncrono via http nativo — sem dependências externas
function fetchProduct(productId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${PRODUCTS_URL}/products/${productId}`);

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "GET",
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("Timeout ao consultar serviço de produtos"));
    });

    req.on("error", reject);
    req.end();
  });
}

// ── Endpoints ──────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "orders" });
});

app.post("/orders", verifyToken, async (req, res) => {
  const { productId, quantity } = req.body;

  if (!productId || !quantity || quantity < 1) {
    return res.status(400).json({ error: "productId e quantity (>= 1) são obrigatórios" });
  }

  // Valida existência do produto
  let product;
  try {
    const result = await fetchProduct(productId);
    if (result.status === 404) {
      return res.status(404).json({ error: `Produto '${productId}' não encontrado` });
    }
    if (result.status !== 200) {
      return res.status(502).json({ error: "Erro ao consultar serviço de produtos" });
    }
    product = JSON.parse(result.body);
  } catch (err) {
    console.error("[products-fetch] Erro:", err.message);
    return res.status(502).json({ error: "Serviço de produtos indisponível" });
  }

  const order = {
    id: uuidv4(),
    userId: req.user.userId,
    productId: product.id,
    quantity,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const orders = readOrders();
  orders.push(order);
  writeOrders(orders);

  return res.status(201).json(order);
});

app.get("/orders/:userId", verifyToken, (req, res) => {
  const { userId } = req.params;
  const { userId: tokenUserId, role } = req.user;

  if (tokenUserId !== userId && role !== "admin") {
    return res.status(403).json({ error: "Acesso negado" });
  }

  const orders = readOrders().filter((o) => o.userId === userId);
  res.json(orders);
});

app.listen(PORT, () => {
  console.log(`Orders service running on port ${PORT}`);
  console.log(`Products URL: ${PRODUCTS_URL}`);
});
