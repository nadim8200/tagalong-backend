# TagAlong backend

A tiny server that keeps your Traccar admin token secret. The web app talks to
this server; only this server talks to Traccar. This is what makes a public
launch safe — the token is never in the browser.

## What it does
- `POST /auth/login` — checks the email/password against your Traccar server and
  sets a secure, HttpOnly session cookie. Passwords are never stored here.
- `GET /auth/me` — who's logged in.
- `POST /auth/logout` — sign out.
- `ALL /api/traccar/*` — an authenticated proxy to Traccar. The app calls this
  instead of Traccar directly, and the token is added here on the server.

## Run it locally (to test)
1. Install Node 18+.
2. In this `server/` folder: `npm install`
3. Copy `.env.example` to `.env` and fill in `TRACCAR_TOKEN` and `JWT_SECRET`.
4. `npm start` → it runs on http://localhost:8080

## Deploy it free (Render.com)
1. Put this project on GitHub (a private repo is fine).
2. On **render.com**, create a **New → Web Service**, connect the repo, and set
   **Root Directory** to `server`.
   - Build command: `npm install`
   - Start command: `npm start`
3. Under **Environment**, add these variables (from `.env.example`):
   `TRACCAR_URL`, `TRACCAR_TOKEN`, `JWT_SECRET`, `ALLOWED_ORIGINS`, `COOKIE_SECURE=true`.
4. Deploy. Render gives you a URL like `https://tagalong-backend.onrender.com`.
5. Point the web app at it: in the app's `src/config.js`, set
   `API_BASE = 'https://tagalong-backend.onrender.com'`.

## Important
- Put your real Traccar token ONLY in the host's environment variables — never in
  the app code or in Git.
- Keep `ALLOWED_ORIGINS` limited to your real site(s): `https://tagalong.app`.
- This is milestone 1 (token security + login). Moving broker/family/rental data
  into a real database is the next milestone.
