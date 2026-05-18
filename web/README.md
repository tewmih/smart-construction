# Construction Management System

A web application for coordinating construction projects: dashboards, tasks, daily logs, team visibility, and notifications. The interface is built with **Next.js** and talks to a separate **REST API** (JWT authentication, OpenAPI-documented).

## Features

- **Authentication** — Registration, login, session handling with access and refresh tokens  
- **Projects** — Project selection, creation, and role-aware dashboard navigation  
- **Operations** — Tasks, daily logs, reports, notifications, and profile-oriented settings  
- **Responsive UI** — Built with React, Tailwind CSS, and accessible UI primitives (Radix)

## Tech stack

| Layer | Choice |
|--------|--------|
| Framework | [Next.js](https://nextjs.org) (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Components | Radix UI, Lucide icons |
| API client | `fetch`-based module with typed responses |

## Prerequisites

- **Node.js** 18+ (20+ recommended)  
- **npm**, **pnpm**, or **yarn**  
- A running **backend** that exposes the API (see your team’s deployment or local FastAPI instance)

## Configuration

Create a file named `.env.local` in the project root:

```bash
NEXT_PUBLIC_API_BASE_URL=https://your-api-host.example.com/api/v1
```

Use the base URL that points at the **`/api/v1`** prefix of your backend. Do not use the Swagger UI path (`/docs`) as part of this value.

## Getting started

Install dependencies and start the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the development server with hot reload |
| `npm run build` | Create an optimized production build |
| `npm run start` | Run the production server (after `build`) |
| `npm run lint` | Run ESLint on the codebase |

## Project layout

- `app/` — Routes, layouts, and pages (App Router)  
- `components/` — Shared and feature UI components  
- `lib/` — API client, auth context, types, and domain helpers  

## API integration

The frontend expects a backend that implements the documented contract (e.g. auth, users, projects, tasks, logs). Adjust `NEXT_PUBLIC_API_BASE_URL` per environment. For local development, point it at your API origin; ensure CORS is configured on the server if the API runs on a different host or port.

## Deploy to Vercel

This frontend is set up for Vercel deploys. The whole project lives in a monorepo; the `web/` folder is the deployable.

1. **Import the repo** in the Vercel dashboard → "Add New… → Project".
2. **Root Directory** → set to `web`. Vercel auto-detects Next.js.
3. **Build & install** are pinned in `vercel.json` — pnpm install + `pnpm run build` (Webpack).
4. **Environment Variables** → add to all three environments (Production, Preview, Development):

   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_API_BASE_URL` | `https://api.yourdomain.com/api/v1` (your EC2 backend) |
   | `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | your Google OAuth client ID (same as backend `GOOGLE_CLIENT_ID`) |

   Vercel inlines `NEXT_PUBLIC_*` vars at build time. Changing them requires a redeploy.

5. **Custom domain** (optional) → Domains → add `yourdomain.com`, follow the DNS instructions.

6. **Backend hook-up** — the backend `.env` must allow your Vercel URLs:
   - `BACKEND_CORS_ORIGINS` includes `https://yourdomain.com` and `https://<project>.vercel.app`
   - `FRONTEND_URL` points to your production Vercel URL (used in email links)
   - In the Google Cloud Console, add `https://yourdomain.com` and `https://<project>.vercel.app` as **Authorized JavaScript origins**.

Push to `main` triggers a production deploy automatically; every PR gets its own preview URL.

## License

This project is maintained for educational and demonstration purposes. Add a license file if you intend to distribute or open-source the work.
