import { useEffect, useRef, useState } from 'react';
import {
  getPlayerLast10,
  getTeams,
  getTodayGames,
  postManualSlate,
  searchPlayers,
  type EspnScoreboardGame,
  type ManualSlateLine,
  type Player,
  type PlayerGame,
  type RosterPlayer,
  type SlateResponse,
  type Team,
} from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';
import { TeamRosterModal } from './TeamRosterModal';
import { userKey } from './userKey';
import {
  blendedSample,
  computeHitProbability,
  isDDGame,
  SLATE_STAT_OPTIONS,
  STAT_TO_VALUE,
  suggestStrongLines,
  type SuggestedLine,
} from './slateMath';

type Slot = {
  id: string;
  player: Player | null;
  opponent: Team | null;
  lines: Record<string, string>;     // statLabel → line (string while editing)
};

// ESPN sometimes uses shorter franchise abbreviations than NBA stats.com
// (e.g. "NY" instead of "NYK"). Without an alias, the rail-click handler
// silently bails when the opponent doesn't resolve.
const ESPN_TO_NBA_ABBR: Record<string, string> = {
  NY: 'NYK',
  SA: 'SAS',
  GS: 'GSW',
  NO: 'NOP',
  WSH: 'WAS',
  UTAH: 'UTA',
};

// Cap raised from 10 → 30 to fit a full game's worth of players when
// the user pastes a complete prop sheet. Bulk paste defaults to one
// slot per parsed player.
const MAX_SLOTS = 30;

// Stat-key aliases for the bulk-paste parser. Keys are the lowercased
// short keys users typically paste (matching backend Last10StatId);
// values are the canonical labels used by the slot grid + backend
// normalizer. Lets users paste pipe-delimited prop sheets directly.
const PASTE_STAT_TO_LABEL: Record<string, string> = {
  points: 'Points',
  pts: 'Points',
  rebounds: 'Rebounds',
  reb: 'Rebounds',
  rebs: 'Rebounds',
  assists: 'Assists',
  ast: 'Assists',
  asts: 'Assists',
  three_pt_made: '3-PT Made',
  '3pt_made': '3-PT Made',
  '3pm': '3-PT Made',
  fg_made: 'FG Made',
  fgm: 'FG Made',
  fg_attempted: 'FG Attempted',
  fga: 'FG Attempted',
  ft_made: 'Free Throws Made',
  ftm: 'Free Throws Made',
  ft_attempted: 'Free Throws Attempted',
  fta: 'Free Throws Attempted',
  personal_fouls: 'Personal Fouls',
  pf: 'Personal Fouls',
  steals: 'Steals',
  stl: 'Steals',
  blocks: 'Blocked Shots',
  blk: 'Blocked Shots',
  turnovers: 'Turnovers',
  tov: 'Turnovers',
  to: 'Turnovers',
  offensive_rebounds: 'Offensive Rebounds',
  oreb: 'Offensive Rebounds',
  defensive_rebounds: 'Defensive Rebounds',
  dreb: 'Defensive Rebounds',
  pra: 'Pts+Rebs+Asts',
  pr: 'Pts+Rebs',
  pa: 'Pts+Asts',
  ra: 'Rebs+Asts',
  stocks: 'Blks+Stls',
  double_double: 'Double-Double',
  dd: 'Double-Double',
};
const newSlot = (): Slot => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  player: null,
  opponent: null,
  lines: {},
});

type Props = {
  onResult: (response: SlateResponse) => void;
};

// localStorage key for today's pasted slate. Keyed by ISO date so a new
// slate starts every day automatically — and userKey'd so two people
// sharing a browser don't see each other's picks.
function slateStorageKey(): string {
  const today = new Date().toISOString().slice(0, 10);
  return userKey(`slate:saved:${today}`);
}

// Slot serialized for persistence. We strip the random `id` since it's
// re-minted each load, and store the player/opponent as plain JSON.
type StoredSlot = {
  player: Player;
  opponent: Team | null;
  lines: Record<string, string>;
};

