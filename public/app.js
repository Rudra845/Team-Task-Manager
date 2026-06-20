const app = document.querySelector("#app");

const state = {
  user: null,
  projects: [],
  selectedProjectId: null,
  tasks: [],
  dashboard: null,
  users: []
};

const statuses = ["To Do", "In Progress", "Done"];
const priorities = ["Low", "Medium", "High"];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function formatDate(value) {
  if (!value) return "No due date";
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function currentProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) || state.projects[0] || null;
}

function isAdmin() {
  return currentProject()?.role === "Admin";
}

async function init() {
  try {
    const { user } = await api("/api/me");
    state.user = user;
    await loadAppData();
    renderApp();
  } catch {
    renderAuth();
  }
}

function renderAuth(mode = "login") {
  const template = document.querySelector("#auth-template").content.cloneNode(true);
  app.replaceChildren(template);
  const form = document.querySelector("#auth-form");
  const message = document.querySelector("#auth-message");
  const signupOnly = document.querySelector(".signup-only");
  const submit = form.querySelector("button[type='submit']");
  let authMode = mode;

  function setMode(nextMode) {
    authMode = nextMode;
    document.querySelectorAll("[data-auth-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.authTab === authMode);
    });
    signupOnly.classList.toggle("hidden", authMode !== "signup");
    submit.textContent = authMode === "signup" ? "Create account" : "Login";
    message.textContent = "";
  }

  document.querySelectorAll("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.authTab));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    const body = Object.fromEntries(new FormData(form));
    try {
      const { user } = await api(`/api/auth/${authMode}`, { method: "POST", body });
      state.user = user;
      await loadAppData();
      renderApp();
    } catch (err) {
      message.textContent = err.message;
    }
  });

  setMode(authMode);
}

async function loadAppData() {
  const [projectsData, dashboardData, usersData] = await Promise.all([
    api("/api/projects"),
    api("/api/dashboard"),
    api("/api/users")
  ]);
  state.projects = projectsData.projects;
  state.dashboard = dashboardData;
  state.users = usersData.users;
  if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = state.projects[0]?.id || null;
  }
  if (state.selectedProjectId) {
    const tasksData = await api(`/api/projects/${state.selectedProjectId}/tasks`);
    state.tasks = tasksData.tasks;
  } else {
    state.tasks = [];
  }
}

async function refresh() {
  await loadAppData();
  renderApp();
}

