# Cast contract

How a cast gets from the app to the LEDs. **This describes what the code does** (first written 19 Oct 2026; circuits added 30 Oct 2026, §8). Anything the code doesn't settle is under "Open questions"; nothing there is decided. Any change to the channel, event or payload must update this file in the same commit. The repo is public: no secrets here.

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
| Events | `cast_problem` (a problem, §3), `cast_circuit` and `stop` (a circuit run, §8) |
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

- **Only path:** `castByName(name, btn, mirror, stillShowing)` in `app/problems.js`, called by the cast button on the problem detail view (wired in `app/app.js`) and by **Light it up** on the wall screen (`app/wall.js`, the kiosk's `/?wall` mode), with the same payload. Circuits have their own path, `startCircuitCast()` (§8).
- **Steps:**
  1. Geofence check (`ensureCastLocation`). It runs in the app only and is lenient: it blocks only a location fix that is confidently far from the gym. No location, a refused permission or a timeout all let the cast through, and admins skip it.
  2. If the problem or orientation on screen changed during the location wait, nothing is sent.
  3. `channel.httpSend('cast_problem', payload, { timeout: 10000 })`: one HTTPS POST to Realtime's broadcast endpoint. `apikey` is the public anon key (`app/state.js`), and `Authorization` carries the user's access token when supabase-js has one. Guests can cast.
- **What the user sees:** a 202 from Realtime → "Cast: <name>" (or "Mirror cast"). An error or timeout → "Cast failed — check connection". **Success means Supabase accepted the message, not that a Pi received it.**
- The app never subscribes to the channel and holds no WebSocket.
- **Other senders:** `tools/cast-test.html` ("Run checks", fake names `~cast-test-A` and `~cast-test-B`). Being a public channel, any client with the anon key can send.

## 5. Listener: the Pi

- **The listener is `pi/listener/pb_listener.py`** (systemd `pb-listener`, live since 26 Oct 2026 21:08; it replaced that day's stopgap `cast_listener.py`). What it does:
  - joins `realtime:board:HangoutPortland` with the anon key and checks the join reply;
  - sends a Phoenix heartbeat every 25 s; no reply for 60 s means a dead socket, and it reconnects with backoff from 1 s to 60 s, with jitter;
  - on `cast_problem`, checks the payload (§3: `problem_name` a string of 1–60 characters, `mirror` true or absent) and logs and skips anything else;
  - logs each cast with its origin, e.g. `cast received: 'Good Bug' mirrored [wall, guest]` (or `cast 'Good Bug' ignored: night mode [phone, member]`); the `[source, who]` part is left off when the app sent neither (before 29 Oct 2026). PB Console's Activity tab reads these lines;
  - looks the problem up by exact name over REST (one retry); an unknown name leaves the board as it is;
  - builds the frame by §6.2–6.5: roles are classified on the stored ids first, ids off the grid are then dropped and logged, and with `mirror` each hold moves to its partner, keeping its role; the feet-rule light comes from `feet_mode` (§6.5), never mirrored. Brightness is 0.5, with a whole-frame current cap;
  - latest cast wins: a cast still being fetched when a newer one arrives is dropped;
  - loads the mirror map on every join and refreshes it every 10 min; a mirrored cast with no map loaded is skipped;
  - **night mode, 23:00–08:00 by the Pi's clock** (day if the clock hasn't synced): the strip is cleared and casts are ignored (logged, not shown), while the socket stays joined;
  - **idle (an idle pattern, Glisten by default):** `IDLE_AFTER_S` after the last cast (20 min by default), and on start or at the end of the night in the daytime, the problem crossfades (1.5 s) into an ambient animation (`IDLE_PATTERN`: one of ten patterns, or a cycle; `pb-idle` on the Pi tries them live; the teaser pattern reads the benchmark problems, unmirrored, every half hour); a cast cuts straight in. With `IDLE_ANIMATION=off` the strip is cleared instead. At night everything fades to black over 3 s. Details in `pi/README.md`;
  - on `cast_circuit` and `stop`, runs and ends a circuit (§8);
  - clears the strip on stop. It sends no reply, so a cast at night or with the Pi down still shows "Cast: X" in the app (§7 item 2);
  - health checks, watchdogs and deploy are in `pi/README.md`.

  The June 2026 Pi 3 listener and the stopgap are kept locally for reference only.
- `tools/cast-test.html` (served by `python tools/serve.py`) subscribes like a listener and logs every cast with its payload.
- **What a listener can read with the anon key** (public-read RLS):
  - `problems`: `name`, `start_holds`, `intermediate_holds`, `finish_hold`, `feet_mode`
  - `board_config` where `wall = 'HangoutPortland'`: `mirror_map`
  - `circuits`: `hold_sequence`, `start_count`, `loops`
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
- **Allowed values:** the database CHECK allows `^hold[0-9]{1,3}$`. Live data uses `hold1`–`hold246`. 188 grid cells have real holds (189 until db/32 on 28 Oct 2026 removed `hold218`, I12, which was never a hold: its LED 116 is behind the board).

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
- With `mirror: true`, each hold becomes `board_config.mirror_map[hold]`. A hold that is absent from the map, or maps to itself, stays in place.
- Roles don't change.
- The live table differs from the original system's `MirrorDic.txt` in 5 entries among real holds (E3, E4, E5, O5, O6). The app uses the live table. (Before db/32 on 28 Oct 2026 it differed in 7 more, from three shifted hold labels; those are now Gareth's pairs: K9↔I11, N13↔F13, O13↔E13.)

