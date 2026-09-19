// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, leaderboard, app. This file: Supabase client + channel, grade ladders, and all shared mutable state.

  // ── Supabase client ──────────────────────────────────────────────────────────
  const { createClient } = supabase;
  const SUPA_URL = 'https://uqirowyfqwiceyjznosl.supabase.co';
  const sb = createClient(
    SUPA_URL,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAsImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA'
  );

  // ── Realtime channel for casting (unchanged contract: board:HangoutPortland) ──
  // Never subscribed: the app only sends, so it holds no WebSocket. A cast goes
  // out with channel.httpSend(), one REST POST that resolves once the Realtime
  // server has accepted the broadcast (202) and rejects otherwise, so a dead
  // connection can't report a false success. Subscribers (the Pi) receive the
  // same event and payload as they did from the old socket send. If a feature
  // ever needs to RECEIVE (Phase 2 status from the Pi), subscribe on that view only.
  const channel = sb.channel('board:HangoutPortland');

  // ── Grade ordering (boulder problems) ────────────────────────────────────────
  // Stored / matched lowercase (these strings are the DB values); displayed as
  // capitalised Font grades (6a -> 6A) via fontGrade(). Circuits use a separate
  // lowercase French sport ladder (SPORT_GRADE_ORDER) and are NOT capitalised.
  // The low end is collapsed into two buckets: everything up to and including the
  // old 5b+ is "5", and the old 5c/5c+ are "5+"; 6a and up are unchanged. The DB
  // values were remapped to match (db/19_regrade_boulders.sql).
  const GRADE_ORDER = ['5','5+','6a','6a+','6b','6b+','6c','6c+','7a','7a+','7b','7b+','7c','7c+','8a'];
  // Unknown grades (e.g. "Project") sort to the end. Case-insensitive for safety.
  const gradeRank = g => { const i = GRADE_ORDER.indexOf(String(g || '').toLowerCase()); return i === -1 ? 999 : i; };
  // Display a boulder grade as capitalised Font (display-only; the value stays lowercase).
  const fontGrade = g => String(g || '').toUpperCase();

  // ── State ────────────────────────────────────────────────────────────────────
  let allProblems = [];
  let activeGrades = new Set();   // selected grade filters; empty = "All"
  let searchQuery = '';
  let loaded = false;
  let currentView = 'list';
  let listScroll = 0;
  let circuitsScroll = 0; // the circuit list's scroll position, kept across a visit to a circuit
  let currentProblem = null;
  let detailTrail = [];  // problem ids swiped through to reach the current one,
                         // oldest first — deleting steps back along it.
  let shuffleOn = false;  // detail view: swiping forward jumps to a random problem
  let shuffleBack = [];   // shuffle path behind the current problem (ids, oldest first)
  let shuffleFwd = [];    // …and ahead of it, after swiping back (next one last)
  let HOLD_MAP = null;   // hold id -> {x,y} %, from board_config or bundled hold_map.json
  let HOLD_SHAPES = null; // hold id -> [[x,y],…] % polygon, from board_config (admin) or bundled hold_shapes.json (problem + circuit overlays, and the #outlines editor)
  let MIRROR_MAP = null; // hold id -> mirror-partner hold id (bundled mirror_map.json); self = centre/no-partner
  let detailMirror = false; // detail view is showing the left/right-mirrored problem
  let BOARD_IMG = 'board-fallback.jpg'; // resolved board image URL (Supabase upload, else the bundled fallback: ProjectBoard.png as a 260 KB JPEG, same framing)
  let configHasMap = false;             // true once board_config supplied a hold map (suppresses the bundled fallback)
  let configHasMirror = false;          // true once board_config supplied a mirror map (suppresses the bundled fallback)
  let configHasShapes = false;          // true once board_config supplied hold outlines (suppresses the bundled fallback)
  let boardConfigVersion = null;        // board_config.updated_at — the board the live map/image belong to
  let boardAspect = 0;                  // board image naturalWidth/naturalHeight (0 = not measured yet)
  const BOARD_BUCKET = 'board';         // Supabase Storage bucket holding the uploaded board image
  let session = null;    // Supabase auth session (null = guest)
  let authReady = false; // true once the session AND (if signed in) the profile are known — route guards wait for it
  let profile = null;    // { id, username, is_admin } for the signed-in user
  let profileNames = {}; // account id -> current username (for live setter names)
  let myTicks = new Set();         // problem_ids ticked in ANY orientation (the ✓ flag + "Total ticks")
  let myTicksNormal = new Set();   // problem_ids sent in the normal orientation
  let myTicksMirrored = new Set(); // problem_ids sent in the mirrored orientation
  let myFaves = new Set();        // problem_ids the signed-in user has favourited (likes)
  let myCircuitFaves = new Set(); // circuit ids the signed-in user has favourited
  let favesOnly = false;          // list filter: show only favourited problems
  let benchOnly = false;          // list filter: show only benchmark problems
  let excludeDone = false;        // list filter: hide fully-done (both orientations sent)
  let circuitFavesOnly = false;   // circuit list filter: only favourited circuits
  let circuitLoopOnly = false;    // circuit list filter: only looping circuits
  let circuitExcludeDone = false; // circuit list filter: inert until Phase 2 completion logging exists
  let authMode = 'signin'; // 'signin' | 'signup' for the #auth form

  // ── Create-a-problem state ───────────────────────────────────────────────────
  let createRoles = {};        // hold id -> 'start' | 'int' | 'finish'
  let createGrade = '';        // selected grade
  let editingProblemId = null; // when set, the create view is editing this problem (admin) instead of creating

  // ── Circuits ──────────────────────────────────────────────────────────────────
  // Sport grades (lowercase French), a different ladder from boulder problems.
  const SPORT_GRADE_ORDER = ['4','5a','5b','5c','6a','6a+','6b','6b+','6c','6c+','7a','7a+','7b','7b+','7c','7c+','8a','8a+','8b'];
  const sportRank = g => { const i = SPORT_GRADE_ORDER.indexOf(g); return i === -1 ? 999 : i; };

  let allCircuits = [];
  let circuitsLoaded = false;
  let circuitsError = null;          // last load error (the list shows "Failed to load circuits")
  let activeCircuitGrades = new Set(); // grade filter, same tap / tap-and-hold rules as the problem tabs (empty = All)
  let circuitSearch = '';
  let currentCircuit = null;
  let circuitTrail = [];  // circuit ids swiped through to reach the current one (as detailTrail)

  // Create-a-circuit state. The route is one ORDERED sequence (dups allowed);
  // start = the first ccStartCount holds, finish = the last hold.
  let ccSeq = [];          // ordered hold ids
  let ccStartCount = 2;    // 1 or 2
  let ccLoop = false;
  let ccGrade = '';

  // ── Leaderboard ─────────────────────────────────────────────────────────────
  let leaderboard = [];          // [{ rank, user_id, username, points, sends }] from the leaderboard() RPC
  let leaderboardLoaded = false;
  let leaderboardError = null;   // last load error (Ranks shows "Couldn’t load the leaderboard")

  const isTicked = id => myTicks.has(String(id));
  // "Fully done" = sent in BOTH the normal and mirrored orientation (the Exclude Done filter).
  const isFullyDone = id => myTicksNormal.has(String(id)) && myTicksMirrored.has(String(id));
  const isFaved = id => myFaves.has(String(id));
  const isCircuitFaved = id => myCircuitFaves.has(String(id));

  // Outline heart (CSS fills it red via .faved). Reused on cards + detail headers.
  const HEART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';

