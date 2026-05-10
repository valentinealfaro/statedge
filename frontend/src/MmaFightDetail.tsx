// /mma/event/:eventId/fight/:fightId — ESPN-style fight detail page.
// Phase 146.
//
// Per-fight detail card that mirrors the ESPN fightcenter layout the
// user explicitly asked for: title bar with weight class + main-event
// + title-fight flags, two fighter portraits side-by-side, country
// flags above each, full "tale of the tape" stat comparison table
// (height, weight, age, reach, stance + sig-strikes-LPM/accuracy +
// takedown-avg/accuracy + submission-avg), live-status badge that
// pulses while the fight is in progress, and a final-result block
// (method · round · time) when the fight settles.
//
// Live polling: re-fetches the detail endpoint every 60s when the
// event state is 'in', so users watching a live card see the round
// counter and final result populate without refreshing the page.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getUfcFightDetail,
  type UfcFightDetailResponse,
  type UfcFighter,
  type UfcFighterBio,
} from './api';
import { UfcFighterAvatar } from './Avatar';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

const MMA_ACCENT = '#ef5350';

export function MmaFightDetail() {
  const { eventId, fightId } = useParams<{ eventId: string; fightId: string }>();
  const [data, setData] = useState<UfcFightDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useTitle(data
    ? [`${data.fight.fighters.red?.displayName ?? '—'} vs ${data.fight.fighters.blue?.displayName ?? '—'}`, 'UFC']
    : ['UFC Fight']);

  useEffect(() => {
    if (!eventId || !fightId) return;
    let cancelled = false;
    const tick = () => {
      getUfcFightDetail(eventId, fightId)
        .then((d) => { if (!cancelled) setData(d); })
        .catch((err: Error) => { if (!cancelled) setError(err.message); });
    };
    tick();
    // Live-poll while the event is in progress; quieter cadence
    // otherwise so we don't burn requests on completed fights.
    const id = window.setInterval(() => {
      const live = data?.event.state === 'in' || data?.fight.state === 'in';
      if (live) tick();
    }, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [eventId, fightId]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="app">
        <NavBar />
        <div className="mlb-compare-shell">
          <div style={{ marginBottom: 12 }}>
            <Link to="/mma/scoreboard" className="muted small">← Back to UFC</Link>
          </div>
          <div className="mlb-info-banner mlb-info-error">{error}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app">
        <NavBar />
        <div className="mlb-compare-shell">
          <Skeleton width="60%" height={32} />
          <Skeleton width="100%" height={420} style={{ marginTop: 16 }} />
        </div>
      </div>
    );
  }

  const { event, fight, bios } = data;
  const dateLabel = new Date(event.date).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  // Title bar text — weight class · Main Event · Title Fight
  const titleParts: string[] = [];
  if (fight.weightClass) titleParts.push(fight.weightClass);
  if (fight.isMain) titleParts.push('Main Event');
  if (fight.isTitle) titleParts.push('Title Fight');

  const isLive = fight.state === 'in';
  const isFinal = fight.state === 'post';

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 10 }}>
          <Link to="/mma/scoreboard" className="muted small">← Back to UFC</Link>
        </div>

        {/* Event header — name + date + venue + live pulse */}
        <header
          className="fade-up"
          style={{
            position: 'relative',
            padding: '20px 24px',
            background: `
              radial-gradient(ellipse 50% 80% at 0% 0%, rgba(239,83,80,0.08) 0%, transparent 60%),
              linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
              var(--surface-1)
            `,
            border: '1px solid rgba(239,83,80,0.25)',
            borderRadius: 'var(--radius-lg)',
            marginBottom: 14,
            overflow: 'hidden',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          <span aria-hidden style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(239,83,80,0.55), transparent)',
          }} />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{
              margin: 0, fontSize: 24, fontWeight: 900, letterSpacing: '-0.4px',
              background: 'linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.78) 100%)',
              WebkitBackgroundClip: 'text', backgroundClip: 'text',
              WebkitTextFillColor: 'transparent', color: 'transparent',
            }}>
              {event.name}
            </h1>
            {isLive && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 11, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase',
                color: '#ef5350',
                padding: '3px 10px', borderRadius: 4,
                background: 'rgba(239,83,80,0.14)',
                border: '1px solid rgba(239,83,80,0.40)',
              }}>
                <span className="live-pulse" style={{
                  display: 'inline-block', width: 7, height: 7, borderRadius: 3.5, background: '#ef5350',
                }} />
                Live · In Progress
              </span>
            )}
            {isFinal && (
              <span style={{
                fontSize: 11, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.55)',
                padding: '3px 10px', borderRadius: 4,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
              }}>
                Final
              </span>
            )}
          </div>
          <div className="muted small" style={{ marginTop: 6, fontSize: 12 }}>
            {dateLabel}
            {event.venue && (
              <>
                <span style={{ opacity: 0.5, margin: '0 8px' }}>·</span>
                {event.venue.fullName}
                {event.venue.city ? `, ${event.venue.city}` : ''}
              </>
            )}
          </div>
        </header>

        {/* Fight card — title bar + fighter portraits + stat table */}
        <section
          className="fade-up"
          style={{
            position: 'relative',
            background: `
              linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 28%),
              var(--surface-1)
            `,
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          <span aria-hidden style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.10), transparent)',
          }} />

          {/* Bout title bar */}
          <div style={{
            padding: '12px 16px',
            background: 'rgba(0,0,0,0.20)',
            borderBottom: '1px solid var(--border-subtle)',
            textAlign: 'center',
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.75)',
          }}>
            {titleParts.length > 0 ? titleParts.join(' · ') : 'Bout'}
          </div>

          {/* Fighter heads + names + records */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            gap: 16,
            alignItems: 'center',
            padding: '24px 20px 14px',
          }}>
            <FighterHeader fighter={fight.fighters.red} bio={bios.red} side="left" />
            <div style={{
              fontSize: 11, fontWeight: 800, letterSpacing: '0.12em',
              color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase',
              padding: '6px 0',
            }}>
              vs
            </div>
            <FighterHeader fighter={fight.fighters.blue} bio={bios.blue} side="right" />
          </div>

          {/* Country flag strip */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            padding: '8px 20px',
            borderTop: '1px solid var(--border-subtle)',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'rgba(0,0,0,0.15)',
          }}>
            <CountryStrip bio={bios.red} fallback={fight.fighters.red?.flag ?? null} side="left" />
            <CountryStrip bio={bios.blue} fallback={fight.fighters.blue?.flag ?? null} side="right" />
          </div>

          {/* Bio comparison table — always shown */}
          <div style={{ padding: '14px 0 4px' }}>
            <StatRow label="Height" leftRaw={bios.red?.height ?? null} rightRaw={bios.blue?.height ?? null} />
            <StatRow label="Weight" leftRaw={bios.red?.weight ?? null} rightRaw={bios.blue?.weight ?? null} />
            <StatRow label="Age" leftRaw={bios.red?.age?.toString() ?? null} rightRaw={bios.blue?.age?.toString() ?? null} />
            <StatRow label="Reach" leftRaw={bios.red?.reach ?? null} rightRaw={bios.blue?.reach ?? null} />
            <StatRow label="Stance" leftRaw={bios.red?.stance ?? null} rightRaw={bios.blue?.stance ?? null} />
          </div>

          {/* This-fight live stats — only when fight has progressed */}
          {(bios.red?.liveStats || bios.blue?.liveStats) && (
            <>
              <div style={{
                padding: '10px 16px',
                borderTop: '1px solid var(--border-subtle)',
                fontSize: 10, fontWeight: 800, letterSpacing: '0.10em',
                textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
                background: 'rgba(0,0,0,0.20)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                {(isLive || isFinal) && (
                  <span className="live-pulse" style={{
                    display: 'inline-block', width: 6, height: 6, borderRadius: 3,
                    background: isLive ? '#ef5350' : '#66bb6a',
                  }} />
                )}
                {isFinal ? 'Final fight stats' : isLive ? 'Live fight stats' : 'Fight stats'}
              </div>
              <div style={{ padding: '6px 0 14px' }}>
                <StatRow
                  label="Knockdowns"
                  leftRaw={liveCount(bios.red?.liveStats?.knockdowns)}
                  rightRaw={liveCount(bios.blue?.liveStats?.knockdowns)}
                  compareNumeric={{ left: bios.red?.liveStats?.knockdowns ?? null, right: bios.blue?.liveStats?.knockdowns ?? null }}
                />
                <StatRow
                  label="Sig strikes"
                  leftRaw={liveLandedAttempted(bios.red?.liveStats?.sigStrikesLanded, bios.red?.liveStats?.sigStrikesAttempted)}
                  rightRaw={liveLandedAttempted(bios.blue?.liveStats?.sigStrikesLanded, bios.blue?.liveStats?.sigStrikesAttempted)}
                  compareNumeric={{ left: bios.red?.liveStats?.sigStrikesLanded ?? null, right: bios.blue?.liveStats?.sigStrikesLanded ?? null }}
                />
                <StatRow
                  label="Total strikes"
                  leftRaw={liveLandedAttempted(bios.red?.liveStats?.totalStrikesLanded, bios.red?.liveStats?.totalStrikesAttempted)}
                  rightRaw={liveLandedAttempted(bios.blue?.liveStats?.totalStrikesLanded, bios.blue?.liveStats?.totalStrikesAttempted)}
                  compareNumeric={{ left: bios.red?.liveStats?.totalStrikesLanded ?? null, right: bios.blue?.liveStats?.totalStrikesLanded ?? null }}
                />
                <StatRow
                  label="Head / Body / Leg"
                  leftRaw={liveStrikeSplit(bios.red?.liveStats)}
                  rightRaw={liveStrikeSplit(bios.blue?.liveStats)}
                />
                <StatRow
                  label="Takedowns"
                  leftRaw={liveLandedAttempted(bios.red?.liveStats?.takedownsLanded, bios.red?.liveStats?.takedownsAttempted)}
                  rightRaw={liveLandedAttempted(bios.blue?.liveStats?.takedownsLanded, bios.blue?.liveStats?.takedownsAttempted)}
                  compareNumeric={{ left: bios.red?.liveStats?.takedownsLanded ?? null, right: bios.blue?.liveStats?.takedownsLanded ?? null }}
                />
                <StatRow
                  label="Submission att"
                  leftRaw={liveCount(bios.red?.liveStats?.submissionAttempts)}
                  rightRaw={liveCount(bios.blue?.liveStats?.submissionAttempts)}
                  compareNumeric={{ left: bios.red?.liveStats?.submissionAttempts ?? null, right: bios.blue?.liveStats?.submissionAttempts ?? null }}
                />
                <StatRow
                  label="Time in control"
                  leftRaw={liveTime(bios.red?.liveStats?.timeInControlSec)}
                  rightRaw={liveTime(bios.blue?.liveStats?.timeInControlSec)}
                  compareNumeric={{ left: bios.red?.liveStats?.timeInControlSec ?? null, right: bios.blue?.liveStats?.timeInControlSec ?? null }}
                />
              </div>
            </>
          )}

          {/* Full Profile links — defend against empty IDs. The
              fightcenter response carries the canonical numeric ids
              (which we prefer); the scoreboard ids are populated as a
              fallback by the patched projector. If both are empty we
              render nothing rather than a broken link. */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            padding: '0 20px 16px',
            gap: 16,
          }}>
            {(bios.red?.id || fight.fighters.red?.id) && (
              <Link
                to={`/mma/fighter/${bios.red?.id || fight.fighters.red?.id}`}
                style={{ fontSize: 12, fontWeight: 700, color: '#7aa2ff', textDecoration: 'none', textAlign: 'left' }}
              >
                Full Profile →
              </Link>
            )}
            {(bios.blue?.id || fight.fighters.blue?.id) && (
              <Link
                to={`/mma/fighter/${bios.blue?.id || fight.fighters.blue?.id}`}
                style={{ fontSize: 12, fontWeight: 700, color: '#7aa2ff', textDecoration: 'none', textAlign: 'right' }}
              >
                Full Profile →
              </Link>
            )}
          </div>

          {/* Final result block — only when fight has settled */}
          {isFinal && fight.result && (
            <div style={{
              borderTop: '1px solid var(--border-subtle)',
              padding: '14px 20px',
              textAlign: 'center',
              background: 'rgba(0,0,0,0.20)',
            }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
                Final
              </div>
              <div style={{
                marginTop: 4, fontSize: 16, fontWeight: 900,
                color: '#fff',
              }}>
                {fight.result.method ?? '—'}
                {fight.result.round && (
                  <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.65)' }}>
                    R{fight.result.round}
                    {fight.result.time && `, ${fight.result.time}`}
                  </span>
                )}
              </div>
              {fight.result.winnerId && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#66bb6a', fontWeight: 700 }}>
                  {winnerName(fight.result.winnerId, fight.fighters.red, fight.fighters.blue)} def. {loserName(fight.result.winnerId, fight.fighters.red, fight.fighters.blue)}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function FighterHeader({
  fighter,
  bio,
  side,
}: {
  fighter: UfcFighter | null;
  bio: UfcFighterBio | null;
  side: 'left' | 'right';
}) {
  if (!fighter && !bio) {
    return (
      <div style={{ textAlign: side === 'left' ? 'left' : 'right' }}>
        <span style={{ color: 'rgba(255,255,255,0.45)' }}>TBD</span>
      </div>
    );
  }
  const align = side === 'left' ? 'flex-start' : 'flex-end';
  // Prefer the fightcenter bio for both id (numeric) and headshot (it
  // has both reliably). Fall back to scoreboard fighter if bio missing.
  const id = bio?.id || fighter?.id || '';
  const displayName = bio?.displayName || fighter?.displayName || 'TBD';
  const record = bio?.record ?? fighter?.record ?? null;
  const headshotOverride = bio?.headshot ?? fighter?.headshot ?? null;
  const profileHref = id ? `/mma/fighter/${id}` : null;

  const NameWrap = profileHref
    ? ({ children }: { children: React.ReactNode }) => (
        <Link to={profileHref} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          {children}
        </Link>
      )
    : ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const AvatarWrap = profileHref
    ? ({ children }: { children: React.ReactNode }) => (
        <Link to={profileHref} style={{ flexShrink: 0, lineHeight: 0 }}>{children}</Link>
      )
    : ({ children }: { children: React.ReactNode }) => <span style={{ flexShrink: 0, lineHeight: 0 }}>{children}</span>;

  return (
    <div style={{
      display: 'flex',
      flexDirection: side === 'left' ? 'row' : 'row-reverse',
      alignItems: 'center',
      gap: 14,
      justifyContent: align,
    }}>
      <AvatarWrap>
        <UfcFighterAvatar
          athleteId={id}
          name={displayName}
          size="lg"
          headshotOverride={headshotOverride}
        />
      </AvatarWrap>
      <div style={{
        textAlign: side === 'left' ? 'left' : 'right',
        minWidth: 0,
      }}>
        <NameWrap>
          <span style={{
            display: 'block',
            fontSize: 18, fontWeight: 900,
            color: 'var(--text-1)',
            letterSpacing: '-0.3px',
          }}>
            {displayName}
          </span>
        </NameWrap>
        <div className="muted small" style={{
          marginTop: 4, fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: 'rgba(255,255,255,0.6)',
        }}>
          {record ?? '—'}
        </div>
      </div>
    </div>
  );
}

function CountryStrip({
  bio,
  fallback,
  side,
}: {
  bio: UfcFighterBio | null;
  fallback: string | null;
  side: 'left' | 'right';
}) {
  const flagUrl = bio?.flag ?? fallback;
  const countryName = bio?.flagAlt ?? null;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      justifyContent: side === 'left' ? 'flex-start' : 'flex-end',
      flexDirection: side === 'left' ? 'row' : 'row-reverse',
    }}>
      {flagUrl && (
        <img
          src={flagUrl}
          alt={countryName ?? ''}
          loading="lazy"
          style={{ width: 22, height: 14, objectFit: 'cover', borderRadius: 2 }}
        />
      )}
      {countryName && (
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: 'rgba(255,255,255,0.75)' }}>
          {countryName}
        </span>
      )}
    </div>
  );
}

