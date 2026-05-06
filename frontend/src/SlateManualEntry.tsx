import { useEffect, useRef, useState } from 'react';
import {
  getTeams,
  postManualSlate,
  searchPlayers,
  type ManualSlateLine,
  type Player,
  type SlateResponse,
  type Team,
} from './api';
import { PlayerAvatar, TeamLogo } from './Avatar';

type Slot = {
  id: string;
  player: Player | null;
  statLabel: string;
  line: string;          // string while editing, parsed on submit
  opponent: Team | null;
};

// Canonical stat labels we offer in the dropdown. These are the same
// strings the backend's slateNormalize.ts maps to its internal Last10StatId
// keys, so they round-trip cleanly.
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
  statLabel: 'Points',
  line: '',
  opponent: null,
});

type Props = {
  onResult: (response: SlateResponse) => void;
};

export function SlateManualEntry({ onResult }: Props) {
  const [slots, setSlots] = useState<Slot[]>([newSlot()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);

  useEffect(() => {
    getTeams().then(setTeams).catch(() => setTeams([]));
  }, []);

  function update(idx: number, patch: Partial<Slot>) {
    setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
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
      const lineNum = parseFloat(s.line);
      if (!Number.isFinite(lineNum)) continue;
      ready.push({
        playerName: s.player.fullName,
        statLabel: s.statLabel,
        line: lineNum,
        team: s.player.teamAbbreviation ?? undefined,
        opponentAbbr: s.opponent?.abbreviation ?? null,
      });
    }
    if (ready.length === 0) {
      setError('Pick at least one player and enter a numeric line.');
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

  const filledCount = slots.filter((s) => s.player && parseFloat(s.line) > 0).length;

  return (
    <div className="manual-entry">
      <p className="muted">
        Add up to {MAX_SLOTS} players, pick a stat, enter the line. We'll pull
        each player's last 10 games and compute hit probability against your
        line. Adding tonight's opponent unlocks the vs-opp historical row.
      </p>

      <div className="manual-slots">
        {slots.map((s, idx) => (
          <ManualSlotRow
            key={s.id}
            index={idx}
            slot={s}
            teams={teams}
            onChange={(p) => update(idx, p)}
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
          disabled={submitting || filledCount === 0}
        >
          {submitting ? 'Building…' : `Build slate (${filledCount} ${filledCount === 1 ? 'pick' : 'picks'}) →`}
        </button>
      </div>

      {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
    </div>
  );
}

// One row in the manual-entry list. Self-contained: handles its own
// player-search dropdown so the parent doesn't have to manage focus.
function ManualSlotRow({
  index,
  slot,
  teams,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number;
  slot: Slot;
  teams: Team[];
  onChange: (patch: Partial<Slot>) => void;
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

  return (
    <div className="manual-slot">
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

      {/* Stat picker */}
      <select
        className="manual-slot-select"
        value={slot.statLabel}
        onChange={(e) => onChange({ statLabel: e.target.value })}
      >
        {STAT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>

      {/* Line input */}
      <input
        className="manual-slot-line"
        type="number"
        inputMode="decimal"
        step="0.5"
        placeholder="line"
        value={slot.line}
        onChange={(e) => onChange({ line: e.target.value })}
      />

      {/* Opponent (optional) */}
      <select
        className="manual-slot-select"
        value={slot.opponent?.id ?? ''}
        onChange={(e) => {
          const id = Number(e.target.value);
          onChange({ opponent: teams.find((t) => t.id === id) ?? null });
        }}
        title="Tonight's opponent — unlocks vs-opp history"
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

      {canRemove && (
        <button
          className="manual-slot-remove"
          onClick={onRemove}
          title="Remove this pick"
          aria-label="Remove this pick"
        >
          ✕
        </button>
      )}
    </div>
  );
}
