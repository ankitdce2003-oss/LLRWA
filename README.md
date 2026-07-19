# La Lagune RWA — Complaint & Observation Tracker (Vercel edition)

A complaint/observation register for the estate office, with a maker-checker
approval workflow: estate office staff log entries, and a resident or RWA
committee member must approve, return, or close them. Every action is
recorded in an audit trail.

## How sign-in works

There are no individual accounts. Instead there are **two shared access
codes** — one for the Staff (maker) role, one for the Checker role. Anyone
who has the relevant code can sign in as that role, typing their own name
each time. Checkers also pick who they're acting as when they sign in:
**Resident**, **RWA Committee Member**, or **Estate Office Staff** (for a
staff member covering a checker's review). Whatever they type/pick is what
shows up in the audit trail on every action they take — so you still get a
real record of who did what, without managing a login for every person.

Treat both codes like shared passwords: give the Staff code to your estate
office team, and the Checker code to your RWA committee and any residents
you want reviewing entries. Change them (just update the environment
variables and redeploy) if you ever need to revoke access broadly.

## How the workflow works

`Pending Review` → (checker approves) → `Approved` → (staff marks resolved) →
`Resolved` → (checker verifies) → `Verified & Closed`

At any review point the checker can **Return** an entry with a remark; staff
then correct it and resubmit, which puts it back in `Pending Review`.

## Deploying on Vercel

1. **Push this folder to a GitHub repository**, then in Vercel: **Add New →
   Project → Import** that repository. Leave build settings as default —
   `vercel.json` routes everything through `api/index.js`.

2. **Add a Postgres database.** In the project's Storage tab → Create
   Database → **Neon** (Serverless Postgres). When connecting it to the
   project, clear the "Custom Environment Variable Prefix" field so the
   variable is created as plain `POSTGRES_URL` rather than a prefixed name
   — the app looks for `POSTGRES_URL` or `DATABASE_URL` specifically.

3. **Add three environment variables** in Settings → Environment Variables:
   - `JWT_SECRET` — any long random string (e.g. generate with
     `openssl rand -hex 32`)
   - `STAFF_ACCESS_CODE` — the code you'll give your estate office team
   - `CHECKER_ACCESS_CODE` — the code you'll give residents/committee members

4. **Redeploy** (Deployments tab → ⋮ on the latest deployment → Redeploy)
   so the new environment variables and database connection take effect.

5. **Visit your `.vercel.app` URL**, sign in with either code, and you're
   in. Share the Staff code and Checker code with the relevant people
   directly (in person, a shared note, however you'd share any password) —
   there's no invite/email flow, just the code.

The database table is created automatically the first time the app runs —
no manual setup step needed.

## Local development

```bash
npm install
cp .env.example .env
# fill in JWT_SECRET, STAFF_ACCESS_CODE, CHECKER_ACCESS_CODE, and POSTGRES_URL
npm start
```
Then open http://localhost:3000.

## Notes on this architecture

- **No file storage.** Complaints (including the full audit trail, stored
  as JSONB) live in Postgres. Back up the database via Neon/Vercel's own
  tools — there's nothing on disk to back up manually.
- **Concurrency-safe updates.** Approve/return/resolve/verify actions use a
  row lock inside a transaction, so two people acting on the same entry at
  once can't corrupt its state.
- **Access codes over accounts.** This trades per-person authentication for
  simplicity — anyone with a code can act in that role under any name they
  type. That's an intentional fit for a small, trusted community; it means
  the audit trail records what people *say* their name is, not a verified
  identity. If you later want real verified accounts instead, that's a
  bigger change (back to a users table + passwords) — say the word and it
  can be rebuilt that way.
- **Rate limiting is best-effort.** `express-rate-limit`'s in-memory counter
  resets whenever a serverless instance cold-starts, so it slows down
  casual code-guessing but isn't a hard guarantee on Vercel's serverless
  model.
