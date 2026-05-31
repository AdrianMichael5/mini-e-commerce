const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const { verifyToken } = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const USERS_FILE = path.join(__dirname, "data", "users.json");

// ── Persistência ─────────────────────────────────────────────────────────────

function ensureDataFile() {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[init] Diretório criado: ${dir}`);
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, "[]");
    console.log(`[init] Arquivo criado: ${USERS_FILE}`);
  }
}

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch (err) {
    console.error("[storage] Erro ao ler users.json:", err.message);
    return [];
  }
}

function writeUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("[storage] Erro ao gravar users.json:", err.message);
    throw err;
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "users" });
});

app.post("/users/register", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email e password são obrigatórios" });
  }

  const users = readUsers();

  if (users.find((u) => u.email === email)) {
    return res.status(409).json({ error: "Email já cadastrado" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = { id: uuidv4(), name, email, passwordHash, role: "user" };
  users.push(newUser);
  writeUsers(users);

  console.log(`[register] Novo usuário: ${email} (id=${newUser.id})`);
  return res.status(201).json({ id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role });
});

app.post("/users/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email e password são obrigatórios" });
  }

  const users = readUsers();
  const user = users.find((u) => u.email === email);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    console.warn(`[login] Tentativa inválida para: ${email}`);
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: "2h" }
  );

  console.log(`[login] Login bem-sucedido: ${email} (role=${user.role})`);
  return res.json({ token });
});

app.get("/users/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  const { userId, role } = req.user;

  if (userId !== id && role !== "admin") {
    return res.status(403).json({ error: "Acesso negado" });
  }

  const users = readUsers();
  const user = users.find((u) => u.id === id);

  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado" });
  }

  const { passwordHash, ...safeUser } = user;
  return res.json(safeUser);
});

// Endpoint de desenvolvimento — promove usuário a admin sem autenticação.
// NÃO usar em produção.
app.post("/users/make-admin/:id", (req, res) => {
  const users = readUsers();
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
  user.role = "admin";
  writeUsers(users);
  console.log(`[make-admin] Usuário promovido: ${user.email} (id=${user.id})`);
  const { passwordHash, ...safeUser } = user;
  return res.json({ message: "Papel atualizado para admin", user: safeUser });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

ensureDataFile();
app.listen(PORT, () => {
  console.log(`[boot] Users service iniciado na porta ${PORT}`);
  console.log(`[boot] JWT_SECRET configurado: ${JWT_SECRET !== "supersecret" ? "customizado" : "padrão (dev)"}`);
});
