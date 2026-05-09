// /clv — full CLV truth-metric audit page. Phase 112.
//
// The Trust Banner promises "Full CLV report →"; this is where it
// lands. Three windows displayed with full denominators, a per-
// (sport, stat) breakdown showing where our process discriminates
// most, and per-sport detail. No picks, no marketing — just the
// numbers and an honest framing.
//
// "Beat rate" is process accuracy: did we get a better number than
// the market eventually settled on? Independent of game-outcome
// variance. The 55% threshold is the institutional bar.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getClvRecentProps,
  getClvTrustScore,
  type ClvRecentRow,
  type ClvTrustScoreResponse,
  type ClvTrustWindow,
} from './api';
import { NavBar } from './NavBar';
import { Skeleton } from './Skeleton';
import { useTitle } from './useTitle';

const SPORT_COLOR: Record<string, string> = {
  mlb:  '#66bb6a',
  nba:  '#7aa2ff',
  wnba: '#b388ff',
  mma:  '#ef5350',
};

const STAT_LABEL: Record<string, string> = {
  // MLB
  hits: 'Hits',
  total_bases: 'Total Bases',
  hits_runs_rbis: 'Hits + Runs + RBIs',
  rbis: 'RBIs',
  runs: 'Runs',
  home_runs: 'Home Runs',
  strikeouts: 'Strikeouts',
  stolen_bases: 'Stolen Bases',
  walks: 'Walks',
  doubles: 'Doubles',
  triples: 'Triples',
  ks: 'Pitcher Ks',
  earned_runs_allowed: 'Earned Runs Allowed',
  hits_allowed: 'Hits Allowed',
  walks_allowed: 'Walks Allowed',
  innings_pitched: 'Innings Pitched',
  pitcher_outs: 'Pitcher Outs',
  // Basketball
  points: 'Points',
  rebounds: 'Rebounds',
  assists: 'Assists',
  three_pt_made: 'Three-Pointers Made',
  steals: 'Steals',
  blocks: 'Blocks',
  pra: 'Points + Reb + Ast',
};

