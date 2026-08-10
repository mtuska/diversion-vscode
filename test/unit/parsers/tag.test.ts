import { describe, expect, it } from 'vitest';
import { parseTagList } from '../../../src/diversion/parsers/tag';

describe('parseTagList', () => {
  it('parses the envelope dv emits for an empty repo', () => {
    expect(parseTagList('{"object":"Tag","items":[]}')).toEqual([]);
  });

  it('accepts both snake_case and PascalCase field spellings', () => {
    const snake = parseTagList(JSON.stringify({
      object: 'Tag',
      items: [{ id: 'dv.tag.1', name: 'v1.0', commit_id: 'dv.commit.7', description: 'first cut' }],
    }));
    const pascal = parseTagList(JSON.stringify({
      object: 'Tag',
      items: [{ ID: 'dv.tag.1', Name: 'v1.0', CommitID: 'dv.commit.7', Description: 'first cut' }],
    }));
    expect(snake).toEqual([
      { id: 'dv.tag.1', name: 'v1.0', commitId: 'dv.commit.7', description: 'first cut' },
    ]);
    expect(pascal).toEqual(snake);
  });

  // The history provider skips tags with no commitId, so "absent" has to stay
  // absent rather than becoming an empty string.
  it('omits optional fields dv did not supply', () => {
    const [tag] = parseTagList('{"object":"Tag","items":[{"id":"dv.tag.2","name":"wip"}]}');
    expect(tag).toEqual({ id: 'dv.tag.2', name: 'wip' });
    expect(tag).not.toHaveProperty('commitId');
  });

  it('drops items missing an id or a name rather than emitting a broken ref', () => {
    const tags = parseTagList(JSON.stringify({
      items: [{ id: 'dv.tag.3' }, { name: 'nameless' }, { id: 'dv.tag.4', name: 'ok' }],
    }));
    expect(tags).toEqual([{ id: 'dv.tag.4', name: 'ok' }]);
  });

  it('returns empty for junk instead of throwing', () => {
    expect(parseTagList('')).toEqual([]);
    expect(parseTagList('not json')).toEqual([]);
    expect(parseTagList('{"object":"Tag"}')).toEqual([]);
  });
});