function loadStoredSlots(): Slot[] | null {
  try {
    const raw = localStorage.getItem(slateStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSlot[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.map((s) => ({
      ...newSlot(),
      player: s.player,
      opponent: s.opponent,
      lines: s.lines ?? {},
    }));
  } catch {
    return null;
  }
}

function saveStoredSlots(slots: Slot[]): void {
  try {
    const serializable: StoredSlot[] = slots
      .filter((s) => s.player !== null)
      .map((s) => ({ player: s.player!, opponent: s.opponent, lines: s.lines }));
    if (serializable.length === 0) {
      localStorage.removeItem(slateStorageKey());
    } else {
      localStorage.setItem(slateStorageKey(), JSON.stringify(serializable));
    }
  } catch { /* quota / disabled — ignore */ }
}

// L10 cache entry. We keep the raw gameLog around so we can compute both
// per-stat averages AND live hit probabilities on the fly (including
// dedup'd L10 + vs-opp blends when an opponent is set).
type PlayerL10 = {
  loading: boolean;
  gameLog: PlayerGame[];
};

export function SlateManualEntry({ onResult }: Props) {
  // Hydrate today's slate from localStorage on first render. Falls back
  // to a single empty slot if there's nothing saved (or if the user
  // already cleared today's storage).
  const [slots, setSlots] = useState<Slot[]>(() => loadStoredSlots() ?? [newSlot()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [todayGames, setTodayGames] = useState<EspnScoreboardGame[]>([]);
  // When set, opens the dual-team game-picker modal. We always pass BOTH
  // sides of the matchup so the user can pick from either roster.
  const [rosterPick, setRosterPick] = useState<{ home: Team; away: Team } | null>(null);
  const [l10Cache, setL10Cache] = useState<Record<number, PlayerL10>>({});

  useEffect(() => {
    getTeams().then(setTeams).catch(() => setTeams([]));
    getTodayGames()
      .then((d) => setTodayGames(d.games))
      .catch(() => setTodayGames([]));
  }, []);

  // Debounced persistence — every change to the slot grid (paste, edit,
  // add, remove) gets saved to localStorage so a refresh restores
  // exactly where the user left off.
  useEffect(() => {
    const t = setTimeout(() => saveStoredSlots(slots), 400);
    return () => clearTimeout(t);
  }, [slots]);

  function clearSlate() {
    try { localStorage.removeItem(slateStorageKey()); } catch { /* ignore */ }
    setSlots([newSlot()]);
  }

  // Lazily fetch L10 game logs for any picked player we don't have yet.
  // Mark loading=true synchronously to prevent double-fetches on rapid
  // re-renders. Cached forever (per session) since L10 only changes
  // overnight.
  useEffect(() => {
    const ids = Array.from(
      new Set(slots.map((s) => s.player?.id).filter((x): x is number => typeof x === 'number')),
    );
    const missing = ids.filter((id) => !l10Cache[id]);
    if (missing.length === 0) return;
    setL10Cache((prev) => {
      const next = { ...prev };
      for (const id of missing) {
        if (!next[id]) next[id] = { loading: true, gameLog: [] };
      }
      return next;
    });
    for (const id of missing) {
      getPlayerLast10(id, 'points')
        .then((r) => {
          setL10Cache((prev) => ({
            ...prev,
            [id]: { loading: false, gameLog: r.gameLog ?? [] },
          }));
        })
        .catch(() => {
          setL10Cache((prev) => ({
            ...prev,
            [id]: { loading: false, gameLog: [] },
          }));
        });
    }
  }, [slots, l10Cache]);

  function teamByAbbr(abbr: string): Team | null {
    const canonical = ESPN_TO_NBA_ABBR[abbr] ?? abbr;
    return teams.find((t) => t.abbreviation === canonical) ?? null;
  }

  // Click a team in the today's-games rail. We open the dual-team
  // picker AND immediately stamp the opponent on the first empty slot —
  // even if the user closes the modal without picking, they keep the
  // matchup context.
  function openGameFor(homeAbbr: string, awayAbbr: string, clickedSide: 'home' | 'away') {
    const home = teamByAbbr(homeAbbr);
    const away = teamByAbbr(awayAbbr);
    if (!home || !away) return;
    setRosterPick({ home, away });
    // Pre-stamp opponent on the first empty slot. If the user clicked the
    // home team, their player is presumed home → opponent is away. Vice
    // versa. (The modal lets them pick from either side anyway and will
    // overwrite this when they do.)
    const presumedOpp = clickedSide === 'home' ? away : home;
    setSlots((prev) => {
      const empty = prev.findIndex((s) => !s.player && Object.keys(s.lines).length === 0);
      if (empty === -1) return prev;
      return prev.map((s, i) => (i === empty ? { ...s, opponent: presumedOpp } : s));
    });
  }

  // Modal callback — assigns picked player to the first empty slot (or
  // appends), and overwrites opponent based on which side they picked.
  function addSlotForPlayer(player: Player | RosterPlayer, opponent: Team) {
    setSlots((prev) => {
      const empty = prev.findIndex((s) => !s.player && Object.keys(s.lines).length === 0);
      if (empty !== -1) {
        return prev.map((s, i) => (i === empty ? { ...s, player, opponent } : s));
      }
      if (prev.length >= MAX_SLOTS) return prev;
      const filled: Slot = { ...newSlot(), player, opponent };
      return [...prev, filled];
    });
  }

  function update(idx: number, patch: Partial<Slot>) {
    setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  function updateLine(idx: number, statLabel: string, value: string) {
    setSlots((prev) =>
      prev.map((s, i) => {
        if (i !== idx) return s;
        const next = { ...s.lines };
        if (value.trim() === '') delete next[statLabel];
        else next[statLabel] = value;
        return { ...s, lines: next };
      }),
    );
  }

  function addSlot() {
    if (slots.length >= MAX_SLOTS) return;
    setSlots((prev) => [...prev, newSlot()]);
  }

  function removeSlot(idx: number) {
    setSlots((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  // Bulk-paste import. Accepts pipe / tab / comma-delimited rows of:
  //   PlayerName | TeamAbbr | statKey | lineValue [| direction]
  // Lines for the same player are grouped into a single slot. Opponent
  // is auto-derived: if exactly two teams appear in the paste, every
  // player's opponent is set to the OTHER team. Returns parse stats so
  // we can surface "imported X lines, skipped Y" feedback.
  async function importBulkPaste(text: string): Promise<{
    slotsCreated: number;
    linesImported: number;
    errors: { line: string; reason: string }[];
  }> {
    const errors: { line: string; reason: string }[] = [];
    type Parsed = { playerName: string; teamAbbr: string; statLabel: string; line: number };
    const parsed: Parsed[] = [];

    const rawLines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    for (const raw of rawLines) {
      const fields = raw.split(/[|\t]/).map((f) => f.trim());
      if (fields.length < 4) {
        errors.push({ line: raw, reason: 'expected at least 4 fields (Player|Team|stat|line)' });
        continue;
      }
      const [name, team, statKey, lineStr] = fields;
      const statLabel = PASTE_STAT_TO_LABEL[statKey.toLowerCase()];
      if (!statLabel) {
        errors.push({ line: raw, reason: `unknown stat "${statKey}"` });
        continue;
      }
      const lineNum = parseFloat(lineStr);
      if (!Number.isFinite(lineNum)) {
        errors.push({ line: raw, reason: `invalid line value "${lineStr}"` });
        continue;
      }
      parsed.push({
        playerName: name,
        teamAbbr: ESPN_TO_NBA_ABBR[team.toUpperCase()] ?? team.toUpperCase(),
        statLabel,
        line: lineNum,
      });
    }
    if (parsed.length === 0) {
      return { slotsCreated: 0, linesImported: 0, errors };
    }

    // Auto-detect matchup: if exactly two distinct teams appear, pair
    // them up so each slot's opponent is the other team. With 1 team or
    // 3+ teams, we leave opponent unset (user can pick per slot).
    const distinctTeams = Array.from(new Set(parsed.map((p) => p.teamAbbr)));
    const opponentByTeam: Record<string, Team | null> = {};
    if (distinctTeams.length === 2) {
      const teamA = teams.find((t) => t.abbreviation === distinctTeams[0]) ?? null;
      const teamB = teams.find((t) => t.abbreviation === distinctTeams[1]) ?? null;
      opponentByTeam[distinctTeams[0]] = teamB;
      opponentByTeam[distinctTeams[1]] = teamA;
    }

    // Group by player. We need the actual Player object (with NBA id)
    // so the L10 fetch + projection engine work — fall back to a name-
    // only stub when search misses, but warn the user.
    const playersByName = new Map<string, Parsed[]>();
    for (const p of parsed) {
      const key = p.playerName;
      const arr = playersByName.get(key) ?? [];
      arr.push(p);
      playersByName.set(key, arr);
    }

    // Resolve names → Player objects via the search API in parallel.
    // Pick the top match whose team matches the pasted team, falling
    // back to first result otherwise.
    const resolved: { name: string; player: Player | null; teamAbbr: string }[] =
      await Promise.all(
        Array.from(playersByName.entries()).map(async ([name, lines]) => {
          const teamAbbr = lines[0].teamAbbr;
          try {
            const list = await searchPlayers(name);
            const onTeam = list.find((p) => p.teamAbbreviation === teamAbbr);
            return { name, player: onTeam ?? list[0] ?? null, teamAbbr };
          } catch {
            return { name, player: null, teamAbbr };
          }
        }),
      );

    const newSlots: Slot[] = [];
    let unmatched = 0;
    for (const { name, player, teamAbbr } of resolved) {
      if (!player) { unmatched++; continue; }
      const lines = playersByName.get(name) ?? [];
      const linesMap: Record<string, string> = {};
      for (const l of lines) linesMap[l.statLabel] = String(l.line);
      newSlots.push({
        ...newSlot(),
        player,
        opponent: opponentByTeam[teamAbbr] ?? null,
        lines: linesMap,
      });
    }
    if (unmatched > 0) {
      errors.push({
        line: '',
        reason: `${unmatched} player${unmatched === 1 ? '' : 's'} couldn't be matched in the database — those lines were dropped.`,
      });
    }

    if (newSlots.length === 0) {
      return { slotsCreated: 0, linesImported: 0, errors };
    }

    // Replace the slot list. Cap at MAX_SLOTS — anything over gets
    // surfaced as a parser error so the user knows to trim.
    if (newSlots.length > MAX_SLOTS) {
      errors.push({
        line: '',
        reason: `${newSlots.length} players parsed but slot cap is ${MAX_SLOTS} — truncating.`,
      });
    }
    const capped = newSlots.slice(0, MAX_SLOTS);
    setSlots(capped);
    return {
      slotsCreated: capped.length,
      linesImported: capped.reduce((n, s) => n + Object.keys(s.lines).length, 0),
      errors,
    };
  }

  async function buildSlate() {
    setError(null);
    const ready: ManualSlateLine[] = [];
    for (const s of slots) {
      if (!s.player) continue;
      for (const [statLabel, raw] of Object.entries(s.lines)) {
        const lineNum = parseFloat(raw);
        if (!Number.isFinite(lineNum) || lineNum <= 0) continue;
        ready.push({
          playerName: s.player.fullName,
          statLabel,
          line: lineNum,
          team: s.player.teamAbbreviation ?? undefined,
          opponentAbbr: s.opponent?.abbreviation ?? null,
        });
      }
    }
    if (ready.length === 0) {
      setError('Pick at least one player and enter a numeric line for any stat.');
      return;
    }
    setSubmitting(true);
    try {
      const response = await postManualSlate(ready);
      onResult(response);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const filledLineCount = slots.reduce((n, s) => {
    if (!s.player) return n;
    return n + Object.values(s.lines).filter((v) => parseFloat(v) > 0).length;
  }, 0);

  return (
    <div className="manual-entry">
      <p className="muted">
        Add up to {MAX_SLOTS} players. Enter a line for any stats you want
        graded — every non-empty line becomes its own card. Probabilities
        update live as you type.
      </p>

      {todayGames.length > 0 && (
        <div className="today-rail">
          <div className="today-rail-head">
            <span className="recents-title">Tonight's games</span>
            <span className="muted small">
              Click a team to pick a player from either roster — opponent fills in automatically.
            </span>
          </div>
          <div className="today-rail-list">
            {todayGames.map((g) => (
              <div key={g.id} className="today-game">
                <div className="today-game-status">{g.status.detail}</div>
                <button
                  className="today-side"
                  type="button"
                  onClick={() => openGameFor(g.home.abbreviation, g.away.abbreviation, 'away')}
                  title={`${g.away.displayName} @ ${g.home.displayName}`}
                >
                  <TeamLogo abbr={g.away.abbreviation} name={g.away.displayName} size="md" />
                  <span className="today-side-abbr">{g.away.abbreviation}</span>
                  {g.away.record && <span className="muted small">{g.away.record}</span>}
                </button>
                <span className="today-at">@</span>
                <button
                  className="today-side"
                  type="button"
                  onClick={() => openGameFor(g.home.abbreviation, g.away.abbreviation, 'home')}
                  title={`${g.away.displayName} @ ${g.home.displayName}`}
                >
                  <TeamLogo abbr={g.home.abbreviation} name={g.home.displayName} size="md" />
                  <span className="today-side-abbr">{g.home.abbreviation}</span>
                  {g.home.record && <span className="muted small">{g.home.record}</span>}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <BulkPasteSection
        onImport={importBulkPaste}
        slotCount={slots.filter((s) => s.player).length}
        onClear={clearSlate}
      />

      <div className="manual-slots">
        {slots.map((s, idx) => (
          <ManualSlotRow
            key={s.id}
            index={idx}
            slot={s}
            teams={teams}
            l10={s.player ? l10Cache[s.player.id] : undefined}
            onChange={(p) => update(idx, p)}
            onLineChange={(stat, val) => updateLine(idx, stat, val)}
            onRemove={() => removeSlot(idx)}
            canRemove={slots.length > 1}
          />
        ))}
      </div>

      <div className="manual-actions">
        <button
          type="button"
          className="cta"
          onClick={addSlot}
          disabled={slots.length >= MAX_SLOTS}
        >
          + Add another ({slots.length}/{MAX_SLOTS})
        </button>
        <button
          type="button"
          className="cta primary"
          onClick={buildSlate}
          disabled={submitting || filledLineCount === 0}
        >
          {submitting ? 'Building…' : `Build slate (${filledLineCount} ${filledLineCount === 1 ? 'line' : 'lines'}) →`}
        </button>
      </div>

      {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}

      {rosterPick && (
        <TeamRosterModal
          home={rosterPick.home}
          away={rosterPick.away}
          onPick={(player, opponent) => addSlotForPlayer(player, opponent)}
          onClose={() => setRosterPick(null)}
        />
      )}
    </div>
  );
}

function ManualSlotRow({
  index,
  slot,
  teams,
  l10,
  onChange,
  onLineChange,
  onRemove,
  canRemove,
}: {
  index: number;
  slot: Slot;
  teams: Team[];
  l10: PlayerL10 | undefined;
  onChange: (patch: Partial<Slot>) => void;
  onLineChange: (statLabel: string, value: string) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Player[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    const ctrl = new AbortController();
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const list = await searchPlayers(q, ctrl.signal);
        setResults(list.slice(0, 6));
      } catch { /* ignore */ }
      finally { setSearching(false); }
    }, 200);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [query]);

  function pickPlayer(p: Player) {
    onChange({ player: p });
    setQuery('');
    setResults([]);
    setShowResults(false);
  }

  // Pre-compute the blended sample once per render — every stat reads
  // off it for both the hint avg and the live hit-prob. Keeps things
  // cheap even with 16 stats × 10 slots = 160 reads.
  const sample = l10 && l10.gameLog.length > 0
    ? blendedSample(l10.gameLog, slot.opponent?.abbreviation ?? null)
    : [];

  const filledLineCount = Object.values(slot.lines).filter((v) => parseFloat(v) > 0).length;

  return (
    <div className="manual-slot-card">
      <div className="manual-slot-head">
        <div className="manual-slot-num">{index + 1}</div>

        <div className="manual-slot-player" ref={wrapRef}>
          {slot.player ? (
            <div className="manual-slot-picked">
              <PlayerAvatar playerId={slot.player.id} name={slot.player.fullName} size="md" />
              <span className="manual-slot-name">{slot.player.fullName}</span>
              <span className="muted small">{slot.player.teamAbbreviation ?? '—'}</span>
              <button className="link" onClick={() => onChange({ player: null })}>change</button>
            </div>
          ) : (
            <>
              <input
                className="manual-slot-input"
                type="search"
                placeholder="Search player…"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setShowResults(true); }}
                onFocus={() => setShowResults(true)}
              />
              {showResults && query.trim() && (
                <div className="manual-slot-results">
                  {searching && results.length === 0 && <div className="muted small" style={{ padding: 8 }}>Searching…</div>}
                  {!searching && results.length === 0 && <div className="muted small" style={{ padding: 8 }}>No matches</div>}
                  {results.map((p) => (
                    <button key={p.id} className="manual-slot-result" onClick={() => pickPlayer(p)}>
                      <PlayerAvatar playerId={p.id} name={p.fullName} size="md" />
                      <span style={{ flex: 1 }}>{p.fullName}</span>
                      <span className="muted small">{p.teamAbbreviation ?? '—'}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <select
          className="manual-slot-select"
          value={slot.opponent?.id ?? ''}
          onChange={(e) => {
            const id = Number(e.target.value);
            onChange({ opponent: teams.find((t) => t.id === id) ?? null });
          }}
          title="Tonight's opponent — unlocks vs-opp history blend"
        >
          <option value="">vs ?</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              vs {t.abbreviation}
            </option>
          ))}
        </select>

        {slot.opponent && (
          <TeamLogo abbr={slot.opponent.abbreviation} name={slot.opponent.fullName} size="md" />
        )}

        <span className="muted small manual-slot-count">
          {filledLineCount} line{filledLineCount === 1 ? '' : 's'}
        </span>

        {canRemove && (
          <button
            className="manual-slot-remove"
            onClick={onRemove}
            title="Remove this player"
            aria-label="Remove this player"
          >
            ✕
          </button>
        )}
      </div>

      {slot.player && l10 && !l10.loading && l10.gameLog.length > 0 && (
        <SuggestStrip
          gameLog={l10.gameLog}
          opponentAbbr={slot.opponent?.abbreviation ?? null}
          opponentName={slot.opponent?.abbreviation ?? null}
          existingLines={slot.lines}
          onApply={(picks) => {
            for (const p of picks) onLineChange(p.stat, String(p.line));
          }}
        />
      )}

      <div className="manual-slot-grid">
        {SLATE_STAT_OPTIONS.map((stat) => {
          const isDD = stat === 'Double-Double';
          const get = STAT_TO_VALUE[stat];
          const values = sample.map(get);
          const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined;

          // Hint chip text (L10/blended avg or DD rate)
          let hintText = '';
          if (slot.player) {
            if (l10?.loading) hintText = '…';
            else if (avg !== undefined) {
              hintText = isDD ? `${Math.round(avg * 100)}%` : `avg ${avg.toFixed(1)}`;
            }
          }
          const suggested = avg === undefined || isDD ? null : Math.floor(avg) + 0.5;

          // Live hit-prob — only for numeric stats with a parseable line
          const rawLine = slot.lines[stat] ?? '';
          const lineNum = parseFloat(rawLine);
          let live: { pct: number; lean: 'OVER' | 'UNDER'; tone: 'hot' | 'mid' | 'cold' } | null = null;
          if (!isDD && Number.isFinite(lineNum) && lineNum > 0 && values.length > 0) {
            const hp = computeHitProbability(values, lineNum);
            const tone = hp.mightHitPct >= 70 ? 'hot' : hp.mightHitPct >= 55 ? 'mid' : 'cold';
            live = { pct: hp.mightHitPct, lean: hp.lean, tone };
          } else if (isDD && values.length > 0) {
            // DD has no line; surface the rate inline so the user
            // can decide if it's worth a card.
            const ddRate = values.filter((v) => v > 0).length / values.length;
            const pct = Math.round(ddRate * 100);
            const tone = pct >= 50 ? 'hot' : pct >= 30 ? 'mid' : 'cold';
            // Show only when the user has 'opted in' by entering anything in the cell.
            if (rawLine.trim() !== '' || slot.lines[stat] !== undefined) {
              live = { pct, lean: 'OVER', tone };
            }
          }

          return (
            <label key={stat} className="manual-stat-cell">
              <div className="manual-stat-info">
                <span className="manual-stat-label">{stat}</span>
                {hintText && (
                  <button
                    type="button"
                    className="manual-stat-hint"
                    onClick={() => suggested !== null && onLineChange(stat, String(suggested))}
                    disabled={suggested === null}
                    title={suggested !== null ? `Use ${suggested}` : 'Reference only'}
                  >
                    {slot.opponent && sample.length > 10 ? `${hintText} ▲` : hintText}
                  </button>
                )}
              </div>
              <div className="manual-stat-input-wrap">
                <input
                  className="manual-stat-input"
                  type="number"
                  inputMode="decimal"
                  step="0.5"
                  placeholder="—"
                  value={slot.lines[stat] ?? ''}
                  onChange={(e) => onLineChange(stat, e.target.value)}
                  disabled={!slot.player}
                />
                {live && (
                  <span className={`manual-stat-live ${live.tone}`}>
                    {live.lean === 'OVER' ? '↑' : '↓'} {live.pct}%
                  </span>
                )}
              </div>
            </label>
          );
        })}
      </div>

      {/* Per-player meta strip — only shown once a player is set. */}
      {slot.player && l10 && !l10.loading && (
        <div className="manual-slot-meta muted small">
          <span>L10 {l10.gameLog.slice(0, 10).length} games</span>
          {slot.opponent && (
            <span>
              · vs {slot.opponent.abbreviation}{' '}
              {l10.gameLog.filter((g) => g.opponentAbbr === slot.opponent!.abbreviation).length}{' '}
              this season (blended into the live %)
            </span>
          )}
          <span>· DD rate {Math.round(
            l10.gameLog.slice(0, 10).filter(isDDGame).length /
              Math.max(1, l10.gameLog.slice(0, 10).length) * 100,
          )}%</span>
        </div>
      )}
    </div>
  );
}

// "Suggest strong lines" affordance. Scans every numeric stat for the
// picked player, pricing each at the typical PrizePicks half-step line,
// and ranks by the same hit-prob math we run on Build slate. Click
// 'Auto-fill' to drop the top candidates into the grid; the live chips
// in the grid then light up green so the user gets immediate receipts.
function SuggestStrip({
  gameLog,
  opponentAbbr,
  opponentName,
  existingLines,
  onApply,
}: {
  gameLog: import('./api').PlayerGame[];
  opponentAbbr: string | null;
  opponentName: string | null;
  existingLines: Record<string, string>;
  onApply: (picks: SuggestedLine[]) => void;
}) {
  const [picks, setPicks] = useState<SuggestedLine[] | null>(null);
  const [empty, setEmpty] = useState(false);

  function run() {
    const out = suggestStrongLines(gameLog, opponentAbbr, 3);
    if (out.length === 0) {
      setPicks(null);
      setEmpty(true);
      return;
    }
    setEmpty(false);
    // Skip stats the user already entered — don't clobber their work.
    const fresh = out.filter((p) => !existingLines[p.stat]);
    setPicks(out);
    if (fresh.length > 0) onApply(fresh);
  }

  return (
    <div className="suggest-strip">
      <button
        type="button"
        className="suggest-btn"
        onClick={run}
        title={opponentAbbr
          ? `Auto-fill the strongest 3 lines based on L10 + season vs ${opponentAbbr}`
          : `Auto-fill the strongest 3 lines based on L10 (set an opponent for vs-opp blend)`}
      >
        ✨ Suggest strong lines
      </button>

      {picks && picks.length > 0 && (
        <div className="suggest-results">
          {picks.map((p) => (
            <span
              key={p.stat}
              className={`suggest-pill ${p.mightHitPct >= 75 ? 'hot' : 'mid'}`}
              title={`${p.stat} ${p.line}: hit ${Math.round(p.hitOver * 100)}% over ${p.sampleSize} games${
                p.vsOppCount > 0 ? ` (${p.vsOppCount} vs ${opponentName})` : ''
              }`}
            >
              {p.stat} {p.line} {p.lean === 'OVER' ? '↑' : '↓'} {p.mightHitPct}%
            </span>
          ))}
        </div>
      )}

      {empty && (
        <span className="muted small">
          No stat hits 60% confidence yet — try setting an opponent or pick a different player.
        </span>
      )}
    </div>
  );
}

// Collapsible textarea for pasting an entire prop sheet at once. Each
// row is parsed, grouped by player, and one slot per player drops into
// the grid with all their lines pre-filled. Lines stay editable in the
// grid before the user clicks Build slate, so they can override any
// number they disagree with.
function BulkPasteSection({
  onImport,
  slotCount,
  onClear,
}: {
  onImport: (text: string) => Promise<{
    slotsCreated: number;
    linesImported: number;
    errors: { line: string; reason: string }[];
  }>;
  slotCount: number;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<{
    slotsCreated: number;
    linesImported: number;
    errors: { line: string; reason: string }[];
  } | null>(null);

  async function run() {
    if (!text.trim()) return;
    setImporting(true);
    try {
      const r = await onImport(text);
      setReport(r);
      // Auto-collapse on success so the user sees the populated grid.
      if (r.slotsCreated > 0 && r.errors.length === 0) {
        setOpen(false);
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="bulk-paste">
      <div className="bulk-paste-head">
        <button
          type="button"
          className="bulk-paste-toggle"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'} Paste a full prop sheet (one line per row)
        </button>
        {slotCount > 0 && (
          <div className="bulk-paste-saved">
            <span className="muted small">
              Today's slate: {slotCount} player{slotCount === 1 ? '' : 's'} loaded
            </span>
            <button
              type="button"
              className="link"
              onClick={() => {
                if (confirm('Clear today\'s saved slate and start fresh?')) onClear();
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="bulk-paste-body">
          <p className="muted small" style={{ marginTop: 0 }}>
            Format: <code>Player|Team|stat|line</code> — one row per prop.
            Stats: points, rebounds, assists, pra, pr, pa, ra, three_pt_made,
            fg_made, ft_made, steals, blocks, turnovers, stocks, double_double,
            and the rest. Optional 5th field (over/under/both) is ignored.
          </p>
          <textarea
            className="bulk-paste-input"
            placeholder={'Jalen Brunson|NYK|points|26.5|both\nKarl-Anthony Towns|NYK|rebounds|11|both\n…'}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={importing}
          />
          <div className="bulk-paste-actions">
            <button
              type="button"
              className="cta primary"
              onClick={run}
              disabled={importing || !text.trim()}
            >
              {importing ? 'Importing…' : 'Parse & populate slots'}
            </button>
            <button
              type="button"
              className="cta"
              onClick={() => { setText(''); setReport(null); }}
              disabled={importing}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      {report && (
        <div className={`bulk-paste-report ${report.errors.length > 0 ? 'warn' : 'ok'}`}>
          <strong>
            Imported {report.linesImported} line{report.linesImported === 1 ? '' : 's'}{' '}
            across {report.slotsCreated} player{report.slotsCreated === 1 ? '' : 's'}.
          </strong>
          {report.errors.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary>{report.errors.length} skipped — show details</summary>
              <ul className="bulk-paste-errors">
                {report.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>
                    {e.line && <code>{e.line}</code>} {e.reason}
                  </li>
                ))}
                {report.errors.length > 20 && (
                  <li className="muted">…and {report.errors.length - 20} more</li>
                )}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
