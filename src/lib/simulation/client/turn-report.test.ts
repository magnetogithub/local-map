import {describe, expect, it} from 'vitest';
import {testWorldState} from '@/stores/world-state-store-v2-fixture';
import {parseTurnResolutionV1, type TurnResolutionV1} from '../turn-resolution';
import {createCommittedTurnReport} from './turn-report';

const world = testWorldState(['AAA', 'BBB']);

function report(worldEffects: TurnResolutionV1['worldEffects']) {
  return createCommittedTurnReport({
    turnId: 'turn.report',
    baseWorldState: world,
    baseSimulationState: {playerCountryId: 'AAA'},
    resolution: parseTurnResolutionV1({
      contractVersion: 'turn-resolution.v1',
      baseSimulationRevision: 0,
      baseWorldRevision: 0,
      period: {startDate: '2020-01-01', endDate: '2020-01-02'},
      playerActionOutcomes: [],
      events: [{eventId: 'event.report', date: '2020-01-02', title: '검토 결과', publicNarrative: '검토 결과를 발표했습니다.',
        actorCountryIds: ['AAA'], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: 'domestic', significance: 'minor'}],
      factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects,
      advisorSummary: '확정된 결과입니다.', unresolvedQuestions: [],
    }),
  });
}

describe('committed turn map change counts', () => {
  it('keeps a turn with no world effect at zero changes without adding display text', () => {
    const result = report([]);
    expect(result.mapChanges).toEqual([]);
    expect(Object.isFrozen(result.mapChanges)).toBe(true);
    expect(result.events[0].hasMapChanges).toBe(false);
  });

  it('reports one actual world effect as one change linked to its event', () => {
    const result = report([{type: 'country.renamed', effectId: 'effect.report', causedByEventId: 'event.report', countryId: 'AAA', displayName: '새 국호'}]);
    expect(result.mapChanges).toHaveLength(1);
    expect(result.mapChanges[0]).toContain('국호 변경');
    expect(result.events[0].hasMapChanges).toBe(true);
  });
});
