// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, leaderboard, app. This file:
// the public all-time points leaderboard (the leaderboard() RPC is the single source of
// truth for the scoring formula — see db/23).

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

  // The signed-in user's total points, read back from the cached ranking (so the
  // profile and the leaderboard never disagree). null if not loaded / not present.
  function userPoints() {
    if (!session) return null;
    const row = leaderboard.find(r => String(r.user_id) === String(session.user.id));
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
      el.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>${
        rpcMissing(leaderboardError)
          ? 'Leaderboard isn’t set up yet — run <b>db/23</b> in the Supabase SQL editor.'
          : 'Couldn’t load the leaderboard.'}</div>`;
      return;
    }
    if (!leaderboardLoaded) { el.innerHTML = `<div class="spinner"></div>`; return; }
    if (!leaderboard.length) {
      el.innerHTML = `<div class="state-msg"><div class="icon">🏆</div>No sends yet — tick a problem to get on the board.</div>`;
      return;
    }
    el.innerHTML = `<div class="problem-list">${leaderboard.map(leaderboardRowHtml).join('')}</div>`;
  }