### 6.4 Hold → LED index
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
- Every problem has a **feet rule** in `problems.feet_mode` (CHECK: `any`, `orange`, `black`; default `any`):

  | `feet_mode` | Meaning | Lights |
  |---|---|---|
  | `any` | Any feet | neither sign |
  | `orange` | Orange feet only | LED 25 (B2) |
  | `black` | Black feet only | LED 26 (B1) |

- The lit sign is **blue** `(0,0,255)`, the colour Gareth's code gave it (it lit the signs as intermediates).
- **The listener reads `feet_mode`** with the problem (`pi/listener/board.py`, `FEET_LIGHTS`). `hold2`/`hold21` in a hold list are skipped, never lit. The payload doesn't change: the rule travels with the problem row, like its holds.
- **Never mirrored:** the signs are fixed to the wall, so a mirrored cast lights the same sign. Neither id is in `board_config.mirror_map`, and no hold mirrors onto them (`pi/tests/test_board.py`, `Feet`).
- **Data:** before db/33 the rule lived only in migrated problems' hold lists (Gareth's lists carried the signs just before the finish; the old notes say both on = any feet). db/33 set `feet_mode` from them (only `hold2` → `black`, only `hold21` → `orange`, both or neither → `any`: 26, 19 and 220 problems on 30 Oct 2026) and took `hold2`/`hold21` out of every hold list. Neither was ever a start or the finish, so no problem's roles changed.
- **The app:** Create and admin Edit offer the rule as three options (Any feet by default); the problem view shows a badge when it isn't Any, and the info sheet always shows it. The app never draws the signs on the board.

## 7. Open questions

Nothing below is decided.

1. ~~**Clearing the board:** there's no clear, stop or off event. Gareth's code kept the last problem lit and ran a rainbow after 30 minutes idle. What should the new Pi do?~~ Answered on the Pi side (27 Oct 2026): a cast stays lit for `IDLE_AFTER_S` (20 min), then the Glisten idle animation takes over (§5). There's still no clear or stop event from the app.
2. **Pi offline:** the cast is lost and the app still reports success. Should the app know whether a listener is online (presence or a heartbeat)?
3. **Acknowledging receipt:** there's no Pi → app message. Is one wanted, and on what channel or event?
4. **Stale, duplicate and rapid messages:** casts carry no id or timestamp. Debounce or rate-limit on the Pi? What about a cast arriving while one is still being drawn?
5. **Problem lookup:**
   - Is the name still the key once problem names can be edited, or should casts carry the id?
   - What happens for an unknown name?
   - Exact match, or trimmed?
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
12. **Start-up and idle behaviour** of the Pi: before the first cast, and from 20 minutes after the last one, Glisten runs (§5; 27 Oct 2026). Still open: the relays.
13. ~~**Circuits:** a design spec plans `cast_circuit` and a `stop` event on the same channel.~~ Built 30 Oct 2026 (§8).
14. ~~**The wall kiosk** will cast through the same PWA and channel. Does it need anything different?~~ No (27 Oct 2026): it casts as a guest through `castByName()`. Its Chromium runs with `--deny-permission-prompts`, so the location check fails at once and lets the cast through, instead of waiting on a permission bubble nobody answers. It turns casting off at night (23:00–08:00) and while it has no connection.
15. **Who may cast:** anyone, by decision. Does the Pi apply any checks of its own?

## 8. Circuits (built 30 Oct 2026)

A circuit cast runs a timed animation on the Pi: the phone sends one message to start and one to stop, and the Pi works out every frame itself.

### 8.1 `cast_circuit`

