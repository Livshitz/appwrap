import { describe, expect, test } from 'bun:test';
import { notifIdentity } from '../app/shell/notif-identity';

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
