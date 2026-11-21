/**
 * W4 (§4.6): the honest daemon-connection line on the TUI status line —
 * plain text in a non-`ready` daemon state, nothing on the default
 * in-process path, and it renders even over a deliberately blanked
 * status line (an exception state is not a configurable item).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { TuiStatusLine } from '../../src/tui/shell/chrome.js';
import type { TuiShellState } from '../../src/tui/shell/contracts.js';

function state(daemonConnection?: TuiShellState['daemonConnection']): TuiShellState {
  return {
    version: '0.0.0-test',
    workspace: '/repo',
    runtimeStatus: 'ready',
    statusLineItems: ['current-dir'],
    ...(daemonConnection !== undefined ? { daemonConnection } : {}),
  };
}

const render = (daemonConnection?: TuiShellState['daemonConnection']): string[] =>
  new TuiStatusLine(state(daemonConnection)).render(120).map((line) => strip(line));

function strip(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('daemon connection status line (W4 §4.6)', () => {
  it('the default in-process path renders no daemon line', () => {
    const lines = render(undefined);
    expect(lines.join('\n')).not.toContain('daemon');
  });

  it('a ready daemon renders no daemon line (no news is no line)', () => {
    expect(render('ready').join('\n')).not.toContain('daemon');
  });

  it('reconnecting is an honest text line, never a spinner', () => {
    const lines = render('reconnecting');
    expect(lines.join('\n')).toContain('daemon: reconnecting…');
  });

  it('connecting, offline and closed states render their labels', () => {
    expect(render('connecting').join('\n')).toContain('daemon: connecting…');
    expect(render('disconnected').join('\n')).toContain('daemon offline');
    expect(render('closed').join('\n')).toContain('daemon disconnected');
  });

  it('the daemon line renders even over a deliberately blanked status line', () => {
    const blank = { ...state('reconnecting'), statusLineItems: [] };
    const lines = new TuiStatusLine(blank).render(120).map((line) => strip(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('daemon: reconnecting…');
  });
});