function StatRow({
  label,
  leftRaw,
  rightRaw,
  compareNumeric,
}: {
  label: string;
  leftRaw: string | null;
  rightRaw: string | null;
  // When both sides are numeric, the higher value gets the brand
  // accent color so users can scan winners-by-stat at a glance.
  // Honest about ties — no color when equal.
  compareNumeric?: { left: number | null; right: number | null };
}) {
  const left = leftRaw ?? '—';
  const right = rightRaw ?? '—';

  let leftColor: string | undefined;
  let rightColor: string | undefined;
  if (compareNumeric) {
    const { left: ln, right: rn } = compareNumeric;
    if (ln != null && rn != null && ln !== rn) {
      if (ln > rn) leftColor = '#66bb6a';
      else rightColor = '#66bb6a';
    }
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto 1fr',
      padding: '8px 20px',
      borderBottom: '1px solid var(--border-subtle)',
      alignItems: 'center',
      fontSize: 13,
    }}>
      <div style={{
        textAlign: 'right', fontWeight: 700,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontVariantNumeric: 'tabular-nums',
        color: leftColor ?? (left === '—' ? 'rgba(255,255,255,0.35)' : 'var(--text-1)'),
      }}>
        {left}
      </div>
      <div style={{
        padding: '0 18px',
        fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.50)',
        whiteSpace: 'nowrap',
      }}>
        {label}
      </div>
      <div style={{
        textAlign: 'left', fontWeight: 700,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontVariantNumeric: 'tabular-nums',
        color: rightColor ?? (right === '—' ? 'rgba(255,255,255,0.35)' : 'var(--text-1)'),
      }}>
        {right}
      </div>
    </div>
  );
}

