# Cast contract

> **Read by section, not whole** (53 KB): `grep -n '^##' docs/cast-contract.md` for the map, then only the sections your task touches (`docs/token-audit.md`).

How a cast gets from the app to the LEDs. **This describes what the code does** (first written 19 Oct 2026; circuits added 30 Oct 2026, §8; the live preview while setting 30 Oct 2026, §9; a circuit's static view 2 Nov 2026, §8.7). Anything the code doesn't settle is under "Open questions"; nothing there is decided. Any change to the channel, event or payload must update this file in the same commit. The repo is public: no secrets here.

## 1. Overview

```
PWA (phone, later the wall kiosk) ──HTTPS POST──▶ Supabase Realtime ──broadcast──▶ Pi listener ──SPI──▶ WS2801 strip
                                                  (no database write)            (pi/listener, 26 Oct)
```

## 2. Transport

| | |
|---|---|
| Supabase project | `uqirowyfqwiceyjznosl` (`https://uqirowyfqwiceyjznosl.supabase.co`) |
| Mechanism | Realtime **Broadcast** (not Postgres Changes, not Presence) |
| Channel topic | `board:HangoutPortland` (`HangoutPortland` is also `board_config.wall`) |
| Channel type | public: no `config.private`, no Realtime Authorization policies |
| Events | `cast_problem` (a problem, §3), `cast_circuit` and `stop` (a circuit run, §8), `show_circuit` (a circuit's holds, all lit at once, §8.7), `preview_holds` (the holds being set, lit live, §9) |
| Persistence | none. Only listeners connected at that moment receive it; nothing is stored or replayed |
| Database writes per cast | none (a signed-in climber's circuit run is logged by the app, §8.5, not by the cast) |

## 3. Payload

```json
{ "problem_name": "Good Bug", "source": "phone", "signed_in": false }
{ "problem_name": "Good Bug", "mirror": true, "source": "wall", "signed_in": false }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `problem_name` | string | yes | `problems.name` exactly as stored. Unique, 1–60 characters, no grade in it. |
| `mirror` | boolean, always `true` when present | no | Sent only when the mirrored view is on screen. Absent means not mirrored; the app never sends `false`. |
| `source` | `"wall"`, `"phone"` or `"console"` | no | Where the cast was sent from: the wall kiosk (`/?wall`), the app anywhere else (`"phone"`), or a PB Console test cast. Since 29 Oct 2026; for PB Console's Activity log only, never used for the LEDs. |
| `signed_in` | boolean | no | Whether someone was signed in when they cast. **Only that: never a user id or nickname.** Since 29 Oct 2026; Activity log only. |

`source` and `signed_in` are informational and unauthenticated (anyone with the anon key can send anything). The listener never refuses a cast over them: a missing or unknown value is logged as `unknown`. There are no other fields: no message id, timestamp, user, hold list, colours or version. A subscriber receives the usual broadcast envelope, `{ "type": "broadcast", "event": "cast_problem", "payload": { … } }`.

## 4. Sender: the PWA

- **Only path:** `castByName(name, btn, mirror, stillShowing)` in `app/problems.js`, called by the cast button on the problem detail view (wired in `app/app.js`) and by the wall screen (`app/wall.js`, the kiosk's `/?wall` mode), with the same payload. Circuits have their own path, `startCircuitCast()` (§8).
- **The wall screen casts on the pick (since 2 Nov 2026; no cast button on its Problems page):** a clean tap on a problem in the list picks it and casts it at once; a tap on the problem already picked casts it again; **Mirror** flips the view and casts that side (`mirror: true`), and flipping back casts it unmirrored; touching the "Benchmark of the day" idle slide picks and casts that problem; a save on the wall's Create picks and casts the new problem. A scroll, a drag (the finger moving more than 10 px) or the touch that stops a fling never casts. The wall sends **one cast at a time**: a tap while one is being sent waits, and a newer tap replaces it, so rapid taps send the first one still on screen and then only the latest, never a backlog. `stillShowing` is unchanged (same problem, same orientation, still on Problems, not idle), and nothing is sent offline. Outside the opening hours the wall screen is off altogether (the Pi stops the kiosk, §5), so it never casts then. The wall's cast always takes over the board (the listener shows the latest cast, §5), whatever is on it. Phones keep their Cast button.
- **Steps:**
  1. Geofence check (`ensureCastLocation`). It runs in the app only and is lenient: it blocks only a location fix that is confidently far from the gym. No location, a refused permission or a timeout all let the cast through, and admins skip it.
  2. If the problem or orientation on screen changed during the location wait, nothing is sent.
  3. `channel.httpSend('cast_problem', payload, { timeout: 10000 })`: one HTTPS POST to Realtime's broadcast endpoint. `apikey` is the public anon key (`app/state.js`), and `Authorization` carries the user's access token when supabase-js has one. Guests can cast.
- **What the user sees:** a 202 from Realtime → "Cast: <name>" (or "Mirror cast"). An error or timeout → "Cast failed — check connection". **Success means Supabase accepted the message, not that a Pi received it.**
- The app never subscribes to the channel and holds no WebSocket, except while someone is setting a problem with the live preview on (§9.4).
- **Other senders:** `tools/cast-test.html` ("Run checks", fake names `~cast-test-A` and `~cast-test-B`). Being a public channel, any client with the anon key can send.

## 5. Listener: the Pi

- **The listener is `pi/listener/pb_listener.py`** (systemd `pb-listener`, live since 26 Oct 2026 21:08; it replaced that day's stopgap `cast_listener.py`). What it does:
  - joins `realtime:board:HangoutPortland` with the anon key and checks the join reply;
  - sends a Phoenix heartbeat every 25 s; no reply for 60 s means a dead socket, and it reconnects with backoff from 1 s to 60 s, with jitter;
  - on `cast_problem`, checks the payload (§3: `problem_name` a string of 1–60 characters, `mirror` true or absent) and logs and skips anything else (every refused body is logged clipped to 200 characters, and frames over 64 KB drop the socket, since 14 Nov 2026);
  - a malformed envelope (a `payload` that isn't an object, an `event` that isn't a string) or a handler error is logged and skipped: the socket stays up (since 14 Nov 2026; it used to reconnect);
  - logs each cast with its origin, e.g. `cast received: 'Good Bug' mirrored [wall, guest]` (or `cast 'Good Bug' ignored: night mode [phone, member]`); the `[source, who]` part is left off when the app sent neither (before 29 Oct 2026). PB Console's Activity tab reads these lines;
  - looks the problem up by exact name over REST (one retry); an unknown name leaves the board as it is;
  - builds the frame by §6.2–6.5: roles are classified on the stored ids first, ids with no LED (not in the holds table, or footholds) are then dropped and logged, and with `mirror` each hold moves to its partner, keeping its role; the feet-rule light comes from `feet_mode` (§6.5), never mirrored. Brightness is 0.5, with a whole-frame current cap;
  - latest cast wins: a cast still being fetched when a newer one arrives is dropped;
  - loads the **holds table** (db/41: each hold's LED and mirror partner, §6.3–6.4) on every join and every 10 min, and keeps a copy in `/var/lib/projectboard/cache/holds.json`, used at once on the next start, so a boot with no network still lights every hold and mirrors; with neither, the formula (§6.4) lights the holds and a mirrored cast is skipped (as before 9 Nov 2026, when it read `board_config.mirror_map`);
  - **night mode = outside the opening hours** (since 7 Nov 2026; was 23:00–08:00): `HOURS_MON` … `HOURS_SUN` in the Pi's `config.env`, London time (default Mon–Thu 15:30–22:00, Fri closed, Sat–Sun 09:30–15:00), unless PB Console's "stay on until" override is going; day if the clock hasn't synced (`pi/README.md` → Opening hours). The strip fades out and casts of every kind are ignored (logged, not shown), while the socket stays joined; the wall screen is off;
  - **idle (an idle pattern, Glisten by default):** `IDLE_AFTER_S` after the last cast (15 min by default since 2 Nov 2026, was 20; every problem cast, from any source, restarts it), and on start or at opening time, the problem crossfades (1.5 s) into an ambient animation (`IDLE_PATTERN`: one of ten patterns, or a cycle; `pb-idle` on the Pi tries them live; the teaser pattern reads the benchmark problems, unmirrored, every half hour); a cast cuts straight in. With `IDLE_ANIMATION=off` the strip is cleared instead. At night everything fades to black over 3 s. Details in `pi/README.md`;
  - on `cast_circuit` and `stop`, runs and ends a circuit (§8);
  - on `show_circuit`, lights a circuit's holds all at once, shown as a problem cast (§8.7);
  - on `preview_holds`, lights the holds someone is setting, live (§9);
  - clears the strip on stop. It sends no reply, so a cast at night or with the Pi down still shows "Cast: X" in the app (§7 item 2);
  - health checks, watchdogs and deploy are in `pi/README.md`.

  The June 2026 Pi 3 listener and the stopgap are kept locally for reference only.
- `tools/cast-test.html` (served by `python tools/serve.py`) subscribes like a listener and logs every cast with its payload.
- **What a listener can read with the anon key** (public-read RLS):
  - `problems`: `name`, `start_holds`, `intermediate_holds`, `finish_hold`, `feet_mode`
  - `holds` where `wall = 'HangoutPortland'` (db/41): `id`, `name`, `kind`, `led`, `mirror`
  - `board_config` where `wall = 'HangoutPortland'`: `mirror_map` (pb-ledmap's mirrored problems; the listener reads the holds table since 9 Nov 2026)
  - `circuits`: `hold_sequence`, `start_count`, `loops`, `led_track` (§8.6)
- **What the old listener did** (a description, not a requirement):
  - subscribed with the anon key;
  - on a cast, selected the row `where name = problem_name` and built the order in §6.2;
  - loaded the mirror map from `board_config` on each connect;
  - cleared the strip, then lit the holds;
  - processed casts one at a time;
  - sent no reply;
  - switched both relays on at start.

## 6. From a problem to LEDs

### 6.1 Hold ids
- **Format:** `holdN`. The grid is 19 columns (A–S) × 13 rows, numbered row by row from the **bottom-left**: `hold1` = A1, `hold19` = S1, `hold20` = A2, `hold247` = S13. Row 1 is the bottom of the wall.
- **The holds table** (db/41, 9 Nov 2026): one row per hold per board, `id` (as stored in problems), `name` (visible: A1–S13; footholds will be FT1, FT2…, left to right from the bottom row), `kind` (`hand`, `foot`, `feet_sign`), `led` (null only for a foothold), `x`/`y`/`outline` and `mirror`. Seeded from the live board: 188 hand holds plus the two feet signs; `tools/check_holds.py` checks it against everything below. Since db/42 (9 Nov 2026) the table is the source of positions, outlines and mirror partners too (`board_config`'s `hold_map` / `mirror_map` / `hold_shapes` are copies made from it, hand holds only), written by the admin board setup flow; it never changes `led` (hand holds keep their LEDs until camera mapping, session 2b). Footholds (`footN`, named `FTn`) have no LED, so the listener lights nothing for them; a foothold's mirror partner is always a foothold, so a mirrored cast never moves a hand hold onto one.
- **Allowed values:** the database CHECK allows `^hold[0-9]{1,3}$` in the hand hold lists. Live data uses `hold1`–`hold246`. 188 grid cells have real holds (189 until db/32 on 28 Oct 2026 removed `hold218`, I12, which was never a hold: its LED 116 is behind the board).

### 6.2 Order and roles (holds are stored inverted)

```
order  = [finish_hold] + intermediate_holds + start_holds
starts = order[0], order[1]   → green
finish = order[-1]            → red
others                        → blue
```

- This is `problemHoldOrder()` and `classifyHolds()` in `app/core.js`, and it equals the original system's hold list.
- A problem with one start stores it twice.
- Colours: start green `(0,255,0)`, intermediate blue `(0,0,255)`, finish red `(255,0,0)`. These are from Gareth's `DisplayProblem.py`, and the app's overlay uses the same three.

### 6.3 Mirroring
- With `mirror: true`, each hold becomes its partner, `holds.mirror` (`board_config.mirror_map` is a copy of the hand holds' pairs, made from the table since db/42). A hold with no partner, or its own, stays in place.
- Roles don't change.
- The live table differs from the original system's `MirrorDic.txt` in 5 entries among real holds (E3, E4, E5, O5, O6). The app uses the live table. (Before db/32 on 28 Oct 2026 it differed in 7 more, from three shifted hold labels; those are now Gareth's pairs: K9↔I11, N13↔F13, O13↔E13.)

### 6.4 Hold → LED index
**Since 9 Nov 2026 (db/41) the listener reads each hold's LED from `holds.led`** (`board.hold_led()`), not the formula. The table was seeded with the formula's values and `tools/check_holds.py` (plus `pi/tests/test_holds.py`) checks they agree for every hold, so every cast lights exactly the LEDs it lit before. A foothold has no LED and lights nothing; an id not in the table lights nothing. The formula is still the fallback before the table has ever loaded, and the grid the idle patterns and pb-ledmap's cell tools draw on.

Gareth's formula, from `SearchingByProblemName.py`; the same values are in `tools/led_map.json` (generated by `tools/register_leds.py`; checked equal for all 247):

```
x = (N - 1) % 19          # column, 0 = A
y = (N - 1) // 19         # row, 0 = row 1 (bottom)
led = x*13 + y + 1        if x is even   (A, C, E … run up the wall)
led = x*13 + (13 - y)     if x is odd    (B, D, F … run down)
```

- Holds 1–247 map one to one onto LEDs 1–247.
- LED 0 is never used. It exists, but it's mounted behind the board, out of sight.
- Strip: WS2801 on SPI0 (`/dev/spidev0.0`), 1 MHz, mode 0, MSB first, 3 bytes per pixel in R, G, B order.
- Gareth's code also drove BCM 23 and 24 LOW at start-up to switch two relays on. The new box has no relays yet (a 2-channel module is on order), so nothing drives those pins now.
- **Status: verified on the wall on 26 Oct 2026** (Pi 4, temporary wiring, the live app casting through the stopgap listener):
  - Colour order is **R, G, B**.
  - **Pixel 0 exists** (behind the board). **Pixel 1 is A1**, and column A runs **up** the wall, as the formula says.
  - Problems cast from the app light the holds the formula predicts.
  - The 3.3 V SPI signals from the Pi drive the strip directly, without a level shifter (a 74AHCT125 is on order for the final box).
  - The strip's 4-way cable: **blue = 5 V, black = GND, green = data (Pi pin 19, MOSI), red = clock (Pi pin 23, SCLK)**. The two 8-way plugs are power feeds into the strip (5 V on one, GND on the other), not signals; they're not connected yet, so the far end of the board drops voltage and shows the wrong colours on bright frames.
  - **Not yet checked:** mirrored casts.
- **Mapped on the wall on 28 Oct 2026** with `pb-ledmap` (`pi/README.md` → "LED mapping"): every real hold lights the LED the formula gives, so every column runs the way it says (B, D … down). The three mismatches found were app labels, not LEDs, fixed in the board data by db/32 and rechecked on the wall after the deploy, along with the B1/B2 feet-indicator lights (LEDs 26 and 25).

### 6.5 Feet rule (decided 30 Oct 2026)
- Two signs at B1 and B2, which aren't holds: the original settings file names `hold21` (B2, **LED 25**) "Orange" and `hold2` (B1, **LED 26**) "Black". "Red" and "orange" feet mean the same thing.
- Every problem has a **feet rule** in `problems.feet_mode` (CHECK: `any`, `orange`, `black`, `specific`; default `any`):

  | `feet_mode` | Meaning | Lights |
  |---|---|---|
  | `any` | Any feet | neither sign |
  | `orange` | Orange feet only | LED 25 (B2) |
  | `black` | Black feet only | LED 26 (B1) |
  | `specific` | Specific feet (db/41, 9 Nov 2026): the footholds in `problems.feet_holds` | **nothing**: shown in the app and on the wall screen only |

- The lit sign is **blue** `(0,0,255)`, the colour Gareth's code gave it (it lit the signs as intermediates).
- **The listener reads `feet_mode`** with the problem (`pi/listener/board.py`, `FEET_LIGHTS`). `hold2`/`hold21` in a hold list are skipped, never lit. The payload doesn't change: the rule travels with the problem row, like its holds.
- **Specific feet** (db/41; the app's UI since 10 Nov 2026): `problems.feet_holds` lists 1–30 footholds, each a `foot` hold of this board (`problems_guard_feet` checks it; any other rule empties the list). The board never lights them and lights no sign; the listener treats `specific` like `any`, mirrored or not (`pi/tests/test_holds.py`, `test_specific_feet_as_the_app_saves_it`). The app never puts a foothold in a hand hold list. The payload doesn't change.
- **Never mirrored:** the signs are fixed to the wall, so a mirrored cast lights the same sign. Neither id is in `board_config.mirror_map`, and no hold mirrors onto them (`pi/tests/test_board.py`, `Feet`).
- **Data:** before db/33 the rule lived only in migrated problems' hold lists (Gareth's lists carried the signs just before the finish; the old notes say both on = any feet). db/33 set `feet_mode` from them (only `hold2` → `black`, only `hold21` → `orange`, both or neither → `any`: 26, 19 and 220 problems on 30 Oct 2026) and took `hold2`/`hold21` out of every hold list. Neither was ever a start or the finish, so no problem's roles changed.
- **The app:** Create and Edit offer the rule as three options (Any feet by default); tapping a foothold makes the problem Specific feet (no fourth option; overview §4.8a). The problem view (phone and the wall's chosen problem) shows a badge when it isn't Any ("Specific feet (4)"), the info sheet always shows it, and Specific feet's footholds are outlined in yellow (as their foot partners when mirrored). The app never draws the signs on the board.

## 7. Open questions

Nothing below is decided.

1. ~~**Clearing the board:** there's no clear, stop or off event. Gareth's code kept the last problem lit and ran a rainbow after 30 minutes idle. What should the new Pi do?~~ Answered on the Pi side (27 Oct 2026): a cast stays lit for `IDLE_AFTER_S` (15 min since 2 Nov 2026; 20 before), then the Glisten idle animation takes over (§5). There's still no clear or stop event from the app.
2. **Pi offline:** the cast is lost and the app still reports success. Should the app know whether a listener is online (presence or a heartbeat)?
3. **Acknowledging receipt:** there's no Pi → app message. Is one wanted, and on what channel or event?
4. **Stale, duplicate and rapid messages:** casts carry no id or timestamp. Debounce or rate-limit on the Pi? What about a cast arriving while one is still being drawn?
5. **Problem lookup:**
   - ~~Is the name still the key once problem names can be edited, or should casts carry the id?~~ Answered 8 Nov 2026 (§10): **the name stays the key.** Names (problems and circuits) are editable through Edit, and the listener looks every cast up by name when it arrives (no cache), so the next cast after a rename uses the new name. No Pi change.
   - What happens for an unknown name? The board is left as it is and the listener logs it (§5). That's also what a phone still showing the old name gets until it reloads the list (§10).
   - Exact match, or trimmed? Exact; the app stores names trimmed, and checks them unique ignoring case before saving.
6. **Mirroring:** does the Pi fetch `board_config.mirror_map` (and when it refreshes), or does the app send resolved holds?
7. ~~**Feet indicators:** light `hold2`/`hold21` when listed (as Gareth's code did), or from `feet_mode`? Which colours? What do both lights on mean?~~ Decided 30 Oct 2026 (§6.5): from `feet_mode` (Any feet / Orange feet only / Black feet only); Any lights neither sign; the lit sign is blue, as before; both-on in the old data meant Any.
8. **Colours:**
   - Keep the original green, blue and red?
   - Any colour for foot holds?
   - Which role wins when a hold is listed twice?
9. **Brightness:** cap in software for the 5 V 10 A supply? If so, what budget?
10. **Hold ids outside 1–247** (allowed by the database): ignore them? Log them?
11. **Hardware** (most of it answered on 26 Oct 2026; details in §6.4):
    - ~~Is there a pixel 0?~~ Yes, behind the board; never lit.
    - ~~What is the colour order?~~ R, G, B.
    - ~~Does the strip start at A1?~~ Pixel 1 = A1, running up column A.
    - ~~Which wire is which in the 16-wire harness?~~ The 4-way cable carries 5 V, GND, data and clock; the two 8-way plugs are 5 V and GND power feeds.
    - ~~Does column B run down?~~ Yes: the whole board was mapped on 28 Oct 2026 (§6.4).
    - Still open: what did each of Gareth's relays switch, and what will the new relays switch?
12. **Start-up and idle behaviour** of the Pi: before the first cast, and from 15 minutes after the last one (20 until 2 Nov 2026), the idle pattern runs (§5; 27 Oct 2026). Still open: the relays.
13. ~~**Circuits:** a design spec plans `cast_circuit` and a `stop` event on the same channel.~~ Built 30 Oct 2026 (§8).
14. ~~**The wall kiosk** will cast through the same PWA and channel. Does it need anything different?~~ No (27 Oct 2026): it casts as a guest through `castByName()`. Its Chromium runs with `--deny-permission-prompts`, so the location check fails at once and lets the cast through, instead of waiting on a permission bubble nobody answers. It turns casting off while it has no connection; outside the opening hours the Pi turns the screen off (since 7 Nov 2026; until then the page showed a dimmed night screen 23:00–08:00).
15. **Who may cast:** anyone, by decision. Does the Pi apply any checks of its own?

## 8. Circuits (built 30 Oct 2026)

A circuit cast runs a timed animation on the Pi: the phone sends one message to start and one to stop, and the Pi works out every frame itself.

### 8.1 `cast_circuit`

```json
{ "circuit_name": "Pat Burner", "interval": 3, "laps": 3, "run": "9f2c41d07ab3e855",
  "source": "phone", "signed_in": true }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `circuit_name` | string | yes | `circuits.name` exactly as stored (UNIQUE, 1–60 characters). |
| `interval` | number | yes | Seconds a move. The app sends 5, 3 or 2 (Slow, Med, Fast); the listener accepts 1–10 and ignores anything else. |
| `laps` | integer, 0–10 | no | **Since 5 Nov 2026; the app sends it since 14 Nov 2026** (the Cast sheet's Loop = `0`, or 1–10 laps). `0` = loop until stopped (endless); `1`–`10` = that many laps. **A circuit whose `loops` is false always runs 1 lap**, whatever is sent (the app sends `1` for it and offers no Loop). Anything else (not an integer, out of range, a boolean, `3.0`) and the listener warns and ignores the cast, as a bad `interval`. |
| `loop` | boolean | no | The old way to ask, honoured only when `laps` is absent (apps cached from before 14 Nov 2026): `true` = endless (0), `false` = 1 lap; `loop` absent too = the circuit's `loops` (`true` → endless, `false` → 1 lap). With `laps` present it's ignored. The app still sends it beside `laps` (`true` exactly when `laps` is 0), only for a listener from before 5 Nov 2026, which doesn't read `laps`; keep accepting both. |
| `mirror` | boolean, `true` when present | no | Mirror every hold through its partner in the holds table (`holds.mirror`), as §6.3. **No mirrored circuits for now** (Ross, 30 Oct 2026: a future release): the app never sends it; the listener would honour it. |
| `run` | string, 1–64 characters | no | A token naming this run (the app sends 16 random hex characters). `stop` uses it. A cast whose token was stopped in the last 2 minutes is ignored (its `stop` overtook it, §8.2). |
| `trace_s` | any | no | **Ignored since 5 Nov 2026** (there's no route trace any more, §8.3), and never warned about. It was the seconds of route trace before the countdown (1–4 Nov 2026); old cached apps may still send 3. |
| `source`, `signed_in` | | no | As §3: the Activity log only. |

### 8.2 `stop`

```json
{ "run": "9f2c41d07ab3e855", "source": "phone", "signed_in": true }
```

Ends the running circuit if its token matches; with no `run`, ends any running circuit. A stop for another run, or with nothing running, does nothing (a problem cast that has since cut in stays lit). The board then crossfades into the idle pattern. `run`, when sent, must be a string of 1–64 characters, or the stop is logged and ignored.

**A stop is remembered for 2 minutes (since 14 Nov 2026):** the token (at most 50), or, with no `run`, the time it came. So a stop that lands while the listener is still reading the circuit (before 14 Nov the run then started anyway), or that overtakes its own `cast_circuit`, still wins: that circuit never starts, logged `circuit 'Name' not started: stopped while it was fetched, run <token>` (or `its stop arrived first`). A stop with no `run` cancels only circuits received before it.

### 8.3 What the Pi shows (`pi/listener/circuit.py`)

The look is **"map and next hold"**, agreed by Ross on 5 Nov 2026 (it replaced direction 4, "Pulse and fade", and all the circuit-track lighting of §8.6). `tools/circuit-led-simulator.html` is a port of it (its `runFrame()` is `Run.layers()`): change both together.

- The listener reads `name, hold_sequence, start_count, loops` from `circuits` by exact name (one retry); an unknown name leaves the board as it is, and so does a run whose `stop` came while it was read (§8.2). The sequence is in climbing order (not inverted). Ids off the grid and the feet signs (`hold2`/`hold21`) light nothing but keep their place in the timing. The laps come from the cast and `loops` (§8.1).
- **The map:** every hold of the circuit **blue at `CIRCUIT_MAP_LEVEL`** (0.20) for the whole countdown and run. **The finish** (the last hold of the sequence) is **red at `CIRCUIT_FINISH_LEVEL`** (0.60), but only on the **final lap** of a run with a set number of laps: a 1-lap run shows it from the countdown on; an endless run never shows red.
- **Countdown, 5 s:** the start holds (`start_count`, 1 or 2) are green and **blink once a second**: full for 0.08 s, then a linear fade to off over the next 0.8 s, then off until the next second. The map and the finish stay steady underneath.
- **Then one move every `interval` s.** Only **the hold to go to** is lit green, full and solid, over the map. Start holds are blue in the run, on every lap.
- **A match** (the hold to go to is one the climber is already on: hold c or c-1, where c is the last reached): its green **blinks twice at the start of its beat** (off 0–0.15 s, on 0.15–0.30 s, off 0.30–0.45 s, then on for the rest of the beat). The beat is still one interval; the next hold doesn't go green until the next beat.
- **Laps:** lap 1 begins on the start holds, so its moves go to positions `s` … `L-1`; every later lap goes all the way round, from position 0 (the wrap move) to `L-1`. A run of N laps is `(L - s) + (N - 1) × L` moves and ends on position `L-1`. The last move goes to the finish (green, as any hold to go to).
- **The top** (a set number of laps): the finish blinks red three times (the countdown's blink, one a second, off between), then the map fades to off over 1 s, and the run is done (4 s in all). **Endless** runs until `stop`, a problem cast, another circuit, night, or `CIRCUIT_MAX_S` (30 min by default), then idle. The app's run screen (phone and wall) ends an endless run at 30 min too (`CAST_RUN_MAX_S` in `circuits.js`, 12 Nov 2026), so a forgotten run on the wall doesn't count on for ever; keep the two in step.
- A blink is drawn over what's under it, `colour × a + under × (1 − a)`, so the blue map shows through as the green fades.
- Mirrored runs mirror every hold through the holds table's partners (`holds.mirror`, §6.3; since 9 Nov 2026, not `board_config.mirror_map`). No mirrored circuits in the app for now.
- Brightness and the current cap are a problem cast's (`BRIGHTNESS`, `POWER_BUDGET_MA`); the levels above are before `BRIGHTNESS`. Frames at `IDLE_FPS`. Night ignores circuit casts and ends a run, as it does problems. Latest cast wins across problems and circuits.
- **Config keys** (`config.env`, `mode.py` DEFAULTS, PB Console's Config tab; a listener restart applies them): `CIRCUIT_MAP_LEVEL` 0.05–0.6 (0.2), `CIRCUIT_FINISH_LEVEL` 0.1–1.0 (0.6); a bad value is warned about and the default used. `CIRCUIT_GHOST`, `CIRCUIT_TRACK_RUN` and `CIRCUIT_TRACK_LEVEL` are gone.
- Log lines: `circuit received: 'Name', 3 s a move, 3 laps [phone, member]` (`endless`, `N laps`, or "the circuit's loop setting" when neither `laps` nor `loop` was sent), `circuit started 'Name': 12 holds, 34 moves, 3 s a move, 3 laps, run <token>, in 300 ms` (`moves until stopped, …, endless` for an endless run), `stop received: run <token> […]`, and when the run ends, for any reason, one self-contained line that PB Console's Activity reads: `circuit ended: 'Name' stopped after 23 moves (74 s), 3 s a move, endless, run <token> [phone, member]` (how: `stopped`, `finished`, `replaced`, `night`, `time limit` or `sent to idle`; `endless` or `N laps` since 5 Nov 2026, `loop` or `once` before, and the console reads both). A circuit cast at night logs `circuit 'Name' ignored: night mode […]`.

### 8.4 The app (`app/circuits.js`, and the wall screen)

- **Cast** beside the circuit's title opens a sheet: speed (Slow 5 s / Med 3 s / Fast 2 s, remembered on the device as `pb-circuit-speed`), and **Start on the board**. A circuit that loops also gets **Loop** (on by default: endless, `laps: 0`) and, with Loop off, a **Laps** stepper (1–10, from 1); a circuit that doesn't loop gets neither and always sends `laps: 1` (since 14 Nov 2026; before, Loop could be switched on for it, and the phone counted for ever while the Pi ran one lap). The run screen counts the same moves as the Pi, `(L − s) + (N − 1) × L` for N laps (§8.3), with "lap n of N". The same lenient geofence as a problem (`ensureCastLocation`, admins skip it), then `channel.httpSend('cast_circuit', …)`.
- Once Realtime accepts it, the sheet is the run screen: the countdown with beeps, then the move count (and lap), and a big **Stop**, which sends `stop` with the run's token. The phone keeps its own clock from that moment (plus 0.25 s for the Pi's read), so it stays right after the screen sleeps; the screen is kept awake while it runs. The sheet can't be closed while a run is going. After Stop, the done pane offers **Lights still on? Stop them** for 10 s (it sends the same `stop` again: Realtime taking a stop isn't proof the board got it). "Go again" starts a new run.
- **The wall screen** (`/?wall`, since 30 Oct 2026) has a Circuits page: the list and the chosen circuit over the board (dimmed all over when none is chosen). Since 2 Nov 2026 a tap on a circuit lights all its holds at once (`show_circuit`, §8.7), and **Start circuit** (was "Light it up") opens the same sheet (`openCircuitCast(c)`), sent with `source: "wall"`. The wall doesn't go idle while a run is going; at closing time the Pi ends the run and stops the kiosk.
- As with problems, a sent cast or stop means Realtime accepted it, not that the Pi received it (§7 items 2 and 3).

### 8.5 The logs

- **Runs:** when a run ends on the phone (Stop, or the top of a run done once), a signed-in climber's run with at least one move is inserted into `circuit_logs` (`user_id`, `circuit_id`, `moves`, `looped`, `speed` = seconds a move; own-rows RLS, db/14). A move is one LED advance, counted across laps. Guests aren't logged. Nothing in the app reads it yet (Phase 3 is PBs and leaderboards). **"Done" is a problems-only idea** ("done both sides", the problems' Exclude Done): the circuits list has no Done filter (Ross, 30 Oct 2026; circuits may get one in a future release).
- **Who cast (db/34, 30 Oct 2026):** the broadcasts never say who (the channel is public: anyone with the anon key can listen). After a problem or circuit cast Realtime accepted, a signed-in member's app inserts one private row into `cast_log` (`kind`, `name`, `mirror`, `source`, `run`; insert-only, nobody can read it through the API) with `logCast()` in `problems.js`. PB Console's Activity reads it over direct Postgres and puts the member's nickname on the matching journal line: a circuit by its `run` token, a problem by name within 2 minutes.

### 8.6 Circuit tracks (built 1 Nov 2026; not lit since 5 Nov 2026)

A circuit can carry a **track**: for each move, the ordered LEDs between one hold and the next. Ross designed it in `tools/circuit-trace-demo.html` ("Train track"); his Pat Burner track is `tools/circuit-tracks-pat-burner.json`. **Since 5 Nov 2026 the Pi doesn't draw tracks** (no route trace, ghost or run track: §8.3's look replaced them). The column and the check stay, so a track can be used again later; PB Console's editor was removed on 10 Nov 2026 (it's in git history).

**Data:** `circuits.led_track` jsonb (db/37), null = no track:

```json
{ "version": 1, "moves": [ { "move": 7, "from": "hold235", "to": "hold206", "cells": ["hold203", "hold185"] } ] }
```

- `move` is 1-based: `from` = `hold_sequence[move-1]`, `to` = the next hold, wrapping to the first (the wrap move, `move` = the length). `cells` are `holdN` grid cells ordered from `from` to `to`; each would light LED `led_index(N)` (§6.4). Every non-match move is stored, edited or not; a match (`from` = `to`) has none.
- A CHECK pins the shape (an object, `version` 1, a `moves` array) and 32 KB. Public read like the rest of `circuits`; nobody writes it through the API (the `circuits_guard_track` trigger keeps it from `anon` and `authenticated`, as db/30 does `comment`). Since 10 Nov 2026 nothing writes it (PB Console's Circuit tracks tab, which did over direct Postgres, was removed).
- It was checked move by move by `check_track()` in `pi/listener/circuit.py` for PB Console's save; with the console's tab gone nothing called it, and it was deleted on 14 Nov 2026 (in git history: the move number in range and not twice, `from`/`to` equal to the circuit's `hold_sequence` now, at most 40 grid hold ids a move, never the feet signs). The listener doesn't read `led_track`.

**PB Console** had a Circuit tracks tab (edit, preview, import, save, a test cast) until 10 Nov 2026; it's in git history.

### 8.7 A circuit's static view: `show_circuit` (built 2 Nov 2026)

On the wall screen's Circuits page, a tap on a circuit lights the whole route at once, so climbers can see it on the wall before they start. No animation, no countdown; **Start circuit** is still the run (§8.1).

```json
{ "circuit_name": "Pat Burner", "source": "wall", "signed_in": false }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `circuit_name` | string | yes | `circuits.name` exactly as stored (1–60 characters). |
| `source`, `signed_in` | | no | As §3: the Activity log only. |

No `mirror` (no mirrored circuits, Decisions) and no other fields. Why a new event (Ross agreed, 2 Nov 2026): `cast_problem` looks names up in `problems` (a circuit could share a problem's name), and `preview_holds` has a 60 s timeout, a takeover that needs Show on board and comes back after a run, and trusts the sender's holds; `show_circuit` reads the circuit by name like `cast_circuit`.

**Colours** (`circuit.static_frame()`, the same rule as the app's `circuitHoldRoles()`, so the board matches the screen): each distinct hold in `hold_sequence` (climbing order, not inverted) lights once, in its strongest role across its places in the sequence. The **last** hold is the finish, red; the first `start_count` (clamped to 1–2, as a run) are starts, green; the rest are moves, blue (§6.2's colours). **Finish beats start beats a move**, as for a problem (`board.RANK`): a hold that's both a start and the last hold (a circuit ending where it began) is red, and a start repeated later in the sequence stays green. A repeated hold (a match, a loop past it) is lit once. `loops` changes nothing: it's the route's map, not the run (in a looping run the last hold isn't a finish). The feet signs and ids off the grid light nothing. No ghost or track.

**On the Pi** it's shown exactly as a problem cast (the renderer's `cast` state): the cast brightness and current cap; latest cast wins (a problem cast, a phone's cast, a circuit run or another view replaces it, and it replaces a run, logged `circuit ended: … replaced`); a preview going is taken over; the idle pattern `IDLE_AFTER_S` after it; ignored at night. An unknown name leaves the board as it is. Log lines: `circuit view received: 'Name' [wall, guest]`, `lit circuit 'Name': N LEDs, ~M mA in T ms`, and at night `circuit view 'Name' ignored: night mode […]`. PB Console's Activity lists them ("holds lit"); `last_cast_at` is set, so the deploy busy check counts it.

**The app** (`showCircuitByName()` in `circuits.js`, called by `wall.js`): only the wall screen sends it. Opening the Circuits page sends nothing and leaves the board as it is; a clean tap on a circuit (the Problems page's tap rules) picks it and sends `show_circuit`; a tap on the circuit already picked sends it again. The same lenient geofence first, then only if the same circuit is still on screen; one at a time, the latest tap next. A listener from before this ignores the event (nothing lights), so either side can be deployed first.

## 9. The live preview while setting (built 30 Oct 2026)

While someone sets a problem (the phone's Create, an admin's Edit, or the wall screen's Create page), every change lights the board in a cast's colours, so the setter sees the holds on the wall as they tap them. Nothing is stored: the problem is saved by the app as usual.

### 9.1 `preview_holds`

```json
{ "session": "4be1c0a9d2f37e65", "start": ["hold10", "hold3"], "hold": ["hold105"], "finish": ["hold212"],
  "feet": "orange", "first": true, "source": "phone", "signed_in": true }
{ "session": "4be1c0a9d2f37e65", "end": true, "source": "phone", "signed_in": true }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `session` | string, 1–64 characters | yes | A token naming this setting session (the app sends 16 random hex characters). |
| `start`, `hold`, `finish` | arrays of hold ids | no (empty when absent) | The **whole current selection**, as set: start (at most 2), intermediate, finish (at most 1); at most 100 holds in all. **Not stored inverted** (unlike a problem row, §6.2) and never mirrored. Never a diff, so a lost message is corrected by the next. Ids off the grid and the feet signs (`hold2`/`hold21`) light nothing. |
| `feet` | `"any"`, `"orange"`, `"black"` or `"specific"` | no (`any`) | The feet rule being set: lights the sign as §6.5 (`specific` lights none; the listener before 9 Nov 2026 ignored a message with it). The app sends `specific` since 10 Nov 2026 while footholds are picked; the footholds themselves are never sent, and tapping one sends nothing unless it turns a sign off. |
| `end` | `true` | no | The session is over (Save, Cancel, leaving the screen, the app going to the background). Nothing else is read. |
| `first` | `true` | no | The session's first message. For other apps listening (§9.4); the Pi doesn't need it. |
| `show` | `true` | no | **Show on board**: take the board back after a takeover (§9.3). |
| `ping` | `true` | no | A keep-alive (every 20 s, with the full selection): nothing changed. |
| `source`, `signed_in` | | no | As §3; informational. |

A malformed message (a bad session, a list that isn't a list of strings, too many starts, finishes or holds, an unknown feet rule) is logged and ignored.

### 9.2 Sender: the app (`app/authoring.js`, "Live LEDs while setting")
- A session starts at the **first change** (a hold tapped, Undo, Clear, the feet rule), not when the screen opens, so opening an admin Edit lights nothing. One message is in flight at a time, and the next carries whatever is on screen when it lands, so fast taps coalesce. A failed send is retried after 2 s. From the laptop, Realtime accepted each in about 0.25–0.4 s.
- **Geofence (phones):** the session's first change runs `ensureCastLocation({ adminBypass: false })`: the same lenient check as casting, but **admins aren't exempt** (Ross, 30 Oct 2026: editing holds at home mustn't light the gym's board). Confidently outside: nothing is sent for the whole session and a note says the board lights up only at the gym; setting works as usual. The wall screen doesn't ask.
- It ends with `end` on Save, Cancel, leaving the screen, and when the app goes to the background; the next change starts a new session. The wall screen also ends it when Create closes (idle, a discard).
- The note by the board says "Lit on the board as you tap", "The board lights up as you set only at the gym", or "Someone else lit the board" with **Show on board**.

### 9.3 What the Pi does (`renderer.py`, the `preview` state)

| What happens | What the board does |
|---|---|
| A preview message, in the day, nothing else going | The preview cuts in at once (no fade) and follows every change. |
| No message for `PREVIEW_TIMEOUT_S` (60 s) | It ends: crossfade to idle. The app's keep-alive (every 20 s) prevents this while the screen is open. |
| `end` | It ends: idle. The session's token is remembered for 2 minutes (at most 200) and any later message from it is ignored, so a tap still in flight when `end` was sent can't light the board again (since 14 Nov 2026; before, it started a new session lit for 60 s). The app also sends `end` only after its message in flight has settled. |
| A problem cast (`cast_problem`), or a circuit's static view (`show_circuit`, shown as a cast, §8.7) | **The cast wins** (Ross, 30 Oct 2026). The session is "taken over": its later messages are ignored until one says `show`. |
| Another session's message | **The latest wins**: the earlier session is taken over, as by a cast. |
| A message with `show` from a taken-over session | It takes the board back (from a cast or another preview). |
| A circuit run (`cast_circuit`) | **The circuit wins and the preview waits**: its messages are kept, not shown. When the run ends (stop, finish, time limit) the preview comes back if it's still going (a message within 60 s), else idle. |
| Night (outside the opening hours, §5) | Nothing is shown; a preview going at closing time ends with the fade to black. The first 50 sessions a night are logged as not shown, then no more (a bounded set since 14 Nov 2026). |
| SIGUSR1 (idle now) | It ends: idle. |
| `pb-idle brightness` | Applies, as to a cast. |

Taken-over sessions are remembered for an hour (at most 50). The preview uses a cast's brightness and current cap. The journal gets a line when a session starts, is taken over, comes back or ends (`LEDs: preview <token> …`), never one per tap. `listener.json` shows `leds: preview` while one is showing, and **the deploy busy check counts it** (`console/probe.py busy`), as it counts a circuit run.

### 9.4 How the app knows it was taken over
While a session is going (inside the geofence), the app subscribes to the channel: the only time it opens a socket. A `cast_problem`, a `show_circuit` (since 14 Nov 2026: the Pi shows it as a cast, §8.7), or another session's `preview_holds` with `first` or `show` (the three kinds that take the board, §9.3), marks the session taken over and offers **Show on board**. A `cast_circuit` doesn't: the preview waits for the run and comes back by itself (§9.3). Keep-alives, and taps from a session that was itself taken over, don't take the board, so they're ignored. The socket closes when the session ends. If the socket misses a takeover, the setter's taps don't show until they reopen Create (or the next takeover offers the button); nothing breaks.

### 9.5 Open questions
1. There's still no Pi → app message: the app infers a takeover from the channel, and a preview at night or with the Pi down still says "Lit on the board".
2. Like casts, previews are unauthenticated (§7 item 15): anyone with the anon key can light the board this way. Night, the cast precedence and the 60 s timeout limit what that can do.

## 10. Renaming a problem or a circuit (8 Nov 2026)

Since 8 Nov 2026 one **Edit** (the phone only; not the wall screen) changes a problem's holds, name, grade and feet rule, or a circuit's sequence, start count, loop, name and grade, through the Create screen. Who may: admins, or the owner while nobody else has ticked it (a circuit: nobody else has logged a run), never a benchmark, a circuit a challenge uses, or one of The Hangout's problems (db/39). A name is the cast key, so a rename changes what's sent. What keys on a name, and what happens on a rename:

| What | Keyed on | On a rename |
|---|---|---|
| `cast_problem`, `cast_circuit`, `show_circuit` | the name, looked up by the listener when the message arrives (`pi/listener/supa.py`, exact match, no cache) | The next cast uses the new name and lights it. No Pi change. |
| A circuit run already going | the row the Pi read at the start | Carries on; `stop` is by `run` token, not name. |
| `preview_holds` (the live LEDs while editing) | a session token and the holds sent, never a name | Unaffected; the session ends on Save as usual. |
| An app that hasn't reloaded the list (another phone; the wall polls every 5 min) | its in-memory copy | Casting there sends the old name, which the listener doesn't find: the board stays as it is (§5). Pull to refresh, reopening the app or the wall's next poll fixes it. Accepted. |
| Ticks, favourites, likes, `circuit_logs`, challenges, URLs (`#detail/<id>`, `#circuit/<id>`), the saved lists | the row's id | Kept. The editing phone also rewrites its saved list at once. |
| `cast_log` | the name at the time of the cast | History; PB Console matches a problem cast by name within 2 minutes of it, so old rows stay matched. |
| The idle teaser (benchmarks) | re-read every half hour | Picks up the new name. |
| `circuits.led_track` (§8.6, not drawn or edited since 10 Nov 2026) | the row's id | Kept; nothing reads it. |

Names stay clean (no grade), trimmed, 1–60 characters, unique ignoring case in the app (the database's UNIQUE is exact, and a clash there is refused as `23505` too).

## Change history

- **2026-11-14, Claude Code (review fix session 5, cast seams):** §5, §8.1, §8.2, §8.3, §8.4, §8.6, §9.3, §9.4, §10. **The app's Cast sheet sends `laps`** (Loop = 0, or 1–10; a circuit that doesn't loop gets no Loop and sends 1), still with `loop` beside it (`true` exactly when `laps` is 0) for a listener from before 5 Nov 2026; the listener is unchanged on both, so either side can be deployed first. **The listener remembers stops** for 2 minutes (by token, or the time of a stop with no token): a circuit stopped while it was being read, or whose stop came first, never starts; a `stop` whose `run` isn't a 1–64-character string is ignored. **An ended preview session is remembered** for 2 minutes and its late messages ignored, and the app sends `end` after its message in flight. **Previews hear `show_circuit`** (it takes the board, as a cast). A malformed envelope no longer drops the socket; refused bodies are logged clipped to 200 characters; frames over 64 KB drop the socket (was 1 MB); the night log of previews is bounded. `check_track()` deleted; §8.1 and §8.3 say circuits mirror through the holds table; §10 drops `console/tracks.py`. No new events or fields.

- **2026-11-12, Claude Code (kiosk hardening, review WALL-03):** §8.3: the app's run screen ends an endless run at the Pi's 30-minute `CIRCUIT_MAX_S` too. No change to the channel, events or payloads.
- **2026-11-10, Claude Code (console layout):** §8.1, §8.6: PB Console's Circuit tracks section (the track editor and its circuit test cast) was removed, so nothing sends `laps` or writes `led_track` today. No change to the channel, events or payloads; the console's problem cast (Home → Light a problem) is unchanged.
- **2026-11-10, Claude Code:** §6.5, §9.1: Specific feet in the app (board setup session 3): Create/Edit save `feet_mode: 'specific'` + `feet_holds`; previews carry `feet: "specific"` (already accepted since 9 Nov). No change to the channel, events or payloads; the Pi unchanged (a new test).
- **2026-11-09, Claude Code (later):** §5, §6.3: **board setup** (db/42). The holds table becomes the source of positions, outlines and mirror pairs (`board_config`'s are copies); footholds can be added (no LED, foot ↔ foot pairs only). LEDs unchanged. **No change to the channel, events or payloads, and no Pi change.**
- **2026-11-09, Claude Code:** §5, §6.1, §6.3, §6.4, §6.5, §9.1: **holds in the database** (db/41). The listener reads each hold's LED and mirror partner from the new `holds` table (cached on the Pi for a boot with no network; the formula only as a last resort) instead of the formula and `board_config.mirror_map`; the seeded values are the formula's, checked by `tools/check_holds.py`, so every cast lights the same LEDs. **`feet_mode` gains `specific`** with `problems.feet_holds` (footholds only); the board lights nothing for it, and `preview_holds` accepts `feet: "specific"`. **No change to the channel, events or payloads.**
- **2026-11-08, Claude Code:** §7 item 5 and a new §10: **names are editable** (one Edit for problems and circuits, db/39), and the name stays the cast key: the listener reads every cast by name when it arrives, so a rename works from the next cast. **No change to the channel, events, payloads or the Pi.**
- **2026-11-07, Claude Code:** §4, §5, §7 item 14, §8, §9: **night mode follows the opening hours** (`HOURS_MON` … `HOURS_SUN` on the Pi, London time, plus PB Console's self-ending "stay on until"), replacing the fixed 23:00–08:00; outside them the wall screen is off (the Pi stops the kiosk) and the wall page has no night screen of its own any more. What night does to casts, circuits and previews is unchanged. **No change to the channel, events or payloads.**
- **2026-11-05, Claude Code:** §8.1, §8.3, §8.4, §8.6: **the "map and next hold" circuit look** (Ross, 5 Nov 2026) replaces direction 4, "Pulse and fade", and all the track lighting: a blue map at `CIRCUIT_MAP_LEVEL`, the red finish at `CIRCUIT_FINISH_LEVEL` on the final lap only, the start holds blinking green in the countdown, only the hold to go to lit green in the run, a match blinking twice, later laps wrapping from position 0, and a top of three red blinks and a 1 s fade. **`cast_circuit` gains `laps`** (0 = endless, 1–10; a circuit whose `loops` is false always runs 1 lap; a bad value ignores the cast); with `laps` absent, `loop` true = endless, false = 1 lap, and neither = the circuit's `loops`, so old apps and old PB Consoles keep working. **`trace_s` is ignored** (the app stops sending it; the phone's countdown no longer waits for a trace). The `circuit ended` line says `endless` or `N laps` (PB Console reads the old `loop`/`once` too). Config: `CIRCUIT_MAP_LEVEL` and `CIRCUIT_FINISH_LEVEL` in; `CIRCUIT_GHOST`, `CIRCUIT_TRACK_RUN`, `CIRCUIT_TRACK_LEVEL` out. `circuits.led_track` and `check_track()` are kept (not drawn). `cast_problem`, `stop`, `show_circuit` and `preview_holds` are unchanged.
- **2026-11-02, Claude Code (later):** §2, §5, §8.4 and a new §8.7: **a circuit's static view.** A new event on the same channel, `show_circuit` (`circuit_name`, plus `source`/`signed_in`), sent when a circuit is tapped on the wall screen's Circuits page; the listener lights every hold at once (starts green, the last hold red, the rest blue; finish beats start) and shows it as a problem cast (latest wins, idle after `IDLE_AFTER_S`). The wall's "Light it up" is now "Start circuit". `cast_problem`, `cast_circuit`, `stop` and `preview_holds` are unchanged; a listener from before this ignores the new event.
- **2026-11-02, Claude Code:** §4, §5, §7 items 1 and 12: **the wall screen casts on the pick** (a clean tap on a problem, Mirror, the benchmark slide, a save on Create; no Light it up button on its Problems page; one cast at a time, the latest tap next) and **the idle comes 15 minutes after the last cast** (`IDLE_AFTER_S` 900, was 1200). **No change to the channel, events or payloads** (`cast_problem` from the wall is the same message as before, `source: "wall"`).
- **2026-11-01, Claude Code:** §5, §8.1, §8.3, §8.4 and a new §8.6: **circuit tracks.** A new optional `cast_circuit` field, `trace_s` (0–5, absent = 0: a listener from before this ignores it, and the app sends 3), and `circuits.led_track` (db/37), read with the circuit. The listener adds a route trace before the countdown, a ghost of the circuit's holds and the track in the run, all below Pulse and fade, with three new config keys. The phone's countdown starts `trace_s` later. `cast_problem`, `stop` and `preview_holds` are unchanged.
- **2026-10-30, Claude Code (evening):** §2, §4, §5 and a new §9: **the live preview while setting.** A new event on the same channel, `preview_holds` (`session`, `start`, `hold`, `finish`, `feet`, `end`, `first`, `show`, `ping`, plus `source`/`signed_in`), sent by the phone's Create/Edit and the wall screen's new Create page; a `preview` state in the listener with its precedence (a cast takes over until Show on board, a circuit makes it wait, night blocks it, 60 s with no message ends it). The app opens a socket only while a preview session is going. `cast_problem`, `cast_circuit` and `stop` are unchanged; a listener from before this ignores the new event.
- **2026-10-30, Claude Code (later):** §8.1, §8.3, §8.4, §8.5: no mirrored circuits for now; the listener logs a `circuit ended: …` line for PB Console's Activity; the wall screen casts circuits (`source: "wall"`); members' casts are recorded privately in `cast_log` (db/34), never in the broadcast. **No change to the channel, events or payloads.**
- **2026-10-30, Claude Code:** §2, §4, §5, §7 item 13 and a new §8: **circuits.** Two new events on the same channel, `cast_circuit` (`circuit_name`, `interval`, `loop`, `mirror`, `run`, plus `source`/`signed_in`) and `stop` (`run`). The listener runs the circuit itself (`pi/listener/circuit.py`, Ross's direction 4); the app's Cast sheet sends them and logs signed-in runs to `circuit_logs`. `cast_problem` is unchanged; a listener from before this ignores the new events.
- **2026-10-30, Claude Code:** §5, §6.5, §7 item 7: the feet rule. `problems.feet_mode` (`any` / `orange` / `black`, db/33) drives the B2/B1 sign LEDs (25/26), never the hold list, and never mirrored; db/33 maps the migrated problems and removes `hold2`/`hold21` from their lists. The listener reads `feet_mode` from the next Pi deploy. **No change to the channel, event or payload.**
- **2026-10-29, Claude Code:** §3, §4, §5: two optional, informational payload fields, `source` (`wall` / `phone` / `console`) and `signed_in` (a boolean, never who), sent by `castByName()` and PB Console's test cast and logged by the listener for PB Console's Activity log. The channel and event are unchanged, and the listener before this change ignores both fields, so either side can be deployed first.
- **2026-10-28, Claude Code:** §6.1, §6.3, §6.4, §7 item 11: the LED map checked on the wall with `pb-ledmap`; three hold labels fixed in the board data (db/32), 188 real holds, the mirror differences now 5. No change to the channel, event or payload.
- **2026-10-28, Claude Code:** §5: idle patterns (ten, chosen by `IDLE_PATTERN` or `pb-idle`); the listener also reads the benchmark problems for the teaser pattern. No change to the channel, event or payload.
- **2026-10-27, Claude Code:** §5 and §7 items 1 and 12: the listener's idle animation, Glisten. No change to the channel, event or payload.
- **2026-10-27, Claude Code:** §4 and §7 item 14: the wall screen (`/?wall`, `app/wall.js`) casts through `castByName()` too. No change to the channel, event or payload.
- **2026-10-26, Claude Code:** §5 describes the new Pi listener (`pi/listener/`), including night mode (casts ignored 23:00–08:00). No change to the channel, event or payload.
- **2026-10-26, Claude Code:** §6.4 and §7 item 11 updated with the hardware verified at first light (colour order, pixel 0, A1, the 4-way cable and the 8-way power feeds); §5 notes the stopgap listener. No change to the channel, event or payload.
- **2026-10-19, Claude Code:** first version, written from the code (app `pb-v109`; the old Pi 3 listener and Gareth's code as references).
