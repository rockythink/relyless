import {expect, test} from 'bun:test';
import '../extension/video-subtitles.js';

const plan = globalThis.ShisuiVideoCaptionPlan;

test('short caption fragments join into one spoken line', () => {
  const groups = plan.groupCues([
    {startTime: 0, endTime: 0.4, text: 'Yeah.'},
    {startTime: 0.5, endTime: 2, text: 'The bridge is open today.'},
    {startTime: 4, endTime: 5, text: '[Music]'},
  ]);
  expect(groups.map(group => group.text)).toEqual(['Yeah. The bridge is open today.', '[Music]']);
  expect(plan.localCaption('[Music]')).toBe('[音乐]');
  expect(plan.localCaption('Yeah.')).toBe('');
});

test('a short non-Chinese answer can stand, and a long one cannot', () => {
  expect(plan.acceptableTranslation('OK', 'OK')).toBe(true);
  expect(plan.acceptableTranslation('The bridge is open today and tomorrow.', 'The bridge is open.')).toBe(false);
  expect(plan.acceptableTranslation('The bridge is open today.', '桥开着。')).toBe(true);
});

test('prefetch skips lines that will already be over and keeps an in-flight count across videos', () => {
  const groups = [
    {startTime: 0, endTime: 1, text: 'Gone'},
    {startTime: 2, endTime: 8, text: 'Current'},
    {startTime: 40, endTime: 44, text: 'Later'},
  ];
  const translations = new Map();
  const todo = plan.pendingGroups({groups, time: 3, translations, horizon: 33, arrival: 3, limit: 4, now: 1_000});
  expect(todo.map(group => group.text)).toEqual(['Current']);
  expect(plan.releasePrefetch(1, 2, 1)).toBe(1);
  expect(plan.releasePrefetch(2, 2, 1)).toBe(0);
});

test('turning bilingual off does not discard a finished caption from the same source', () => {
  const kept = plan.translationRecord({destroyed: false, generation: 4, sourceGeneration: 4, sourceText: 'The bridge is open.', translation: '桥开着。', failed: false, attempts: 1, now: 50});
  expect(kept).toMatchObject({status: 'ok', text: '桥开着。'});
  expect(plan.translationRecord({destroyed: false, generation: 4, sourceGeneration: 5, sourceText: 'The bridge is open.', translation: '桥开着。', failed: false, attempts: 1, now: 50})).toBeNull();
});
