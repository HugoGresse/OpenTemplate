import { describe, it, expect } from 'vitest';
import { interpolate } from '../../src/utils/interpolate.js';

describe('interpolate', () => {
  it('substitutes simple variables', () => {
    expect(interpolate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('HTML-escapes by default', () => {
    expect(interpolate('{{x}}', { x: '<script>x</script>' })).toBe(
      '&lt;script&gt;x&lt;&#x2F;script&gt;'
    );
  });

  it('supports raw output via triple braces', () => {
    expect(interpolate('{{{x}}}', { x: '<b>raw</b>' })).toBe('<b>raw</b>');
  });

  it('converts newlines in {{var}} to <br /> while still HTML-escaping', () => {
    expect(interpolate('{{msg}}', { msg: 'Line 1\nLine 2' })).toBe('Line 1<br />Line 2');
  });

  it('handles Windows CRLF line endings', () => {
    expect(interpolate('{{msg}}', { msg: 'A\r\nB\r\nC' })).toBe('A<br />B<br />C');
  });

  it('handles bare CR line endings', () => {
    expect(interpolate('{{msg}}', { msg: 'A\rB' })).toBe('A<br />B');
  });

  it('escapes HTML AND converts newlines together', () => {
    expect(interpolate('{{msg}}', { msg: '<b>hi</b>\nbye' })).toBe(
      '&lt;b&gt;hi&lt;&#x2F;b&gt;<br />bye'
    );
  });

  it('triple braces leave newlines untouched (user controls)', () => {
    expect(interpolate('{{{msg}}}', { msg: 'A\nB' })).toBe('A\nB');
  });

  it('renders missing keys as empty string', () => {
    expect(interpolate('A{{missing}}B', {})).toBe('AB');
  });

  it('handles nested objects', () => {
    expect(interpolate('{{user.name}}', { user: { name: 'A' } })).toBe('A');
  });

  it('returns input unchanged when no placeholders', () => {
    expect(interpolate('plain text', { ignored: 1 })).toBe('plain text');
  });
});
