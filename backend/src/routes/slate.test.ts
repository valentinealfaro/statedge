import { describe, expect, test } from 'vitest';
import { normalizeStatLabel, statLabelFor } from '../services/slateNormalize.js';
import {
  resolvePlayerName,
  type PlayerCandidate,
} from '../services/slateResolve.js';

// Minimal candidate pool that mirrors how the DB's players row looks.
const POOL: PlayerCandidate[] = [
  { id: 2544,    fullName: 'LeBron James',          isActive: true,  teamId: 1610612747 },
  { id: 201939,  fullName: 'Stephen Curry',         isActive: true,  teamId: 1610612744 },
  { id: 201935,  fullName: 'James Harden',          isActive: true,  teamId: 1610612739 },
  { id: 1641705, fullName: 'Victor Wembanyama',     isActive: true,  teamId: 1610612759 },
  { id: 1628378, fullName: 'Donovan Mitchell',      isActive: true,  teamId: 1610612739 },
  { id: 1626156, fullName: "D'Angelo Russell",      isActive: true,  teamId: 1610612747 },
  { id: 203999,  fullName: 'Nikola Jokić',          isActive: true,  teamId: 1610612743 },
  { id: 1628368, fullName: "De'Aaron Fox",          isActive: true,  teamId: 1610612759 },
  // A retired player + an active player sharing a last name to test
  // the active-preferred ranking.
  { id: 99001,   fullName: 'Tim Williams',          isActive: false, teamId: null },
  { id: 4593803, fullName: 'Jalen Williams',        isActive: true,  teamId: 1610612760 },
];

describe('normalizeStatLabel', () => {
  test('PrizePicks-shaped labels map to canonical Last10StatId', () => {
    expect(normalizeStatLabel('Points')).toBe('points');
    expect(normalizeStatLabel('Rebounds')).toBe('rebounds');
    expect(normalizeStatLabel('Assists')).toBe('assists');
    expect(normalizeStatLabel('Pts+Rebs+Asts')).toBe('pra');
    expect(normalizeStatLabel('Pts+Asts')).toBe('pa');
    expect(normalizeStatLabel('Pts+Rebs')).toBe('pr');
    expect(normalizeStatLabel('Rebs+Asts')).toBe('ra');
    expect(normalizeStatLabel('3-PT Made')).toBe('three_pt_made');
    expect(normalizeStatLabel('Blocked Shots')).toBe('blocks');
    expect(normalizeStatLabel('Blks+Stls')).toBe('stocks');
  });

  test('OCR-style noisy spellings still resolve', () => {
    // Spaces, dashes, capitalization variations.
    expect(normalizeStatLabel('PRA')).toBe('pra');
    expect(normalizeStatLabel('threes made')).toBe('three_pt_made');
    expect(normalizeStatLabel('THREE-PT MADE')).toBe('three_pt_made');
    expect(normalizeStatLabel('Free Throws Made')).toBe('ft_made');
    expect(normalizeStatLabel('FT Attempted')).toBe('ft_attempted');
  });

  test('unknown labels return null', () => {
    expect(normalizeStatLabel('Fantasy Score')).toBeNull();
    expect(normalizeStatLabel('Points - 1st 3 Minutes')).toBeNull();
    expect(normalizeStatLabel('')).toBeNull();
    expect(normalizeStatLabel('???')).toBeNull();
  });

  test('statLabelFor returns a display-friendly label', () => {
    expect(statLabelFor('pra')).toBe('Pts+Rebs+Asts');
    expect(statLabelFor('three_pt_made')).toBe('3-PT Made');
    expect(statLabelFor('stocks')).toBe('Blks+Stls');
  });
});

describe('resolvePlayerName', () => {
  test('exact match (case-insensitive)', () => {
    const r = resolvePlayerName('LeBron James', POOL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.playerId).toBe(2544);
      expect(r.matchType).toBe('exact');
    }
  });

  test('strips punctuation/diacritics for canonical match', () => {
    const r1 = resolvePlayerName('Nikola Jokic', POOL);
    expect(r1.ok && r1.playerId).toBe(203999);
    const r2 = resolvePlayerName("D'Angelo Russell", POOL);
    expect(r2.ok && r2.playerId).toBe(1626156);
    const r3 = resolvePlayerName('De Aaron Fox', POOL);
    expect(r3.ok && r3.playerId).toBe(1628368);
  });

  test('typos within edit distance 2 still resolve', () => {
    // "Jamez Hardin" → "James Harden" is exactly 2 edits ('z'→'s', 'i'→'e').
    const r = resolvePlayerName('Jamez Hardin', POOL);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.playerId).toBe(201935);
  });

  test('shared last name resolves to active candidate', () => {
    // Two "Williams" players in the pool — should prefer the active one.
    const r = resolvePlayerName('Williams', POOL);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.playerId).toBe(4593803);
  });

  test('"L. James" → LeBron via last-name match', () => {
    const r = resolvePlayerName('L. James', POOL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.playerId).toBe(2544);
      expect(r.matchType).toBe('last_name');
    }
  });

  test('totally unknown name fails cleanly', () => {
    const r = resolvePlayerName('Daniss Jenkins', POOL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_player_match');
  });

  test('empty string fails', () => {
    const r = resolvePlayerName('', POOL);
    expect(r.ok).toBe(false);
  });

  test('Wembanyama with diacritic is matched against plain ASCII', () => {
    const r = resolvePlayerName('Victor Wembanyama', POOL);
    expect(r.ok && r.playerId).toBe(1641705);
  });
});
