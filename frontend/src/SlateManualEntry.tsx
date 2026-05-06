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
import {
  blendedSample,
  computeHitProbability,
  isDDGame,
  SLATE_STAT_OPTIONS,
  STAT_TO_VALUE,
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

// L10 cache entry. We keep the raw gameLog around so we can compute both
// per-stat averages AND live hit probabilities on the fly (including
// dedup'd L10 + vs-opp blends when an opponent is set).
type PlayerL10 = {
  loading: boolean;
  gameLog: PlayerGame[];
};

export function SlateManualEntry({ onResult }: Props) {
  const [slots, setSlots] = useState<Slot[]>([newSlot()]);
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
