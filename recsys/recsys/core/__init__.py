"""Pure ranking core (sections 3-8): no database driver, no I/O - depends only
on :mod:`recsys.contracts`, :mod:`recsys.config`, stdlib, and numpy. Fully
unit-testable without a live HAFSQL/Postgres connection."""
