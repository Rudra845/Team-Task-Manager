const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function nowIso() {
  return new Date().toISOString();
}

function ensureDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    writeDb({
      users: [],
      projects: [],
      memberships: [],
      tasks: [],
      sessions: [],
      counters: { user: 1, project: 1, task: 1 }
    });
  }
}

function readDb() {
  ensureDatabase();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function nextId(db, key) {
  const id = String(db.counters[key] || 1);
  db.counters[key] = Number(id) + 1;
  return id;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

function sanitizeUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function json(res, status, body, headers = {}) {
  send(res, status, body, headers);
}

function error(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return parseCookies(req.headers.cookie).ttm_token;
}

function getSessionUser(req, db) {
  const token = getToken(req);
  if (!token) return null;
  const session = db.sessions.find((item) => item.token === token && new Date(item.expiresAt).getTime() > Date.now());
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function requireUser(req, res, db) {
  const user = getSessionUser(req, db);
  if (!user) {
    error(res, 401, "Authentication required.");
    return null;
  }
  return user;
}

function membershipFor(db, projectId, userId) {
  return db.memberships.find((member) => member.projectId === projectId && member.userId === userId);
}

function requireProjectAccess(res, db, projectId, userId) {
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) {
    error(res, 404, "Project not found.");
    return null;
  }
  const membership = membershipFor(db, projectId, userId);
  if (!membership) {
    error(res, 403, "You do not have access to this project.");
    return null;
  }
  return { project, membership };
}

function isAdmin(db, projectId, userId) {
  return membershipFor(db, projectId, userId)?.role === "Admin";
}

function validateRequired(value, field) {
  if (!String(value || "").trim()) return `${field} is required.`;
  return null;
}

function serializeProject(db, project, userId) {
  const members = db.memberships
    .filter((member) => member.projectId === project.id)
    .map((member) => ({
      user: sanitizeUser(db.users.find((user) => user.id === member.userId)),
      role: member.role
    }))
    .filter((member) => member.user);
  const tasks = db.tasks.filter((task) => task.projectId === project.id);
  return {
    ...project,
    role: membershipFor(db, project.id, userId)?.role,
    members,
    taskCount: tasks.length,
    doneCount: tasks.filter((task) => task.status === "Done").length
  };
}

function serializeTask(db, task) {
  return {
    ...task,
    assignee: sanitizeUser(db.users.find((user) => user.id === task.assigneeId)),
    creator: sanitizeUser(db.users.find((user) => user.id === task.createdBy))
  };
}

function dashboardFor(db, user) {
  const projectIds = db.memberships.filter((member) => member.userId === user.id).map((member) => member.projectId);
  const visibleTasks = db.tasks.filter((task) => {
    if (!projectIds.includes(task.projectId)) return false;
    return isAdmin(db, task.projectId, user.id) || task.assigneeId === user.id;
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const byStatus = { "To Do": 0, "In Progress": 0, Done: 0 };
  const perUser = {};
  for (const task of visibleTasks) {
    byStatus[task.status] = (byStatus[task.status] || 0) + 1;
    const assignee = db.users.find((item) => item.id === task.assigneeId);
    const name = assignee ? assignee.name : "Unassigned";
    perUser[name] = (perUser[name] || 0) + 1;
  }
  return {
    totalTasks: visibleTasks.length,
    byStatus,
    perUser,
    overdueTasks: visibleTasks.filter((task) => task.status !== "Done" && task.dueDate && new Date(task.dueDate) < today).length
  };
}

function routePattern(pathname, pattern) {
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    if (patternParts[index].startsWith(":")) {
      params[patternParts[index].slice(1)] = decodeURIComponent(pathParts[index]);
    } else if (patternParts[index] !== pathParts[index]) {
      return null;
    }
  }
  return params;
}

async function handleApi(req, res, url) {
  const db = readDb();
  const method = req.method;
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/api/auth/signup") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const missing = validateRequired(name, "Name") || validateRequired(email, "Email") || validateRequired(password, "Password");
    if (missing) return error(res, 400, missing);
    if (password.length < 6) return error(res, 400, "Password must be at least 6 characters.");
    if (db.users.some((user) => user.email === email)) return error(res, 409, "Email is already registered.");
    const user = { id: nextId(db, "user"), name, email, passwordHash: hashPassword(password), createdAt: nowIso() };
    const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    db.users.push(user);
    db.sessions.push({ token, userId: user.id, createdAt: nowIso(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    writeDb(db);
    return json(res, 201, { user: sanitizeUser(user), token }, { "Set-Cookie": cookieFor(token) });
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const user = db.users.find((item) => item.email === email);
    if (!user || !verifyPassword(body.password, user.passwordHash)) return error(res, 401, "Invalid email or password.");
    const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    db.sessions = db.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now());
    db.sessions.push({ token, userId: user.id, createdAt: nowIso(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    writeDb(db);
    return json(res, 200, { user: sanitizeUser(user), token }, { "Set-Cookie": cookieFor(token) });
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const token = getToken(req);
    db.sessions = db.sessions.filter((session) => session.token !== token);
    writeDb(db);
    return json(res, 200, { ok: true }, { "Set-Cookie": "ttm_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

  if (method === "GET" && pathname === "/api/me") {
    const user = requireUser(req, res, db);
    if (!user) return;
    return json(res, 200, { user: sanitizeUser(user) });
  }

  const currentUser = requireUser(req, res, db);
  if (!currentUser) return;

  if (method === "GET" && pathname === "/api/users") {
    return json(res, 200, { users: db.users.map(sanitizeUser) });
  }

  if (method === "GET" && pathname === "/api/dashboard") {
    return json(res, 200, dashboardFor(db, currentUser));
  }

  if (method === "GET" && pathname === "/api/projects") {
    const projectIds = db.memberships.filter((member) => member.userId === currentUser.id).map((member) => member.projectId);
    const projects = db.projects.filter((project) => projectIds.includes(project.id)).map((project) => serializeProject(db, project, currentUser.id));
    return json(res, 200, { projects });
  }

  if (method === "POST" && pathname === "/api/projects") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    const missing = validateRequired(name, "Project name");
    if (missing) return error(res, 400, missing);
    const project = { id: nextId(db, "project"), name, description, createdBy: currentUser.id, createdAt: nowIso() };
    db.projects.push(project);
    db.memberships.push({ projectId: project.id, userId: currentUser.id, role: "Admin", joinedAt: nowIso() });
    writeDb(db);
    return json(res, 201, { project: serializeProject(db, project, currentUser.id) });
  }

  let params = routePattern(pathname, "/api/projects/:projectId/members");
  if (params && method === "POST") {
    const access = requireProjectAccess(res, db, params.projectId, currentUser.id);
    if (!access) return;
    if (access.membership.role !== "Admin") return error(res, 403, "Only project admins can add members.");
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const role = body.role === "Admin" ? "Admin" : "Member";
    const user = db.users.find((item) => item.email === email);
    if (!user) return error(res, 404, "No user found with that email.");
    if (membershipFor(db, params.projectId, user.id)) return error(res, 409, "User is already a project member.");
    db.memberships.push({ projectId: params.projectId, userId: user.id, role, joinedAt: nowIso() });
    writeDb(db);
    return json(res, 201, { project: serializeProject(db, access.project, currentUser.id) });
  }

  params = routePattern(pathname, "/api/projects/:projectId/members/:userId");
  if (params && method === "DELETE") {
    const access = requireProjectAccess(res, db, params.projectId, currentUser.id);
    if (!access) return;
    if (access.membership.role !== "Admin") return error(res, 403, "Only project admins can remove members.");
    if (params.userId === currentUser.id) return error(res, 400, "Admins cannot remove themselves.");
    db.memberships = db.memberships.filter((member) => !(member.projectId === params.projectId && member.userId === params.userId));
    db.tasks = db.tasks.map((task) => (task.projectId === params.projectId && task.assigneeId === params.userId ? { ...task, assigneeId: "" } : task));
    writeDb(db);
    return json(res, 200, { project: serializeProject(db, access.project, currentUser.id) });
  }

  params = routePattern(pathname, "/api/projects/:projectId/tasks");
  if (params && method === "GET") {
    const access = requireProjectAccess(res, db, params.projectId, currentUser.id);
    if (!access) return;
    const tasks = db.tasks
      .filter((task) => task.projectId === params.projectId)
      .filter((task) => access.membership.role === "Admin" || task.assigneeId === currentUser.id)
      .map((task) => serializeTask(db, task));
    return json(res, 200, { tasks });
  }

  if (params && method === "POST") {
    const access = requireProjectAccess(res, db, params.projectId, currentUser.id);
    if (!access) return;
    if (access.membership.role !== "Admin") return error(res, 403, "Only project admins can create tasks.");
    const body = await readBody(req);
    const title = String(body.title || "").trim();
    const missing = validateRequired(title, "Task title");
    if (missing) return error(res, 400, missing);
    const assigneeId = String(body.assigneeId || "");
    if (assigneeId && !membershipFor(db, params.projectId, assigneeId)) return error(res, 400, "Assignee must be a project member.");
    const task = {
      id: nextId(db, "task"),
      projectId: params.projectId,
      title,
      description: String(body.description || "").trim(),
      dueDate: body.dueDate || "",
      priority: ["Low", "Medium", "High"].includes(body.priority) ? body.priority : "Medium",
      status: ["To Do", "In Progress", "Done"].includes(body.status) ? body.status : "To Do",
      assigneeId,
      createdBy: currentUser.id,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    db.tasks.push(task);
    writeDb(db);
    return json(res, 201, { task: serializeTask(db, task) });
  }

  params = routePattern(pathname, "/api/tasks/:taskId");
  if (params && method === "PATCH") {
    const task = db.tasks.find((item) => item.id === params.taskId);
    if (!task) return error(res, 404, "Task not found.");
    const access = requireProjectAccess(res, db, task.projectId, currentUser.id);
    if (!access) return;
    const body = await readBody(req);
    const admin = access.membership.role === "Admin";
    if (!admin && task.assigneeId !== currentUser.id) return error(res, 403, "Members can update only assigned tasks.");
    if (!admin) {
      if (!["To Do", "In Progress", "Done"].includes(body.status)) return error(res, 400, "Members can only update status.");
      task.status = body.status;
    } else {
      if (body.title !== undefined) task.title = String(body.title || "").trim();
      if (body.description !== undefined) task.description = String(body.description || "").trim();
      if (body.dueDate !== undefined) task.dueDate = body.dueDate || "";
      if (body.priority !== undefined && ["Low", "Medium", "High"].includes(body.priority)) task.priority = body.priority;
      if (body.status !== undefined && ["To Do", "In Progress", "Done"].includes(body.status)) task.status = body.status;
      if (body.assigneeId !== undefined) {
        const assigneeId = String(body.assigneeId || "");
        if (assigneeId && !membershipFor(db, task.projectId, assigneeId)) return error(res, 400, "Assignee must be a project member.");
        task.assigneeId = assigneeId;
      }
    }
    if (!task.title) return error(res, 400, "Task title is required.");
    task.updatedAt = nowIso();
    writeDb(db);
    return json(res, 200, { task: serializeTask(db, task) });
  }

  if (params && method === "DELETE") {
    const task = db.tasks.find((item) => item.id === params.taskId);
    if (!task) return error(res, 404, "Task not found.");
    if (!isAdmin(db, task.projectId, currentUser.id)) return error(res, 403, "Only project admins can delete tasks.");
    db.tasks = db.tasks.filter((item) => item.id !== params.taskId);
    writeDb(db);
    return json(res, 200, { ok: true });
  }

  error(res, 404, "API route not found.");
}

function cookieFor(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `ttm_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requested.startsWith(PUBLIC_DIR)) return error(res, 403, "Forbidden.");
  fs.readFile(requested, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (indexErr, indexData) => {
        if (indexErr) return error(res, 404, "Not found.");
        res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
        res.end(indexData);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(requested)] || "application/octet-stream" });
    res.end(data);
  });
}

ensureDatabase();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    error(res, err.message === "Invalid JSON body." ? 400 : 500, err.message || "Server error.");
  }
});

server.listen(PORT, () => {
  console.log(`Team Task Manager running on http://localhost:${PORT}`);
});