export function ClvAudit() {
  useTitle(['CLV Report', 'Truth Metric']);
  const [data, setData] = useState<ClvTrustScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState<'window7d' | 'window30d' | 'seasonToDate'>('seasonToDate');
  const [recent, setRecent] = useState<ClvRecentRow[] | null>(null);

  useEffect(() => {
    getClvTrustScore()
      .then(setData)
      .catch((err: Error) => setError(err.message));
    // Recent props are fetched in parallel — failure is non-fatal,
    // the section silently hides if no graded props exist.
    getClvRecentProps({ limit: 25, windowDays: 30 })
      .then((r) => setRecent(r.rows))
      .catch(() => setRecent([]));
  }, []);

  const win = data?.[windowKey];

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <div style={{ marginBottom: 8 }}>
          <Link to="/" className="muted small">← Home</Link>
        </div>

        <div style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)',
        }}>
          STATEDGE TRUTH METRIC · FULL REPORT
        </div>
        <h1 style={{ margin: '4px 0 12px' }}>Closing Line Value</h1>
        <p className="muted small" style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.5, maxWidth: 760 }}>
          Did our published projection beat the market's eventual close? It's the cleanest
          rebuttal to the noise of game-outcome variance — independent of whether the player
          actually went over or under, you either got a better number than the market eventually
          settled on or you didn't. Long-run ≥55% on real volume = real edge. No editing, no
          cherry-picking, no fabricated retrospective claims. Every published prop is graded.
        </p>

        {error && <div className="mlb-info-banner mlb-info-error">{error}</div>}
        {!data && !error && <Skeleton width="100%" height={400} />}

        {data && (
          <>
            {/* Three-window scoreboard */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 18,
            }}>
              <WindowCard label="Last 7 Days"     win={data.window7d}     />
              <WindowCard label="Last 30 Days"    win={data.window30d}    />
              <WindowCard label="Season to Date"  win={data.seasonToDate} />
            </div>

            {/* Window picker — affects the deeper drill-down below */}
            <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
              <WindowTab active={windowKey === 'window7d'}    onClick={() => setWindowKey('window7d')}>Last 7 days</WindowTab>
              <WindowTab active={windowKey === 'window30d'}   onClick={() => setWindowKey('window30d')}>Last 30 days</WindowTab>
              <WindowTab active={windowKey === 'seasonToDate'} onClick={() => setWindowKey('seasonToDate')}>Season to date</WindowTab>
            </div>

            {/* Per-sport detail */}
            {win && win.bySport.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
                  By Sport
                </h2>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 10,
                }}>
                  {win.bySport.map((s) => (
                    <div key={s.sport} style={{
                      padding: 12,
                      background: 'rgba(0,0,0,0.2)',
                      border: `1px solid ${(SPORT_COLOR[s.sport] ?? '#666')}33`,
                      borderLeft: `3px solid ${SPORT_COLOR[s.sport] ?? '#666'}`,
                      borderRadius: 6,
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: SPORT_COLOR[s.sport] ?? 'rgba(255,255,255,0.7)' }}>
                        {s.sport}
                      </div>
                      <div style={{ fontSize: 24, fontWeight: 800, marginTop: 2, color: rateColor(s.beatRate) }}>
                        {s.beatRate !== null ? `${s.beatRate.toFixed(1)}%` : '—'}
                      </div>
                      <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
                        {s.beatMarket} of {s.withClosing} props
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Per-stat-type breakdown */}
            {win && win.byStat.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
                  By Stat Type
                </h2>
                <p className="muted small" style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.5 }}>
                  Where the model's edge is concentrated. Sorted by distance from 50% — both directions are signal. A 38% beat rate is the same evidence as 62% (the model has a directional read), just on the other side. Stats with too few graded props are excluded.
                </p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
                      <th style={thStyle}>Sport</th>
                      <th style={thStyle}>Stat</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Beat Rate</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Sample</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Avg Line Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {win.byStat.slice(0, 20).map((s) => (
                      <tr key={`${s.sport}-${s.stat}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={tdStyle}>
                          <span style={{
                            fontSize: 9, fontWeight: 800, letterSpacing: '0.05em',
                            color: SPORT_COLOR[s.sport] ?? 'rgba(255,255,255,0.6)',
                            textTransform: 'uppercase',
                          }}>
                            {s.sport}
                          </span>
                        </td>
                        <td style={tdStyle}>{STAT_LABEL[s.stat] ?? s.stat}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: rateColor(s.beatRate) }}>
                          {s.beatRate !== null ? `${s.beatRate.toFixed(1)}%` : '—'}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: 'rgba(255,255,255,0.55)' }}>
                          {s.beatMarket}/{s.withClosing}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: 'rgba(255,255,255,0.65)' }}>
                          {s.averageLineDelta !== null ? `${s.averageLineDelta >= 0 ? '+' : ''}${s.averageLineDelta.toFixed(2)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {/* Recent graded props — the concrete trail behind the
                top-line beat rate. Every prop, every line move,
                every grade. The "we publish the math" promise made
                physical. */}
            {recent && recent.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)' }}>
                  Recent Graded Props
                </h2>
                <p className="muted small" style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.5 }}>
                  Most recent {recent.length} graded projections (last 30 days). Beat = our published line was directionally better than the market's eventual close. Magnitude in stat units.
                </p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 720 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
                        <th style={thStyle}>Sport</th>
                        <th style={thStyle}>Game Date</th>
                        <th style={thStyle}>Player</th>
                        <th style={thStyle}>Stat</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Our Line</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Close</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Δ</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((r) => (
                        <tr key={`${r.sport}-${r.projectionId}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={tdStyle}>
                            <span style={{
                              fontSize: 9, fontWeight: 800, letterSpacing: '0.05em',
                              color: SPORT_COLOR[r.sport] ?? 'rgba(255,255,255,0.6)',
                              textTransform: 'uppercase',
                            }}>
                              {r.sport}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, color: 'rgba(255,255,255,0.6)' }}>
                            {r.gameDate.slice(0, 10)}
                          </td>
                          <td style={tdStyle}>
                            {r.rawPlayerName ?? `Player ${r.playerId ?? '?'}`}
                            {r.team && <span className="muted small" style={{ marginLeft: 4, fontSize: 10 }}>{r.team}</span>}
                          </td>
                          <td style={{ ...tdStyle, color: 'rgba(255,255,255,0.85)' }}>
                            {STAT_LABEL[r.statKey] ?? r.statKey}
                            <span className="muted small" style={{
                              marginLeft: 4, fontSize: 9, fontWeight: 800, letterSpacing: '0.05em',
                              color: r.direction === 'OVER' ? '#66bb6a' : '#ef5350',
                            }}>
                              {r.direction === 'OVER' ? '↑' : '↓'}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>
                            {r.publishLine.toFixed(1)}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: 'rgba(255,255,255,0.65)' }}>
                            {r.closingLine !== null ? r.closingLine.toFixed(1) : '—'}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: 'rgba(255,255,255,0.7)' }}>
                            {r.lineDelta !== null
                              ? `${r.lineDelta >= 0 ? '+' : ''}${r.lineDelta.toFixed(1)}`
                              : '—'}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>
                            {r.beatMarket === true && (
                              <span style={{ fontSize: 11, fontWeight: 800, color: '#66bb6a' }}>
                                ✓ BEAT
                              </span>
                            )}
                            {r.beatMarket === false && (
                              <span style={{ fontSize: 11, fontWeight: 800, color: '#ef5350' }}>
                                ✗ LOST
                              </span>
                            )}
                            {r.beatMarket === null && (
                              <span className="muted small" style={{ fontSize: 11 }}>
                                —
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Methodology footer — institutional users want to know
                exactly how we computed this number. */}
            <section style={{
              marginTop: 24,
              padding: 16,
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
            }}>
              <h3 style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
                Methodology
              </h3>
              <ul className="muted small" style={{ marginTop: 8, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
                <li><strong>Beat rate</strong> = (props that beat the close) ÷ (props with at least one later snapshot). Props without later market data are excluded — we don't pad the denominator.</li>
                <li><strong>"Beat the close"</strong> means the published line was directionally better than the latest snapshot we have. Over published at 22.5, market closed at 23.5 = beat (we got the lower number on an over).</li>
                <li><strong>Window</strong> filters by the projection's game date, not when it was graded. A pick from 25 days ago counts in both 7d and 30d windows by its game day, not its publish day.</li>
                <li><strong>Sources</strong>: <code>mlb_projection_history</code> and <code>wnba_projection_history</code> joined to <code>market_snapshots</code>. NBA and UFC start contributing once those projection histories accumulate.</li>
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function WindowCard({ label, win }: { label: string; win: ClvTrustWindow }) {
  const rate = win.beatRate;
  return (
    <div style={{
      padding: 16,
      background: 'rgba(0,0,0,0.25)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)',
      }}>
        {label}
      </div>
      <div style={{ fontSize: 36, fontWeight: 800, color: rateColor(rate), marginTop: 6, lineHeight: 1 }}>
        {rate !== null ? `${rate.toFixed(1)}%` : '—'}
      </div>
      <div className="muted small" style={{ fontSize: 12, marginTop: 6 }}>
        {win.withClosing > 0
          ? `${win.beatMarket} of ${win.withClosing} props beat the close`
          : 'No graded props in this window yet'}
      </div>
    </div>
  );
}

function WindowTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: '6px 12px',
        borderRadius: 4,
        border: `1px solid ${active ? '#7aa2ff' : 'rgba(255,255,255,0.1)'}`,
        background: active ? 'rgba(122,162,255,0.1)' : 'transparent',
        color: active ? '#7aa2ff' : 'rgba(255,255,255,0.65)',
        fontWeight: 700,
        fontSize: 11,
        letterSpacing: '0.04em',
        cursor: 'pointer',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </button>
  );
}

function rateColor(rate: number | null): string {
  if (rate === null) return 'rgba(255,255,255,0.4)';
  if (rate >= 55) return '#66bb6a';
  if (rate >= 50) return '#ffd54f';
  return '#ef5350';
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'rgba(255,255,255,0.5)',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontSize: 13,
};
