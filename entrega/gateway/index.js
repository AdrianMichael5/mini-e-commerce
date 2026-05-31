const express = require("express");
const { createProxyMiddleware, fixRequestBody } = require("http-proxy-middleware");
const fetch = require("node-fetch");

const app = express();

// IMPORTANTE: express.json() SOMENTE para a rota local do gateway.
// Nas rotas de proxy o body NÃO deve ser pré-parseado, pois isso consome
// o stream e o proxy não consegue repassá-lo aos serviços downstream.
// O fixRequestBody (fornecido pelo http-proxy-middleware) reconstrói o
// stream após o bodyParser, mas só é ativado nas rotas que precisam.

const PORT = process.env.PORT || 3000;

// ── Registry ────────────────────────────────────────────────────────────────

const serviceRegistry = {
  users: {
    url: process.env.USERS_URL || "http://localhost:5001",
    status: "up",
    lastCheck: null,
    failCount: 0,
  },
  "products-primary": {
    url: process.env.PRODUCTS_URL || "http://localhost:5002",
    status: "up",
    lastCheck: null,
    failCount: 0,
  },
  "products-replica": {
    url: process.env.PRODUCTS_REPLICA_URL || "http://localhost:5012",
    status: "up",
    lastCheck: null,
    failCount: 0,
  },
  orders: {
    url: process.env.ORDERS_URL || "http://localhost:5003",
    status: "up",
    lastCheck: null,
    failCount: 0,
  },
};

let productReadCounter = 0;

// ── Heartbeat ────────────────────────────────────────────────────────────────

async function checkService(name) {
  const svc = serviceRegistry[name];
  const previousStatus = svc.status;
  const timestamp = new Date().toISOString();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${svc.url}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      svc.failCount = 0;
      svc.status = "up";
      svc.lastCheck = timestamp;
      if (previousStatus === "down") {
        console.log(`[RECOVERY] ${name} voltou em ${timestamp}`);
      }
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch {
    svc.failCount++;
    svc.lastCheck = timestamp;
    if (svc.failCount >= 2 && svc.status !== "down") {
      svc.status = "down";
      console.log(`[FAILURE] ${name} caiu em ${timestamp}`);
    }
  }
}

function startHeartbeat() {
  Object.keys(serviceRegistry).forEach(checkService);
  setInterval(() => Object.keys(serviceRegistry).forEach(checkService), 5000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function guardService(name) {
  return (req, res, next) => {
    const svc = serviceRegistry[name];
    if (svc.status === "down") {
      return res.status(503).json({
        error: "Service unavailable",
        service: name,
        lastCheck: svc.lastCheck,
      });
    }
    next();
  };
}

// Fabrica um proxy para um target fixo.
// fixRequestBody reconstrói o stream depois do bodyParser — aqui não usamos
// bodyParser global, então não é necessário, mas é mantido por segurança.
function makeProxy(getTarget, pathRewrite) {
  return createProxyMiddleware({
    router: getTarget,
    changeOrigin: true,
    pathRewrite,
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.headers["authorization"]) {
          proxyReq.setHeader("Authorization", req.headers["authorization"]);
        }
        proxyReq.setHeader("X-Gateway-Request", "true");
      },
      error: (err, req, res) => {
        console.error("[gateway-proxy] Erro:", err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: "Bad gateway", detail: err.message });
        }
      },
    },
  });
}

// ── Rota local (única que precisa de body parser) ─────────────────────────────

app.get("/gateway/health", (req, res) => {
  const services = {};
  for (const [name, svc] of Object.entries(serviceRegistry)) {
    services[name] = { status: svc.status, lastCheck: svc.lastCheck };
  }
  res.json({ gateway: "up", services });
});

// ── Proxy routes ──────────────────────────────────────────────────────────────

// Users — repassa tudo para :5001
app.use(
  "/users",
  guardService("users"),
  makeProxy(() => serviceRegistry.users.url, { "^/users": "/users" })
);

// Products — GET → round-robin; escrita → primária
app.use("/products", (req, res, next) => {
  if (req.method === "GET") {
    const candidates = ["products-primary", "products-replica"].filter(
      (n) => serviceRegistry[n].status === "up"
    );
    if (candidates.length === 0) {
      return res.status(503).json({
        error: "Service unavailable",
        service: "products",
        lastCheck: serviceRegistry["products-primary"].lastCheck,
      });
    }
    const chosen = candidates[productReadCounter % candidates.length];
    productReadCounter++;
    console.log(`[round-robin] GET /products → ${chosen}`);
    return makeProxy(() => serviceRegistry[chosen].url, { "^/products": "/products" })(
      req, res, next
    );
  }

  // Escritas → primária
  if (serviceRegistry["products-primary"].status === "down") {
    return res.status(503).json({
      error: "Service unavailable",
      service: "products-primary",
      lastCheck: serviceRegistry["products-primary"].lastCheck,
    });
  }
  return makeProxy(() => serviceRegistry["products-primary"].url, {
    "^/products": "/products",
  })(req, res, next);
});

// Orders
app.use(
  "/orders",
  guardService("orders"),
  makeProxy(() => serviceRegistry.orders.url, { "^/orders": "/orders" })
);

// ── Boot ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
  startHeartbeat();
});
