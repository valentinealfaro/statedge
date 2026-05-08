// Tests for the L10 confidence engine. Pure formula — no DB.

import { describe, expect, test } from 'vitest';
import {
  computeConfidence,
  confidenceTier,
} from './mlbConfidenceEngine.js';

const baseInputs = {
  last10Size: 10,
  seasonGames: 30,
  stabilizationGames: 20,
  agreementSpread: {
    seasonVsLast10: 0.05,
    opponentVsLast10: 0.10,
    last5VsLast10: 0.05,
  },
  opponentGames: 4,
  handednessKnown: true,
  playerType: 'hitter' as const,
  lineupConfirmed: true,
  gameContextLoaded: true,
  calibrationScore: null,
  contextLayers: {
    park: true, weather: true, lineup: true, bvp: true, gameScript: true,
  },
};

describe('computeConfidence — full-fire scenario', () => {
  test('Everything populated → Elite or Institutional', () => {
    const r = computeConfidence(baseInputs);
    expect(r.confidence).toBeGreaterThan(75);
    expect(r.tier).toMatch(/Elite|Institutional/);
  });

  test('Components are all populated', () => {
    const r = computeConfidence(baseInputs);
    expect(r.components.sampleQuality).toBeGreaterThan(80);
    expect(r.components.projectionAgreement).toBeGreaterThan(80);
    expect(r.components.matchupClarity).toBe(100);     // ≥4 opp games + handedness
    expect(r.components.opportunityCertainty).toBe(95);
    expect(r.components.dataCompleteness).toBe(100);
  });
});

describe('computeConfidence — sample quality', () => {
  test('Empty L10 + zero season → 0 sample quality', () => {
    const r = computeConfidence({
      ...baseInputs,
      last10Size: 0,
      seasonGames: 0,
    });
    expect(r.components.sampleQuality).toBe(0);
  });

  test('Half-sample → 50 sample quality', () => {
    const r = computeConfidence({
      ...baseInputs,
      last10Size: 5,
      seasonGames: 10,
      stabilizationGames: 20,
    });
    expect(r.components.sampleQuality).toBe(50);
  });
});

describe('computeConfidence — projection agreement', () => {
  test('Tight agreement → high score', () => {
    const r = computeConfidence({
      ...baseInputs,
      agreementSpread: { seasonVsLast10: 0, opponentVsLast10: 0, last5VsLast10: 0 },
    });
    expect(r.components.projectionAgreement).toBe(100);
  });

  test('Wide spread (50%+) → 0', () => {
    const r = computeConfidence({
      ...baseInputs,
      agreementSpread: { seasonVsLast10: 0.6, opponentVsLast10: 0.6, last5VsLast10: 0.6 },
    });
    expect(r.components.projectionAgreement).toBe(0);
  });

  test('No agreement signal at all → neutral 50', () => {
    const r = computeConfidence({
      ...baseInputs,
      agreementSpread: { seasonVsLast10: null, opponentVsLast10: null, last5VsLast10: null },
    });
    expect(r.components.projectionAgreement).toBe(50);
  });
});

describe('computeConfidence — matchup clarity', () => {
  test('No opponent games + no handedness → low (21)', () => {
    const r = computeConfidence({
      ...baseInputs,
      opponentGames: 0,
      handednessKnown: false,
    });
    expect(r.components.matchupClarity).toBe(21);
  });

  test('5+ opp games + handedness → 100', () => {
    const r = computeConfidence({
      ...baseInputs,
      opponentGames: 7,
      handednessKnown: true,
    });
    expect(r.components.matchupClarity).toBe(100);
  });
});

describe('computeConfidence — opportunity certainty', () => {
  test('Hitter + lineup confirmed + game context → 95', () => {
    const r = computeConfidence({ ...baseInputs, playerType: 'hitter', lineupConfirmed: true });
    expect(r.components.opportunityCertainty).toBe(95);
  });

  test('Hitter + lineup unknown + no context → 30', () => {
    const r = computeConfidence({
      ...baseInputs,
      playerType: 'hitter',
      lineupConfirmed: false,
      gameContextLoaded: false,
    });
    expect(r.components.opportunityCertainty).toBe(30);
  });

  test('Pitcher + game context → 90', () => {
    const r = computeConfidence({
      ...baseInputs,
      playerType: 'pitcher',
      lineupConfirmed: null,
      gameContextLoaded: true,
    });
    expect(r.components.opportunityCertainty).toBe(90);
  });
});

describe('computeConfidence — data completeness', () => {
  test('Zero context → 0', () => {
    const r = computeConfidence({
      ...baseInputs,
      contextLayers: {
        park: false, weather: false, lineup: false, bvp: false, gameScript: false,
      },
    });
    expect(r.components.dataCompleteness).toBe(0);
  });

  test('All five context layers → 100', () => {
    const r = computeConfidence(baseInputs);
    expect(r.components.dataCompleteness).toBe(100);
  });
});

describe('confidenceTier — bands per spec', () => {
  test('0-39 Weak', () => {
    expect(confidenceTier(0)).toBe('Weak');
    expect(confidenceTier(39)).toBe('Weak');
  });
  test('40-59 Medium', () => {
    expect(confidenceTier(40)).toBe('Medium');
    expect(confidenceTier(59)).toBe('Medium');
  });
  test('60-74 Strong', () => {
    expect(confidenceTier(60)).toBe('Strong');
    expect(confidenceTier(74)).toBe('Strong');
  });
  test('75-89 Elite', () => {
    expect(confidenceTier(75)).toBe('Elite');
    expect(confidenceTier(89)).toBe('Elite');
  });
  test('90+ Institutional (extremely rare per spec)', () => {
    expect(confidenceTier(90)).toBe('Institutional');
    expect(confidenceTier(100)).toBe('Institutional');
  });
});
