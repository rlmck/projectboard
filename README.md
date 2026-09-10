# `legacy` — the old address, retired

This orphan branch is what GitHub Pages serves at **https://rlmck.github.io/projectboard/**
after the move to **https://symmetryboard.co.uk**. It is not the app. The app lives on `main`.

- `index.html` / `404.html` (identical): in a normal browser tab they redirect to the same
  path on symmetryboard.co.uk with `?src=moved`, keeping the `#hash`. Inside the old
  installed app they show a "Project Board has moved" screen instead. There's
  deliberately no manifest link, so the old address can't be installed again.
- `sw.js`: a tombstone with the same name and scope as the old app's service worker.
  Old installs pick it up on their next launch; it deletes the old `pb-v*` caches and
  keeps the moved screen available offline.
- `.nojekyll`: serve the files as-is.

**Never delete this branch, and never turn GitHub Pages off.** Old installs and old
links depend on it. Free GitHub Pages needs a public repo, so the repo stays public.
See `docs/rollout-plan.md` on `main` (Part C).
