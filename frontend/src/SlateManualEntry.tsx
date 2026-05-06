import { useEffect, useRef, useState } from 'react';
import {
  getTeams,
  getTodayGames,
  postManualSlate,
  searchPlayers,
  type EspnScoreboardGame,
  type ManualSlateLine,
  type Player,
  type RosterPlayer,
  type SlateResponse,
  type Team,
} from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';
import { TeamRosterModal } from './TeamRosterModal';

// Each slot is one player + one opponent. The user can enter a line for
// any subset of the 16 canonical stats; we expand each non-empty entry
// into its own ManualSlateLine on submit, so a single slot can produce
// up to 16 cards in the result grid.
type Slot = {
  id: string;
  player: Player | null;
  opponent: Team | null;
  lines: Record<string, string>;     // statLabel → line (string while editing)
};

const STAT_OPTIONS: string[] = [
  'Points',
  'Rebounds',
  'Assists',
  'Pts+Rebs+Asts',
  'Pts+Rebs',
  'Pts+Asts',
  'Rebs+Asts',
  '3-PT Made',
  'Steals',
  'Blocked Shots',
  'Turnovers',
  'Blks+Stls',
  'FG Made',
  'Free Throws Made',
  'Personal Fouls',
  'Double-Double',
];

const MAX_SLOTS = 10;
const newSlot = (): Slot => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  player: null,
  opponent: null,
  lines: {},
});

type Props = {
  onResult: (response: SlateResponse) => void;
};

export function SlateManualEntry({ onResult }: Props) {
  const [slots, setSlots] = useState<Slot[]>([newSlot()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [todayGames, setTodayGames] = useState<EspnScoreboardGame[]>([]);
  // When set, opens the roster picker modal for the chosen team. The
  // matched opponent is what we pre-fill the new slot with.
  const [rosterPick, setRosterPick] = useState<{ team: Team; opponent: Team } | null>(null);

  useEffect(() => {
    getTeams().then(setTeams).catch(() => setTeams([]));
    getTodayGames()
      .then((d) => setTodayGames(d.games))
      .catch(() => setTodayGames([]));
  }, []);

  function teamByAbbr(abbr: string): Team | null {
    return teams.find((t) => t.abbreviation === abbr) ?? null;
  }

  // Click a team in the today's-games rail → open the roster picker
  // for that team. Pre-stash the matched opponent so when the user picks
  // a player from the modal we can drop them into a fully-filled slot.
  function openRosterFor(playerTeamAbbr: string, opponentAbbr: string) {
    const team = teamByAbbr(playerTeamAbbr);
    const opp = teamByAbbr(opponentAbbr);
    if (team && opp) setRosterPick({ team, opponent: opp });
  }

  // Called when the user picks a player from the roster modal. Reuses
  // an empty slot if there is one, otherwise appends a new slot.
  function addSlotForPlayer(player: RosterPlayer, opponent: Team) {
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
        Add up to {MAX_SLOTS} players. For each player, enter a line for any
        stats you want graded — every non-empty line becomes its own card.
      </p>

      {todayGames.length > 0 && (
        <div className="today-rail">
          <div className="today-rail-head">
            <span className="recents-title">Tonight's games</span>
            <span className="muted small">
              Click a team to pick a player — opponent gets filled in for you.
            </span>
          </div>
          <div className="today-rail-list">
            {todayGames.map((g) => (
              <div key={g.id} className="today-game">
                <div className="today-game-status">{g.status.detail}</div>
                <button
                  className="today-side"
                  type="button"
                  onClick={() => openRosterFor(g.away.abbreviation, g.home.abbreviation)}
                  title={`Pick a ${g.away.displayName} player (opponent: ${g.home.abbreviation})`}
                >
                  <TeamLogo abbr={g.away.abbreviation} name={g.away.displayName} size="md" />
                  <span className="today-side-abbr">{g.away.abbreviation}</span>
                  {g.away.record && <span className="muted small">{g.away.record}</span>}
                </button>
                <span className="today-at">@</span>
                <button
                  className="today-side"
                  type="button"
                  onClick={() => openRosterFor(g.home.abbreviation, g.away.abbreviation)}
                  title={`Pick a ${g.home.displayName} player (opponent: ${g.away.abbreviation})`}
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

      <div className="manual-slots">
        {slots.map((s, idx) => (
          <ManualSlotRow
            key={s.id}
            index={idx}
            slot={s}
            teams={teams}
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
          team={rosterPick.team}
          opponent={rosterPick.opponent}
          onPick={(player) => addSlotForPlayer(player, rosterPick.opponent)}
          onClose={() => setRosterPick(null)}
        />
      )}
    </div>
  );
}

// One row in the manual-entry list. Self-contained: handles its own
// player-search dropdown, opponent picker, and the per-stat line grid.
function ManualSlotRow({
  index,
  slot,
  teams,
  onChange,
  onLineChange,
  onRemove,
  canRemove,
}: {
  index: number;
  slot: Slot;
  teams: Team[];
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

  const filledLineCount = Object.values(slot.lines).filter((v) => parseFloat(v) > 0).length;

  return (
    <div className="manual-slot-card">
      <div className="manual-slot-head">
        <div className="manual-slot-num">{index + 1}</div>

        {/* Player picker */}
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

        {/* Opponent (optional but unlocks vs-opp blend) */}
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

      {/* Per-stat line grid — leave any cell blank to skip that stat */}
      <div className="manual-slot-grid">
        {STAT_OPTIONS.map((stat) => (
          <label key={stat} className="manual-stat-cell">
            <span className="manual-stat-label">{stat}</span>
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
          </label>
        ))}
      </div>
    </div>
  );
}
