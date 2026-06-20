# Team Task Manager

A full-stack team task management web application built for the assignment PDF in this repository. It supports signup/login, project membership, Admin and Member roles, task assignment, task status updates, and dashboard metrics.

## Features

- Signup and secure login with PBKDF2 password hashing and session tokens.
- Project creation with the creator assigned as Admin.
- Admin member management by email, including Admin or Member roles.
- Task creation with title, description, due date, priority, status, and assignee.
- Role-based access:
  - Admins can manage project members and tasks.
  - Members can view and update only their assigned tasks.
- Dashboard metrics for total tasks, status counts, tasks per user, and overdue tasks.
- REST API plus browser frontend served by the same Node app.
- File-backed NoSQL persistence in `data/db.json`.

## Local Setup

```bash
npm start
```

Open `http://localhost:3000`.
or
deploy on railway - "team-task-manager-production-139b.up.railway.app"

No external npm dependencies are required. The app uses Node.js built-in modules only.

## Environment Variables

- `PORT`: server port. Railway sets this automatically.
- `DATA_DIR`: optional path for the JSON database directory. Defaults to `./data`.
- `NODE_ENV=production`: enables the secure cookie flag for deployed HTTPS environments.

## REST API Overview

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/users`
- `GET /api/dashboard`
- `GET /api/projects`
- `POST /api/projects`
- `POST /api/projects/:projectId/members`
- `DELETE /api/projects/:projectId/members/:userId`
- `GET /api/projects/:projectId/tasks`
- `POST /api/projects/:projectId/tasks`
- `PATCH /api/tasks/:taskId`
- `DELETE /api/tasks/:taskId`

## Railway Deployment

1. Push this folder to a GitHub repository.
2. Create a new Railway project from the GitHub repository.
3. Railway will detect Node.js and run `npm start`.
4. Add `NODE_ENV=production` in Railway variables.
5. Use the generated Railway domain as the live application URL.

For durable production storage, configure a persistent volume or replace the file-backed database with Railway Postgres. The current implementation is intentionally dependency-light and suitable for assignment demonstration.
