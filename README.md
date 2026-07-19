# La Lagune RWA — Painting Project Tracker

A dedicated tracker for the society's painting project. The project manager
(estate office) assigns tasks to the contractor; once a piece of work is
done, it's submitted with photos for a resident or RWA committee member to
inspect and approve — or send back for rework.

The contractor doesn't use this tool directly — the project manager logs
tasks and submits completion photos on the contractor's behalf.

## How the workflow works

```
Assigned ──(PM submits with photos)──> Submitted for Inspection
                                              │
                          ┌───────────────────┼───────────────────┐
                          │                                       │
                     Approved                              Rework Needed
                     (done)                                       │
                                              (PM resubmits with new photos)
                                                    back to Submitted for Inspection
```

- **Assigned** — PM logs the task: work area, location, contractor, scope,
  and optionally "current condition" photos.
- **Submitted for Inspection** — PM marks it done once the contractor
  finishes, attaching at least one photo of the completed work. This is
  required — inspection depends on having something to look at.
- **Approved** — a resident or RWA member reviewed and signed off. Done.
- **Rework Needed** — the inspector sent it back with a note on what needs
  fixing. The PM gets the contractor to redo it, then resubmits (with new
  photos) to go back to Submitted for Inspection.

Photos can be attached at every step — task creation, submission for
inspection, and both approval and rework — so the full visual history of
each task lives in its activity trail, not scattered across phones.

## How sign-in works

No individual accounts — two shared access codes, same as before:
`STAFF_ACCESS_CODE` for the project manager / estate office side,
`CHECKER_ACCESS_CODE` for residents and RWA committee members. Everyone
types their own name at sign-in, and checkers additionally pick who they're
acting as (Resident / RWA Committee Member / Estate Office Staff), which is
what shows up in the activity trail on every action.

## Deploying / updating on Vercel

Hosting is unchanged from before — same Vercel project, same Postgres
database, same three environment variables (`JWT_SECRET`,
`STAFF_ACCESS_CODE`, `CHECKER_ACCESS_CODE`). To pick up this update:

1. Replace `server.js`, `db.js`, and `public/index.html` in your GitHub
   repository with the versions in this zip (open each file on GitHub,
   click the pencil/edit icon, select all, paste the new contents, commit).
2. No environment variable changes needed — the same three variables are
   still used.
3. **Database note:** this version uses a new table (`tasks`) instead of
   the old `complaints` table, so nothing from before carries over
   automatically. The new table is created automatically on first run —
   no manual step needed. If you want to get rid of the old, now-unused
   `complaints` table, you can drop it from your database's SQL console,
   but it's harmless to just leave it there unused.
4. Redeploy (Deployments tab → ⋮ → Redeploy), then revisit your site.

## Local development

```bash
npm install
cp .env.example .env
# fill in JWT_SECRET, STAFF_ACCESS_CODE, CHECKER_ACCESS_CODE, and POSTGRES_URL
npm start
```
Then open http://localhost:3000.

## Notes on photos

- Photos are compressed in the browser before upload (resized to a max of
  1200px on the longest side, JPEG quality ~70%) to keep file sizes
  reasonable — typically well under 500KB each even from a modern phone
  camera.
- They're stored as part of the task's record in Postgres (base64-encoded),
  not in a separate file storage service — this keeps setup simple (no
  extra storage product to configure) at the cost of some database size.
  For a project with dozens of tasks and a handful of photos each, this
  comfortably fits within Neon's free tier. If the project scales up
  significantly (hundreds of tasks with many photos each), moving to
  Vercel Blob storage would be the next step — that's a contained change
  to how photos are stored, not a redesign of the workflow.
- Up to 6 photos per action, ~1.5MB raw size each, are accepted; the app
  rejects anything over that rather than silently failing.
