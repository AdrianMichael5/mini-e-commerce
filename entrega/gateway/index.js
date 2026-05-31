const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const fetch = require("node-fetch");

const app = express();

// IMPORTANTE: express.json() NÃO é usado globalmente.
// O body parser consome o readable stream; se ativado antes do proxy,
// o payload nunca chega ao serviço downstream. O body é repassado raw.

const PORT = process.env.PORT || 3000;

// ── Registry ─────────────────────────────────────────────────────────────────

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

// Contador global para round-robin de leituras de produtos
let productReadCounter = 0;
let heartbeatCycle = 0;

// ── Heartbeat ─────────────────────────────────────────────────────────────────

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
        console.log(`[RECOVERY] ${name} voltou ao ar em ${timestamp}`);
      }
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    svc.failCount++;
    svc.lastCheck = timestamp;
    if (svc.failCount >= 2 && svc.status !== "down") {
      svc.status = "down";
      console.error(`[FAILURE] ${name} marcado como DOWN em ${timestamp} (erro: ${err.message})`);
    } else if (svc.failCount === 1) {
      console.warn(`[heartbeat] ${name} falhou (tentativa 1/2): ${err.message}`);
    }
  }
}

function startHeartbeat() {
  // Checagem imediata no boot
  const runCycle = () => {
    heartbeatCycle++;
    console.log(`[heartbeat] Ciclo #${heartbeatCycle} — verificando ${Object.keys(serviceRegistry).length} serviços`);
    Object.keys(serviceRegistry).forEach(checkService);
  };
  runCycle();
  setInterval(runCycle, 5000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function guardService(name) {
  return (req, res, next) => {
    const svc = serviceRegistry[name];
    if (svc.status === "down") {
      console.warn(`[guard] Requisição bloqueada — serviço ${name} está DOWN`);
      return res.status(503).json({
        error: "Service unavailable",
        service: name,
        lastCheck: svc.lastCheck,
      });
    }
    next();
  };
}

// Cria proxy com repasse de Authorization e marcação de X-Gateway-Request
function makeProxy(getTarget, pathRewrite) {
  return createProxyMiddleware({
    router: getTarget,
    changeOrigin: true,
    pathRewrite,
    on: {
      proxyReq: (proxyReq, req) => {
        // Repassa Authorization intacto — essencial para autenticação downstream
        if (req.headers["authorization"]) {
          proxyReq.setHeader("Authorization", req.headers["authorization"]);
        }
        // Marca todas as requisições internas vindas do gateway
        proxyReq.setHeader("X-Gateway-Request", "true");
      },
      error: (err, req, res) => {
        console.error(`[gateway-proxy] Erro ao fazer proxy de ${req.method} ${req.url}:`, err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: "Bad gateway", detail: err.message });
        }
      },
    },
  });
}

// ── Rota local ────────────────────────────────────────────────────────────────

app.get("/gateway/health", (req, res) => {
  const services = {};
  for (const [name, svc] of Object.entries(serviceRegistry)) {
    services[name] = { status: svc.status, lastCheck: svc.lastCheck };
  }
  res.json({ gateway: "up", services });
});

// ── Proxy routes ──────────────────────────────────────────────────────────────

// Users — todas as rotas repassadas para :5001
app.use(
  "/users",
  guardService("users"),
  makeProxy(() => serviceRegistry.users.url, { "^/users": "/users" })
);

// Products — GET: round-robin entre instâncias UP; escrita: sempre primária
app.use("/products", (req, res, next) => {
  if (req.method === "GET") {
    const candidates = ["products-primary", "products-replica"].filter(
      (n) => serviceRegistry[n].status === "up"
    );

    if (candidates.length === 0) {
      console.warn("[round-robin] Nenhuma instância de products disponível");
      return res.status(503).json({
        error: "Service unavailable",
        service: "products",
        lastCheck: serviceRegistry["products-primary"].lastCheck,
      });
    }

    const chosen = candidates[productReadCounter % candidates.length];
    productReadCounter++;
    console.log(`[round-robin] GET ${req.url} → ${chosen} (req #${productReadCounter}, candidatos: ${candidates.join(", ")})`);

    return makeProxy(() => serviceRegistry[chosen].url, { "^/products": "/products" })(
      req, res, next
    );
  }

  // POST/PUT/PATCH/DELETE → sempre primária
  if (serviceRegistry["products-primary"].status === "down") {
    console.warn("[gateway] Escrita em products bloqueada — primária está DOWN");
    return res.status(503).json({
      error: "Service unavailable",
      service: "products-primary",
      lastCheck: serviceRegistry["products-primary"].lastCheck,
    });
  }

  console.log(`[gateway] ${req.method} ${req.url} → products-primary`);
  return makeProxy(() => serviceRegistry["products-primary"].url, {
    "^/products": "/products",
  })(req, res, next);
});

// Orders — todas as rotas repassadas para :5003
app.use(
  "/orders",
  guardService("orders"),
  makeProxy(() => serviceRegistry.orders.url, { "^/orders": "/orders" })
);

// ── Boot ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[boot] API Gateway iniciado na porta ${PORT}`);
  console.log(`[boot] Serviços configurados:`);
  for (const [name, svc] of Object.entries(serviceRegistry)) {
    console.log(`[boot]   ${name} → ${svc.url}`);
  }
  startHeartbeat();
});
