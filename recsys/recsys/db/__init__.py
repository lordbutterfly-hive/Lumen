"""recsys's own Postgres: schema (``schema.sql``) + persistence (``store.py``)
for state that must survive a process — trust snapshots today. Separate from
``recsys.io`` (the read-only HAFSQL mirror gateway) because it is a different
database with different credentials (``RECSYS_DATABASE_URL``), not a
different query shape of the same one."""
