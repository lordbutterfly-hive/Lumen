"""Serving entry points — code that runs continuously, handling requests, as
opposed to :mod:`recsys.jobs` (code that runs on a schedule). See ``app.py``
for the HTTP entry point (A10): ``GET /feed?viewer=<account>`` -> a real,
ranked feed."""
