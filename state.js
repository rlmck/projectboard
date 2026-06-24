// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: Supabase client + channel, grade ladders, and all shared mutable state.

  // ── Supabase client ──────────────────────────────────────────────────────────
  const { createClient } = supabase;
  const SUPA_URL = 'https://uqirowyfqwiceyjznosl.supabase.co';
  const sb = createClient(
    SUPA_URL,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAsImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA'
  );

  // ── Realtime channel for casting (unchanged contract: board:HangoutPortland) ──
  // broadcast.ack makes channel.send() wait for the Realtime server to confirm
  // receipt and resolve with the real status ('ok' | 'error' | 'timed out');
  // without it, send() resolves 'ok' the instant it pushes, so a dropped socket
  // (weak gym Wi-Fi) would falsely report a successful cast. The broadcast event
  // the Pi receives is unchanged — ack is only between the app and the server.
  const channel = sb.channel('board:HangoutPortland', {
    config: { broadcast: { ack: true } }
  });
  channel.subscribe();

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
  let activeGrades = new Set();   // selected grade filters; empty = "All" (the grade slider writes this)
  let gradePresent = [];          // sorted distinct grades present in the data (drives the slider)
  let feedMode = true;            // true = immersive card feed (shuffle); false = plain list view
  let searchQuery = '';
  let loaded = false;
  let currentView = 'list';
  let listScroll = 0;
  let currentProblem = null;
  let HOLD_MAP = null;   // hold id -> {x,y} %, from board_config (admin) or bundled hold_map.json
  let HOLD_SHAPES = null; // hold id -> [[x,y],…] % polygon, bundled hold_shapes.json (problem overlay only)
  let MIRROR_MAP = null; // hold id -> mirror-partner hold id (bundled mirror_map.json); self = centre/no-partner
  let detailMirror = false; // detail view is showing the left/right-mirrored problem
  let suppressDetailReveal = false; // one-shot: skip the GSAP light-up reveal for the next detail render (set when mirroring back to normal)
  let BOARD_IMG = 'ProjectBoard.png';   // resolved board image URL (Supabase upload, else bundled)
  let configHasMap = false;             // true once board_config supplied a hold map (suppresses the bundled fallback)
  let configHasMirror = false;          // true once board_config supplied a mirror map (suppresses the bundled fallback)
  const BOARD_BUCKET = 'board';         // Supabase Storage bucket holding the uploaded board image
  // The 189 real holds on the board (ground truth from the DTB layout). Used by the
  // calibrate "Add" mode to offer holds that are absent from the current map.
  const VALID_HOLD_IDS = [1,3,4,5,7,8,10,12,14,16,17,19,20,22,23,24,25,27,28,30,31,32,33,34,35,36,38,39,41,42,43,44,45,46,47,48,49,50,51,53,54,55,58,59,60,61,62,63,64,65,69,70,71,72,73,74,75,76,79,80,81,82,83,85,86,87,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,143,145,146,147,148,149,150,151,152,154,155,156,157,158,160,161,162,163,164,165,166,167,168,169,171,172,174,175,176,177,178,179,180,185,186,188,189,190,191,192,194,195,196,198,199,202,203,205,206,207,208,212,213,216,218,219,221,222,230,231,233,234,235,236,237,239,242,243,244,245,246];
  let session = null;    // Supabase auth session (null = guest)
  let authReady = false; // true once getSession has resolved (don't gate routes before then)
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
  let circuitsError = null;          // last load error (for the "run db/14" message)
  let activeCircuitGrade = '';       // single-select grade filter ('' = All)
  let circuitSearch = '';
  let currentCircuit = null;

  // Create-a-circuit state. The route is one ORDERED sequence (dups allowed);
  // start = the first ccStartCount holds, finish = the last hold.
  let ccSeq = [];          // ordered hold ids
  let ccStartCount = 2;    // 1 or 2
  let ccLoop = false;
  let ccGrade = '';

  // ── Leaderboard ─────────────────────────────────────────────────────────────
  let leaderboard = [];          // [{ rank, user_id, username, points, sends }] from the leaderboard() RPC
  let leaderboardLoaded = false;
  let leaderboardError = null;   // last load error (for the "run db/23" message)

  const isTicked = id => myTicks.has(String(id));
  // "Fully done" = sent in BOTH the normal and mirrored orientation (the Exclude Done filter).
  const isFullyDone = id => myTicksNormal.has(String(id)) && myTicksMirrored.has(String(id));
  const isFaved = id => myFaves.has(String(id));
  const isCircuitFaved = id => myCircuitFaves.has(String(id));

  // Outline heart (CSS fills it red via .faved). Reused on cards + detail headers.
  const HEART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
  // Per-card action icons (reused from the detail header) for the immersive feed.
  const TICK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const MIRROR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"></line><polyline points="8 8 4 12 8 16"></polyline><polyline points="16 8 20 12 16 16"></polyline></svg>';
  const CAST_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>';
  const INFO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
  const SHUFFLE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>';

