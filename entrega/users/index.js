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

function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

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
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: "2h" }
  );

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
  const { passwordHash, ...safeUser } = user;
  return res.json({ message: "Papel atualizado para admin", user: safeUser });
});

app.listen(PORT, () => {
  console.log(`Users service running on port ${PORT}`);
});
