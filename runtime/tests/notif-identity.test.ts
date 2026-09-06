import { describe, expect, test } from 'bun:test';
import { notifIdentity, notifActions, bestEffort, bestEffortAsync, MAX_NOTIF_ACTIONS } from '../app/shell/notif-identity';

describe('notifIdentity', () => {
  test('no sender/icon → plain, identity not used', () => {
    const r = notifIdentity({ title: 'Reminder', body: 'Hi' });
    expect(r).toEqual({
      title: 'Reminder', subtitle: '', body: 'Hi',
      senderName: '', iconUrl: '', useIdentity: false,
    });
  });

  test('sender named → sender becomes title, original demoted to subtitle', () => {
    const r = notifIdentity({ title: 'You won!', body: 'Tap', sender: 'Coin Flip', icon: 'https://x/i.png' });
    expect(r.title).toBe('Coin Flip');
    expect(r.subtitle).toBe('You won!');
    expect(r.senderName).toBe('Coin Flip');
    expect(r.iconUrl).toBe('https://x/i.png');
    expect(r.useIdentity).toBe(true);
  });

  test('subtitle dropped when title duplicates the sender', () => {
    const r = notifIdentity({ title: 'Coin Flip', sender: 'Coin Flip' });
    expect(r.title).toBe('Coin Flip');
    expect(r.subtitle).toBe('');
  });

  test('icon only (no sender) → identity used, title kept, no subtitle', () => {
    const r = notifIdentity({ title: 'Ping', icon: 'data:image/png;base64,AAAA' });
    expect(r.title).toBe('Ping');
    expect(r.subtitle).toBe('');
    expect(r.senderName).toBe('');
    expect(r.iconUrl).toBe('data:image/png;base64,AAAA');
    expect(r.useIdentity).toBe(true);
  });

  test('missing title/body coerce to empty strings', () => {
    const r = notifIdentity({});
    expect(r.title).toBe('');
    expect(r.body).toBe('');
    expect(r.useIdentity).toBe(false);
  });
});

describe('notifActions', () => {
  test('drops entries with no id or title, and dedupes ids', () => {
    const r = notifActions([
      { id: 'later', title: 'Maybe later' },
      { id: '', title: 'nameless' },
      { id: 'chat', title: '' },
      { id: 'later', title: 'duplicate' },
      { id: 'chat', title: "Let's chat!", deepLink: 'blank://a/x?screen=chat' },
    ]);
    expect(r.map((a) => a.id)).toEqual(['later', 'chat']);
    expect(r[1].deepLink).toBe('blank://a/x?screen=chat');
    expect(r[0].deepLink).toBeUndefined();
  });

  test('caps at 3 — the widest set every platform actually draws', () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ id: `a${n}`, title: `A${n}` }));
    expect(notifActions(many)).toHaveLength(MAX_NOTIF_ACTIONS);
    expect(MAX_NOTIF_ACTIONS).toBe(3);
  });

  test('a missing / non-array actions option is simply no buttons', () => {
    expect(notifActions(undefined)).toEqual([]);
    expect(notifActions('nope' as unknown)).toEqual([]);
  });
});

describe('bestEffort — decoration never costs the notification', () => {
  test('a throwing decorative step degrades to the fallback instead of propagating', () => {
    expect(bestEffort('buttons', () => { throw new Error('category refused'); }, '')).toBe('');
    expect(bestEffort('sender identity', () => { throw new Error('SpringBoard denied'); }, null)).toBeNull();
  });

  test('the value passes through untouched when the step succeeds', () => {
    expect(bestEffort('buttons', () => 'awcat-abc', '')).toBe('awcat-abc');
  });

  test('async: a rejected artwork/sound resolve degrades to null, it does not reject', async () => {
    await expect(bestEffortAsync('artwork', async () => { throw new Error('download blew up'); }, null))
      .resolves.toBeNull();
    await expect(bestEffortAsync('sound', async () => 'ding.caf', null)).resolves.toBe('ding.caf');
  });
});