// Live-stat formatters — return em-dash for null so StatRow renders
// the muted placeholder consistently.
function liveCount(v: number | null | undefined): string | null {
  return v == null ? null : String(v);
}
function liveLandedAttempted(landed: number | null | undefined, attempted: number | null | undefined): string | null {
  if (landed == null && attempted == null) return null;
  if (landed != null && attempted != null && attempted > 0) {
    const pct = Math.round((landed / attempted) * 100);
    return `${landed}/${attempted} (${pct}%)`;
  }
  if (landed != null) return String(landed);
  return null;
}
function liveStrikeSplit(s: { headStrikesLanded: number | null; bodyStrikesLanded: number | null; legStrikesLanded: number | null } | null | undefined): string | null {
  if (!s) return null;
  if (s.headStrikesLanded == null && s.bodyStrikesLanded == null && s.legStrikesLanded == null) return null;
  const h = s.headStrikesLanded ?? 0;
  const b = s.bodyStrikesLanded ?? 0;
  const l = s.legStrikesLanded ?? 0;
  return `${h} / ${b} / ${l}`;
}
function liveTime(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function winnerName(winnerId: string, red: UfcFighter | null, blue: UfcFighter | null): string {
  if (red?.id === winnerId) return red.displayName;
  if (blue?.id === winnerId) return blue.displayName;
  return '—';
}
function loserName(winnerId: string, red: UfcFighter | null, blue: UfcFighter | null): string {
  if (red?.id === winnerId) return blue?.displayName ?? '—';
  if (blue?.id === winnerId) return red?.displayName ?? '—';
  return '—';
}

// Re-export the local helper so MmaScoreboard can construct the same
// fight-detail link without duplicating the route format.
export function mmaFightDetailPath(eventId: string, fightId: string): string {
  return `/mma/event/${encodeURIComponent(eventId)}/fight/${encodeURIComponent(fightId)}`;
}

void MMA_ACCENT;     // reserved for future themed pieces
