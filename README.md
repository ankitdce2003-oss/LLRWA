# La Lagune RWA — Complaint & Observation Tracker (Vercel edition)

A self-hosted complaint/observation register for the estate office, with a
maker-checker approval workflow: estate office staff log entries, and a
resident or RWA committee member must approve, return, or close them. Every
action is recorded in an audit trail.

This version is built to deploy on **Vercel**, using a Postgres database for
storage (Vercel's serverless functions don't have a persistent filesystem,
so a database replaces the JSON files used in the VPS/Render version of this
app).

## How the workflow works

`Pending Review` → (checker approves) → `Approved` → (staff marks resolved) →
`Resolved` → (checker verifies) → `Verified & Closed`

At any review point the checker can **Return** an entry with a remark; staff
then correct it and resubmit, which puts it back in `Pending Review`.

Two account roles:
- **staff** — logs new entries, resubmits returned entries, marks approved
  entries resolved.
- **checker** — approves/returns pending entries, verifies/reopens resolved
  entries. Intended for RWA committee members or designated residents.

Login is stateless (a signed JWT in an httpOnly cookie) rather than
server-side sessions, since serverless functions don't share memory between
invocations the way a normal server does.

## Deploying to your Vercel project

You already have a Vercel project (e.g. `llrwav23062026`) with **Connect Git
Repository** waiting — here's the rest of the setup:

1. **Push this folder to a GitHub repository.** Vercel deploys by watching a
   Git repo, so create a repo (on GitHub, GitLab, or Bitbucket) and push
   everything in this folder to it.

2. **Connect the repo.** In your Vercel project, click **Connect Git
   Repository** and pick the repo you just pushed. Vercel will detect it as
   a Node project automatically — you don't need to change the build
   settings; `vercel.json` in this folder tells Vercel to route everything
   through `api/index.js`.

3. **Add a Postgres database.** In the left sidebar, click **Storage** →
   **Create Database** → choose the Postgres option (Vercel offers this via
   a Neon-backed integration with a free tier). Once created, click
   **Connect Project** and select this project — Vercel will automatically
   add a `POSTGRES_URL` environment variable for you. You don't need to
   copy/paste a connection string yourself.

4. **Set the other environment variable.** In **Settings → Environment
   Variables**, add:
   - `JWT_SECRET` — a random value, e.g. generate one locally with
     `openssl rand -hex 32` and paste it in.

   (`NODE_ENV=production` is set automatically by Vercel — you don't need
   to add it.)

5. **Deploy.** Vercel deploys automatically once the repo is connected and
   env vars are set. Watch the Deployments tab for the build to finish.

6. **Initialize the database and create accounts.** This needs to be run
   from your own computer, pointed at the same database Vercel is using:
   - In the Vercel Storage tab, open your Postgres database and copy its
     connection string (usually shown as `POSTGRES_URL` or similar).
   - On your machine, inside this project folder:
     ```bash
     npm install
     echo 'POSTGRES_URL=paste-the-connection-string-here' > .env
     npm run init-db
     npm run add-user -- --username estateoffice --password "changeme" --role staff --name "Estate Office"
     npm run add-user -- --username president --password "changeme" --role checker --name "President, RWA Committee"
     ```
   - Run `add-user` again any time to add more accounts (one per staff
     member / committee member is recommended) or reset a password.
   - **Delete the `.env` file afterwards** or make sure it's not committed —
     it contains a real database credential. `.gitignore` already excludes
     it, just don't force-add it.

7. **Visit your `.vercel.app` URL** (shown on your project's Overview page,
   e.g. `llrwav23062026.vercel.app`) and sign in with an account you just
   created. Once you're happy with it, add a custom domain from the
   **Domains** tab in the sidebar.

## Local development

```bash
npm install
cp .env.example .env
# fill in JWT_SECRET and POSTGRES_URL (point at a local Postgres or a dev
# branch of your Vercel/Neon database)
npm run init-db
npm run add-user -- --username you --password "test1234" --role staff --name "Your Name"
npm start
```
Then open http://localhost:3000.

## Notes on this architecture

- **No file storage.** Everything lives in Postgres (`db.js`), including
  the audit trail (stored as JSONB per complaint). There's nothing on disk
  to back up manually — back up the database instead, via Vercel/Neon's own
  backup or export tools.
- **Concurrency-safe updates.** Approve/return/resolve/verify actions use a
  row lock (`SELECT ... FOR UPDATE`) inside a transaction, so two people
  acting on the same entry at once can't corrupt its state.
- **Rate limiting is best-effort.** `express-rate-limit`'s in-memory counter
  resets whenever a serverless instance cold-starts, so it slows down
  casual brute-forcing but isn't a hard guarantee the way it would be on a
  single long-running server. For a small internal tool this is an
  acceptable trade-off.
- **No self-serve signup.** Accounts only come from `npm run add-user`
  (run against your production database from your own machine), so access
  stays limited to people the estate office has actually issued
  credentials to.
