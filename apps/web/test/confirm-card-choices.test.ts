/** The Ask a Person card with Answer Choices (C35-C2 U-3): a select with the first chosen, sent with Approve; unchanged without choices. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmCard, approveBody, type ConfirmRequest } from '../src/components/run-trace/confirm-card';

const base: ConfirmRequest = { title: 'Give Mia Platform for 4 h?', text: 'Because on call', allowEdit: false, approvers: ['Ada'] };
const card = (request: ConfirmRequest) => renderToStaticMarkup(createElement(ConfirmCard, { executionId: 'x1', request, nodeName: 'Ask the approver', since: '2026-11-23T10:00:00Z', onDecided: () => {} }));

describe('the confirm card’s choices', () => {
  it('renders a select with the first choice chosen', () => {
    const out = card({ ...base, choices: [{ value: '240', label: '4 h' }, { value: '60', label: '1 h' }] });
    expect(out).toContain('data-testid="confirm-choice"');
    expect(out).toMatch(/<option value="240"[^>]*selected[^>]*>4 h<\/option>|<option[^>]*selected[^>]*value="240"/);
    expect(out).toContain('1 h');
  });
  it('sends the choice with Approve, and none with Reject or without choices', () => {
    expect(approveBody(true, { choice: '60', changed: false, text: 't', comment: '' })).toEqual({ approved: true, choice: '60' });
    expect(approveBody(false, { choice: '60', changed: false, text: 't', comment: 'no' })).toEqual({ approved: false, comment: 'no' });
    expect(approveBody(true, { choice: undefined, changed: true, text: 'new', comment: ' ok ' })).toEqual({ approved: true, text: 'new', comment: 'ok' });
  });
  it('without choices the card has no select', () => {
    const out = card(base);
    expect(out).not.toContain('confirm-choice');
    expect(out).toContain('data-testid="confirm-approve"');
  });
});
