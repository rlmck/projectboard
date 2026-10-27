# Wall-screen mode screenshots

The wall-screen mode (`/?wall`, `app/wall.js`) at 1280×720, and the phone app at 390×844 before and after the change (identical pixel for pixel). Taken on 27 Oct 2026 in headless Chromium against a local copy of `app/`.

**All data here is fake.** Supabase wasn't reachable from the session, so Playwright answered for it: problems named "Sample: …", setters "Setter A"…, climbers "Climber A"…. The repo is public: never commit screenshots with real nicknames.

| File | What |
|---|---|
| `01-main-problem-selected.png` | Problems (`pb-v118` layout): the grade rail, the list jumped to 6B, a problem chosen, outlines over the dimmed board |
| `02-after-cast-toast.png` | Just after **Light it up**: the button reads Sent, the toast "Cast: …" |
| `03-ranks.png` | Ranks, read-only: Points and the Pat Burner |
| `04-get-the-app.png` | Get the app: the `/scan` QR |
| `05-idle-slide-get-the-app.png` | Idle slide 1: the QR |
| `06-idle-slide-pat-burner.png` | The Pat Burner's top 5: an idle slide until `pb-v118`, now out of the rotation |
| `07-idle-slide-featured-benchmark.png` | Idle slide 3: the benchmark of the day |
| `08-night-mode.png` | Night (clock faked to 23:30): the dimmed QR |
| `09-offline-fallback.png` | Supabase unreachable: the saved list, the note, casting off (`pb-v118` layout) |
| `10-phone-before-*.png` / `11-phone-after-*.png` | The phone app before and after (Problems, detail, Ranks) |
| `options/` | Mockups of three layouts for the problem list (27 Oct 2026, `options/README.md`) |
