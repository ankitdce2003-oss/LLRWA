# La Lagune RWA — Painting Project Tracker

A dedicated tracker for the society's painting project. The project manager
(estate office) assigns tasks to the contractor; once a piece of work is
done, it's submitted with photos for a resident or RWA committee member to
inspect and approve — or send back for rework.

The contractor doesn't use this tool directly — the project manager logs
tasks and submits completion photos on the contractor's behalf.

## How the workflow works

```
Assigned to Contractor ──(PM sends for inspection)──> Submitted for Inspection
                                              │
                          ┌───────────────────┼───────────────────┐
                          │                                       │
                     Approved                              Rework Needed
                     (done)                                       │
                                              (PM resends with updated details)
                                                    back to Submitted for Inspection
```

- **Assigned to Contractor** — PM creates the task: work location, tower,
  flat number (if applicable), contractor, scope of work, and optionally
  "current condition" photos. The task sits here until the PM explicitly
  sends it for inspection — creating it does **not** notify anyone.
- **Submitted for Inspection** — PM marks it done once the contractor
  finishes. Photos are optional at this step (helpful, not required).
- **Approved** — a resident or RWA member reviewed and signed off. Done.
- **Rework Needed** — the inspector sent it back with a note on what needs
  fixing. The PM gets the contractor to redo it, then resends it to go
  back to Submitted for Inspection.

**Work location** is chosen from a fixed list (Balcony Front, Balcony Back,
Refuge Area, External Wall, Flat Grill, Tower Lobby, Staircases, Basement 1,
Basement 2, or Others — Others requires typing in what the location is).

**Duplicate protection:** the app blocks creating a task that exactly
matches an existing *active* (not yet Approved) task — same work location,
tower, flat number, and scope of work. Once a task is Approved, logging an
identical one again later (e.g. a future repaint) is allowed — the block
only prevents accidental double-entry while something is still in progress.

The **task register table's column headers are sortable** — click any
column to sort by it, click again to reverse the order. This works the
same way for both the PM and the inspector, since it's the same table.

Photos can be attached at task creation, when sending for inspection, and
during approval or rework — so the full visual history of each task lives
in its activity trail.

## How sign-in works

No individual accounts — three shared access codes:
`STAFF_ACCESS_CODE` for the project manager / estate office side,
`CHECKER_ACCESS_CODE` for residents and RWA committee members, and
`ADMIN_ACCESS_CODE` for administrators. Everyone types their own name at
sign-in, and checkers additionally pick who they're acting as (Resident /
RWA Committee Member / Estate Office Staff), which is what shows up in the
activity trail on every action.

**Admin** can do everything staff and checkers can (create tasks, send for
inspection, approve, return), plus two things they can't: bypass the normal
workflow order (e.g. approve a task straight from "Assigned to Contractor"
without it ever going through inspection), and directly edit any field or
force a task's status via a dedicated "Admin — edit or override" panel on
every task's detail view — including tasks that are already Approved. Every
admin action is still logged in the task's activity trail. Treat
`ADMIN_ACCESS_CODE` as the most sensitive of the three codes.

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
