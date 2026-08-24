import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HELP, help } from '../ui/help.js';

const dashboard = readFileSync(new URL('../ui/main.ts', import.meta.url), 'utf8');

/** Every `help('x')` and `helpKey` string the dashboard asks for. */
function keysUsed(): string[] {
  const used = new Set<string>();
  for (const match of dashboard.matchAll(/help\('([a-zA-Z]+)'\)/g)) used.add(match[1]!);
  for (const match of dashboard.matchAll(/,\s*'([a-zA-Z]+)'\)\}/g)) used.add(match[1]!);
  return [...used];
}

describe('dashboard help', () => {
  /**
   * A missing key renders nothing at all rather than failing, so a typo would
   * quietly leave a control unexplained.
   */
  it('has copy for every key the dashboard asks for', () => {
    const missing = keysUsed().filter((key) => !(key in HELP));
    expect(missing).toEqual([]);
  });

  it('actually asks for a fair number of them', () => {
    expect(keysUsed().length).toBeGreaterThan(15);
  });

  it('renders an accessible, focusable control', () => {
    const markup = help('capitalRatio');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label=');
    expect(markup).toContain('data-help=');
  });

  it('renders nothing for a key with no copy, rather than an empty bubble', () => {
    expect(help('nothingKnownAboutThis')).toBe('');
  });

  it('escapes quotes so copy cannot break out of the attribute', () => {
    const markup = help('debtService');
    // The copy contains an apostrophe; it must not appear raw inside the value.
    expect(HELP.debtService).toContain("'");
    expect(markup).toContain('&#39;');
    expect(markup.match(/data-help="([^"]*)"/)).not.toBeNull();
  });

  it('explains things in plain language rather than restating the label', () => {
    for (const [key, text] of Object.entries(HELP)) {
      expect(text.length, `${key} is too terse to help anyone`).toBeGreaterThan(40);
      expect(text.length, `${key} is too long for a hover`).toBeLessThan(340);
      expect(text.trim().endsWith('.'), `${key} should be a sentence`).toBe(true);
    }
  });
});
