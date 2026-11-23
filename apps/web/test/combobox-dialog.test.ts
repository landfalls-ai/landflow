// @vitest-environment happy-dom
/** C23: a Combobox inside a Dialog: Escape closes the list and keeps the dialog open (the credential picker sits in the node panel's dialogs). */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Combobox } from '../src/components/ui/combobox';
import { Dialog } from '../src/components/ui/dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const options = [
  { value: 'a', label: 'prod key' },
  { value: 'b', label: 'dev key' },
];
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

describe('Combobox in a Dialog', () => {
  it('Escape closes the list and not the dialog; a second Escape closes the dialog (fails if the list lets Escape reach the dialog)', () => {
    const onClose = vi.fn();
    act(() => root.render(createElement(Dialog, { title: 'Node', onClose }, createElement(Combobox, { id: 'c', label: 'Credential', value: undefined, options, onChange: () => {} }))));
    const trigger = document.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const search = document.querySelector('input[role="combobox"]')!;
    key(search, 'Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('input[role="combobox"]')).toBeNull();
    key(trigger, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('picks with the keyboard inside the dialog', () => {
    const onChange = vi.fn();
    act(() => root.render(createElement(Dialog, { title: 'Node', onClose: () => {} }, createElement(Combobox, { id: 'c', label: 'Credential', value: undefined, options, onChange }))));
    act(() => document.querySelector<HTMLButtonElement>('button[role="combobox"]')!.click());
    const search = document.querySelector('input[role="combobox"]')!;
    key(search, 'ArrowDown');
    key(search, 'Enter');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
