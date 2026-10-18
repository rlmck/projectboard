// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, leaderboard, app. This file:
// the points leaderboard (the leaderboard() RPC is the single source of truth for the
// scoring formula — see db/27). Only benchmark problems score, so the RPC lists only
// climbers with points, and "sends" counts benchmark sends.
// Ranks is opt-in (db/30): only climbers who turned on "Show me on Ranks" are listed
// (listed = true). A signed-in climber who hasn't also gets their own row back
// (listed = false, no rank), shown to them alone as a private note.

  // Fetch the ranking from the leaderboard() RPC and cache it. Cheap to call: it
  // no-ops once loaded unless forced (e.g. the reload button, or after a tick
  // flips leaderboardLoaded back to false).
  async function loadLeaderboard(force) {
    if (leaderboardLoaded && !force) return { ok: true };
    const { data, error } = await sb.rpc('leaderboard');
    if (error) { leaderboardError = error; console.warn('leaderboard load failed', error); return { ok: false, error }; }
    leaderboard = data || [];
    leaderboardLoaded = true;
    leaderboardError = null;
    return { ok: true };
  }

  // The signed-in user's own row, listed or not.
  function myLeaderboardRow() {
    if (!session) return null;
    return leaderboard.find(r => String(r.user_id) === String(session.user.id)) || null;
  }

  // The signed-in user's total points, read back from the cached ranking (so the
  // profile and the leaderboard never disagree). null if signed out; 0 if no points.
  function userPoints() {
    if (!session) return null;
    const row = myLeaderboardRow();
    return row ? row.points : 0;
  }

  // Rank 1-3 get medals; everyone else their number.
  const rankLabel = n => ({ 1: '🥇', 2: '🥈', 3: '🥉' })[n] || String(n);

  function leaderboardRowHtml(r) {
    const me = !!(session && String(r.user_id) === String(session.user.id));
    return `
      <div class="leaderboard-row${me ? ' me' : ''}">
        <span class="lb-rank">${escHtml(rankLabel(r.rank))}</span>
        <span class="lb-name">${escHtml(r.username)}${me ? ' <span class="lb-you">you</span>' : ''}</span>
        <span class="lb-stat">
          <span class="lb-points">${r.points} pts</span>
          <span class="lb-sends">${r.sends} send${r.sends !== 1 ? 's' : ''}</span>
        </span>
      </div>`;
  }

  function renderLeaderboard() {
    const el = document.getElementById('leaderboard-content');
    if (!el) return;

    if (leaderboardError) {
      el.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>Couldn’t load the leaderboard.</div>`;   // error logged in loadLeaderboard
      return;
    }
    if (!leaderboardLoaded) { el.innerHTML = `<div class="spinner"></div>`; return; }
    const listed = leaderboard.filter(r => r.listed);
    const mine = myLeaderboardRow();
    const note = mine && !mine.listed
      ? `<p class="lb-private">You have <b>${mine.points} points</b> from ${mine.sends} send${mine.sends !== 1 ? 's' : ''}. Only you can see this. Turn on <b>Show me on Ranks</b> in your Profile to appear here.</p>`
      : '';
    if (!listed.length) {
      el.innerHTML = note + `<div class="state-msg"><div class="icon">🏆</div>No one on Ranks yet. Send a benchmark, then turn on “Show me on Ranks” in your Profile.</div>`;
      return;
    }
    el.innerHTML = note + `<div class="problem-list">${listed.map(leaderboardRowHtml).join('')}</div>`;
  }
