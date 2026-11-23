/** C09/C11 follow-ups: the Person picker shows names (ids stay the values); What it saw asks once per distinct id batch. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PersonSelect } from '@/components/agents/memory-card';
import { personLabels } from '@/lib/shared/memory-people';
import { idBatches, itemsReader } from '@/lib/shared/memory-items-read';

const users = [
  { id: 'usr_1', name: 'Dana Cohen', email: 'dana@x.io' },
  { id: 'usr_2', name: 'Sam Lee', email: 'sam@x.io' },
  { id: 'usr_3', name: 'Sam Lee', email: 'sam@y.io' },
];

describe('person labels', () => {
  it('shows names, the email only on a clash, and readable channel and shared labels', () => {
    const ids = ['usr_1', 'usr_2', 'usr_3', 'slack:U1', 'teams:abc', 'telegram:9', 'you', 'usr_gone'];
    const l = personLabels(ids, users);
    expect(l.usr_1).toBe('Dana Cohen');
    expect(l.usr_2).toBe('Sam Lee (sam@x.io)');
    expect(l.usr_3).toBe('Sam Lee (sam@y.io)');
    expect(l['slack:U1']).toBe('Slack user U1');
    expect(l['teams:abc']).toBe('Microsoft Teams user abc');
    expect(l['telegram:9']).toBe('Telegram user 9');
    expect(l.you).toContain('You');
    expect(l.usr_gone).toBe('usr_gone');
  });

  it('renders names in the picker and keeps ids as values', () => {
    const ids = ['usr_1', 'slack:U1'];
    const html = renderToStaticMarkup(createElement(PersonSelect, { users: ids, labels: personLabels(ids, users), value: 'usr_1', onChange: () => undefined }));
    expect(html).toContain('>Dana Cohen<');
    expect(html).toContain('value="usr_1"');
    expect(html).not.toContain('>usr_1<');
    expect(html).toContain('>Slack user U1<');
  });
});

describe('items reader', () => {
  it('batches by 50 and asks once per distinct id set', async () => {
    const fetchBatch = vi.fn(async (q: string) => ({ items: q.slice(4).split(',').map((id) => ({ id })) }));
    const read = itemsReader(fetchBatch);
    const ids = Array.from({ length: 120 }, (_, i) => `m${i}`);
    expect(idBatches(ids).map((b) => b.length)).toEqual([50, 50, 20]);
    const results = await Promise.all([read(ids), read([...ids]), read(ids)]);
    expect(fetchBatch).toHaveBeenCalledTimes(3);
    expect(Object.keys(results[0])).toHaveLength(120);
    await read(ids.slice(0, 5));
    expect(fetchBatch).toHaveBeenCalledTimes(4);
  });
});
