# Backup and restore test

Run once before any real patient data, then on a schedule. Record the date and result at the bottom.

## What to confirm first
- Which automated backups your Supabase plan includes, and how long they are kept (check the plan page; do not assume).
- The region of the project (India residency decision).

## Restore drill (portable, works on any plan)
1. Take a dump of the hosted database:
   `supabase db dump --linked -f backup.sql`
   `supabase db dump --linked --data-only -f backup-data.sql`
2. Start a scratch local database: `supabase start` in a clean checkout.
3. Apply the schema and restore data: `supabase db reset`, then load `backup-data.sql` with `psql`.
4. Check: row counts per table match the source, and `supabase test db` passes.
5. Delete the dump files. They contain patient data.

## Record
| Date | Who | Source | Result |
|---|---|---|---|
|  |  |  |  |
