/** @jest-environment jsdom */

import { fireEvent, getByRole, waitFor } from '@testing-library/dom';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { renderAntigravityPermissionSetting } from '@/providers/antigravity/AntigravityPermissionSettings';
import { getAntigravitySettings } from '@/providers/antigravity/settings';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  Setting: class {
    constructor(private container: HTMLElement) {}
    setName(name: string) { const label = document.createElement('div'); label.textContent = name; this.container.append(label); return this; }
    setDesc(description: string) { const desc = document.createElement('div'); desc.textContent = description; this.container.append(desc); return this; }
    addDropdown(render: (control: unknown) => void) {
      const selectEl = document.createElement('select');
      this.container.append(selectEl);
      const control = {
        selectEl,
        addOption(value: string, label: string) { selectEl.add(new Option(label, value)); return this; },
        setValue(value: string) { selectEl.value = value; return this; },
        setDisabled(value: boolean) { selectEl.disabled = value; return this; },
        onChange(callback: (value: string) => Promise<void>) { selectEl.addEventListener('change', () => { void callback(selectEl.value); }); return this; },
      };
      render(control);
      return this;
    }
  },
}));

expect.extend(toHaveNoViolations);

it('exposes a named native control and persists full access without replacing provider settings', async () => {
  const container = document.createElement('main');
  const settings = { providerConfigs: { antigravity: { future: 'preserve' } } };
  const host = { settings, applyProviderRuntimeSettings: async (_ids: string[], update: (bag: typeof settings) => void) => { update(settings); } } as unknown as ProviderHost;
  renderAntigravityPermissionSetting(container, host);
  const control = getByRole(container, 'combobox', { name: 'Tool permissions' }) as HTMLSelectElement;
  expect(control).toBeInstanceOf(HTMLSelectElement);
  expect(control.value).toBe('native');
  fireEvent.change(control, { target: { value: 'full-access' } });
  await waitFor(() => expect(getAntigravitySettings(settings).autoApproveAllTools).toBe(true));
  expect(settings.providerConfigs.antigravity.future).toBe('preserve');
  await waitFor(() => expect(control.disabled).toBe(false));
  expect(await axe(container)).toHaveNoViolations();
  fireEvent.change(control, { target: { value: 'native' } });
  await waitFor(() => expect(getAntigravitySettings(settings).autoApproveAllTools).toBe(false));
});