function renderApp() {
  const project = currentProject();
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <strong>Team Task Manager</strong>
          <span>${escapeHtml(state.user.name)} · ${escapeHtml(state.user.email)}</span>
        </div>
        <button class="ghost" id="logout-button" type="button">Logout</button>
        <hr>
        <h2>Projects</h2>
        <div class="project-list">
          ${state.projects.map((item) => `
            <button class="project-button ${item.id === state.selectedProjectId ? "active" : ""}" data-project-id="${item.id}">
              <strong>${escapeHtml(item.name)}</strong><br>
              <span class="muted">${item.role} · ${item.doneCount}/${item.taskCount} done</span>
            </button>
          `).join("") || `<div class="empty">No projects yet.</div>`}
        </div>
        <form id="project-form" class="stack">
          <label class="field">
            <span>Project name</span>
            <input name="name" required>
          </label>
          <label class="field">
            <span>Description</span>
            <textarea name="description"></textarea>
          </label>
          <button class="primary" type="submit">Create project</button>
          <p class="form-message" id="project-message"></p>
        </form>
      </aside>
      <section class="main">
        <div class="topbar">
          <div>
            <p class="eyebrow">Dashboard</p>
            <h1>${project ? escapeHtml(project.name) : "Create your first project"}</h1>
            <p class="muted">${project ? escapeHtml(project.description || "No description") : "Projects organize members and task work."}</p>
          </div>
        </div>
        ${renderDashboard()}
        ${project ? renderProject(project) : ""}
      </section>
    </div>
  `;

  bindAppEvents();
}

function renderDashboard() {
  const dashboard = state.dashboard || { totalTasks: 0, byStatus: {}, overdueTasks: 0, perUser: {} };
  return `
    <div class="dashboard-grid">
      <div class="metric"><span>Total tasks</span><strong>${dashboard.totalTasks}</strong></div>
      <div class="metric"><span>To do</span><strong>${dashboard.byStatus["To Do"] || 0}</strong></div>
      <div class="metric"><span>In progress</span><strong>${dashboard.byStatus["In Progress"] || 0}</strong></div>
      <div class="metric"><span>Overdue</span><strong>${dashboard.overdueTasks}</strong></div>
    </div>
  `;
}

function renderProject(project) {
  return `
    <div class="content-grid">
      <section class="panel">
        <div class="topbar">
          <h2>Tasks</h2>
          <span class="pill">${project.role}</span>
        </div>
        ${isAdmin() ? renderTaskForm(project) : ""}
        <div class="task-board">
          ${statuses.map((status) => renderColumn(status)).join("")}
        </div>
      </section>
      <aside class="stack">
        <section class="panel">
          <h2>Members</h2>
          <div class="member-list">
            ${project.members.map((member) => `
              <div class="member">
                <div>
                  <strong>${escapeHtml(member.user.name)}</strong><br>
                  <small>${escapeHtml(member.user.email)} · ${member.role}</small>
                </div>
                ${isAdmin() && member.user.id !== state.user.id ? `<button class="danger" data-remove-user="${member.user.id}" type="button">Remove</button>` : ""}
              </div>
            `).join("")}
          </div>
          ${isAdmin() ? renderMemberForm() : ""}
        </section>
        <section class="panel">
          <h2>Tasks per user</h2>
          <div class="stack">
            ${Object.entries(state.dashboard.perUser || {}).map(([name, count]) => `
              <div class="member"><strong>${escapeHtml(name)}</strong><span class="pill">${count}</span></div>
            `).join("") || `<div class="empty">No assigned tasks.</div>`}
          </div>
        </section>
      </aside>
    </div>
  `;
}

function renderTaskForm(project) {
  return `
    <form id="task-form" class="stack">
      <div class="row">
        <label class="field">
          <span>Title</span>
          <input name="title" required>
        </label>
        <label class="field">
          <span>Due date</span>
          <input name="dueDate" type="date">
        </label>
      </div>
      <label class="field">
        <span>Description</span>
        <textarea name="description"></textarea>
      </label>
      <div class="row">
        <label class="field">
          <span>Priority</span>
          <select name="priority">${priorities.map((priority) => `<option>${priority}</option>`).join("")}</select>
        </label>
        <label class="field">
          <span>Assignee</span>
          <select name="assigneeId">
            <option value="">Unassigned</option>
            ${project.members.map((member) => `<option value="${member.user.id}">${escapeHtml(member.user.name)}</option>`).join("")}
          </select>
        </label>
      </div>
      <button class="primary" type="submit">Create task</button>
      <p class="form-message" id="task-message"></p>
    </form>
    <hr>
  `;
}

function renderMemberForm() {
  return `
    <form id="member-form" class="stack">
      <label class="field">
        <span>User email</span>
        <input name="email" type="email" required>
      </label>
      <label class="field">
        <span>Role</span>
        <select name="role">
          <option>Member</option>
          <option>Admin</option>
        </select>
      </label>
      <button class="secondary" type="submit">Add member</button>
      <p class="form-message" id="member-message"></p>
    </form>
  `;
}

function renderColumn(status) {
  const tasks = state.tasks.filter((task) => task.status === status);
  return `
    <div class="column">
      <p class="column-title">${status}</p>
      <div class="task-list">
        ${tasks.map(renderTask).join("") || `<div class="empty">No tasks</div>`}
      </div>
    </div>
  `;
}

function renderTask(task) {
  return `
    <article class="task-card">
      <h3>${escapeHtml(task.title)}</h3>
      <p class="muted">${escapeHtml(task.description || "No description")}</p>
      <div class="task-meta">
        <span class="pill ${task.priority.toLowerCase()}">${task.priority}</span>
        <span>${formatDate(task.dueDate)}</span>
        <span>${escapeHtml(task.assignee?.name || "Unassigned")}</span>
      </div>
      <div class="actions">
        <select data-status-task="${task.id}">
          ${statuses.map((status) => `<option ${task.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
        ${isAdmin() ? `<button class="danger" data-delete-task="${task.id}" type="button">Delete</button>` : ""}
      </div>
    </article>
  `;
}

function bindAppEvents() {
  document.querySelector("#logout-button").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    renderAuth();
  });

  document.querySelectorAll("[data-project-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedProjectId = button.dataset.projectId;
      await refresh();
    });
  });

  document.querySelector("#project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.querySelector("#project-message");
    message.textContent = "";
    try {
      const { project } = await api("/api/projects", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
      state.selectedProjectId = project.id;
      await refresh();
    } catch (err) {
      message.textContent = err.message;
    }
  });

  document.querySelector("#task-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.querySelector("#task-message");
    message.textContent = "";
    try {
      await api(`/api/projects/${state.selectedProjectId}/tasks`, { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
      await refresh();
    } catch (err) {
      message.textContent = err.message;
    }
  });

  document.querySelector("#member-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.querySelector("#member-message");
    message.textContent = "";
    try {
      await api(`/api/projects/${state.selectedProjectId}/members`, { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
      await refresh();
    } catch (err) {
      message.textContent = err.message;
    }
  });

  document.querySelectorAll("[data-status-task]").forEach((select) => {
    select.addEventListener("change", async () => {
      await api(`/api/tasks/${select.dataset.statusTask}`, { method: "PATCH", body: { status: select.value } });
      await refresh();
    });
  });

  document.querySelectorAll("[data-delete-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/tasks/${button.dataset.deleteTask}`, { method: "DELETE" });
      await refresh();
    });
  });

  document.querySelectorAll("[data-remove-user]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/projects/${state.selectedProjectId}/members/${button.dataset.removeUser}`, { method: "DELETE" });
      await refresh();
    });
  });
}

init();