```json
{ "circuit_name": "Pat Burner", "interval": 3, "loop": true, "run": "9f2c41d07ab3e855",
  "source": "phone", "signed_in": true }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `circuit_name` | string | yes | `circuits.name` exactly as stored (UNIQUE, 1–60 characters). |
| `interval` | number | yes | Seconds a move. The app sends 5, 3 or 2 (Slow, Med, Fast); the listener accepts 1–10 and ignores anything else. |
| `loop` | boolean | no | Run once to the top, or loop until stopped. The app always sends it (defaulting to the circuit's `loops`, which the caster can change); absent means the circuit's `loops`. |
| `mirror` | boolean, `true` when present | no | Mirror every hold through `board_config.mirror_map`, as §6.3. **No mirrored circuits for now** (Ross, 30 Oct 2026: a future release): the app never sends it; the listener would honour it. |
| `run` | string, 1–64 characters | no | A token naming this run (the app sends 16 random hex characters). `stop` uses it. |
| `source`, `signed_in` | | no | As §3: the Activity log only. |

### 8.2 `stop`

```json
{ "run": "9f2c41d07ab3e855", "source": "phone", "signed_in": true }
```

Ends the running circuit if its token matches; with no `run`, ends any running circuit. A stop for another run, or with nothing running, does nothing (a problem cast that has since cut in stays lit). The board then crossfades into the idle pattern.

### 8.3 What the Pi shows (`pi/listener/circuit.py`)

The look is direction 4, "Pulse and fade", chosen by Ross on 30 Oct 2026 in `tools/circuit-led-simulator.html` (the Pi's code is a port of it: change both together).

- The listener reads `name, hold_sequence, start_count, loops` from `circuits` by exact name (one retry); an unknown name leaves the board as it is. The sequence is in climbing order (not inverted). Ids off the grid and the feet signs (`hold2`/`hold21`) light nothing but keep their place in the timing.
- **Countdown, 5 s from when the Pi has read the circuit:** the start holds (1 or 2) flash red once a second, and the first two moves flash blue with them.
- **Then one move every `interval` s.** With c the last hold reached: the holds you're on (c and c-1) show their colour (start holds green on the first lap only, then blue); the hold to go to (c+1) is solid blue (red if it's the finish of a run done once); the hold after that is amber `(255,110,0)`, swelling up once a second and a little brighter each time through the move; the hold just let go of (c-2) pulses softly red once a second, fading out over the move. A **match** (the hold to go to is one you're on) stays solid.
- **Once:** at the top, a beat on the finish, then the route runs up in green and fades; then idle. **Loop:** runs until `stop`, a problem cast, another circuit, night, or `CIRCUIT_MAX_S` (30 min by default), then idle.
- Brightness and the current cap are a problem cast's (`BRIGHTNESS`, `POWER_BUDGET_MA`); frames at `IDLE_FPS`. Night ignores circuit casts and ends a run, as it does problems. Latest cast wins across problems and circuits.
- Log lines: `circuit received: 'Name', 3 s a move, loop [phone, member]`, `circuit started 'Name': … run <token>`, `stop received: run <token> […]`, and when the run ends, for any reason, one self-contained line that PB Console's Activity reads: `circuit ended: 'Name' stopped after 23 moves (74 s), 3 s a move, loop, run <token> [phone, member]` (how: `stopped`, `finished`, `replaced`, `night`, `time limit` or `sent to idle`). A circuit cast at night logs `circuit 'Name' ignored: night mode […]`.

### 8.4 The app (`app/circuits.js`, and the wall screen)

- **Cast** beside the circuit's title opens a sheet: speed (Slow 5 s / Med 3 s / Fast 2 s, remembered on the device as `pb-circuit-speed`), Loop (the circuit's setting by default), and **Start on the board**. The same lenient geofence as a problem (`ensureCastLocation`, admins skip it), then `channel.httpSend('cast_circuit', …)`.
- Once Realtime accepts it, the sheet is the run screen: the countdown with beeps, then the move count (and lap), and a big **Stop**, which sends `stop` with the run's token. The phone keeps its own clock from that moment (plus 0.25 s for the Pi's read), so it stays right after the screen sleeps; the screen is kept awake while it runs. The sheet can't be closed while a run is going. "Go again" starts a new run.
- **The wall screen** (`/?wall`, since 30 Oct 2026) has a Circuits page: the list and the chosen circuit over the board; **Light it up** opens the same sheet (`openCircuitCast(c)`), sent with `source: "wall"`. The wall doesn't go idle while a run is going; night closes the sheet (the Pi ends the run).
- As with problems, a sent cast or stop means Realtime accepted it, not that the Pi received it (§7 items 2 and 3).

### 8.5 The logs

- **Runs:** when a run ends on the phone (Stop, or the top of a run done once), a signed-in climber's run with at least one move is inserted into `circuit_logs` (`user_id`, `circuit_id`, `moves`, `looped`, `speed` = seconds a move; own-rows RLS, db/14). A move is one LED advance, counted across laps. Guests aren't logged. Nothing in the app reads it yet (Phase 3 is PBs and leaderboards). **"Done" is a problems-only idea** ("done both sides", the problems' Exclude Done): the circuits list has no Done filter (Ross, 30 Oct 2026; circuits may get one in a future release).
- **Who cast (db/34, 30 Oct 2026):** the broadcasts never say who (the channel is public: anyone with the anon key can listen). After a problem or circuit cast Realtime accepted, a signed-in member's app inserts one private row into `cast_log` (`kind`, `name`, `mirror`, `source`, `run`; insert-only, nobody can read it through the API) with `logCast()` in `problems.js`. PB Console's Activity reads it over direct Postgres and puts the member's nickname on the matching journal line: a circuit by its `run` token, a problem by name within 2 minutes.

## Change history
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
