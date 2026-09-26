import { describe, expect, it } from 'vitest';

import { findReferencedGlobalConfigs } from './flow-normalizer.js';

const tabA = { id: 'tabA', type: 'tab', label: 'A' };
const tabB = { id: 'tabB', type: 'tab', label: 'B' };

describe('findReferencedGlobalConfigs', () => {
  it('returns global config nodes referenced by the flow, following config-to-config references', () => {
    const records = [
      tabA,
      { id: 'btn', type: 'ui_button', z: 'tabA', x: 10, y: 10, group: 'grp' },
      { id: 'grp', type: 'ui_group', name: 'Actions', tab: 'uitab' },
      { id: 'uitab', type: 'ui_tab', name: 'Device Control' },
      { id: 'unused', type: 'ui_group', name: 'Unused', tab: 'uitab' },
    ];

    const ids = findReferencedGlobalConfigs(records, 'tabA').map(record => record.id);

    expect(ids).toEqual(['grp', 'uitab']);
  });

  it('ignores global configs that only another flow references', () => {
    const records = [
      tabA,
      tabB,
      { id: 'btnA', type: 'ui_button', z: 'tabA', x: 1, y: 1, label: 'plain' },
      { id: 'btnB', type: 'ui_button', z: 'tabB', x: 1, y: 1, group: 'grp' },
      { id: 'grp', type: 'ui_group', name: 'Actions' },
    ];

    expect(findReferencedGlobalConfigs(records, 'tabA')).toEqual([]);
  });

  it('matches whole property values, not substrings of them', () => {
    const records = [
      tabA,
      { id: 'fn', type: 'function', z: 'tabA', x: 1, y: 1, name: 'uses grp inside a label' },
      { id: 'grp', type: 'ui_group', name: 'Actions' },
    ];

    expect(findReferencedGlobalConfigs(records, 'tabA')).toEqual([]);
  });

  it('does not treat scoped config nodes (those with z) as global', () => {
    const records = [
      tabA,
      tabB,
      { id: 'mqttIn', type: 'mqtt in', z: 'tabA', x: 1, y: 1, broker: 'broker' },
      { id: 'broker', type: 'mqtt-broker', z: 'tabB', broker: 'obsidian' },
    ];

    expect(findReferencedGlobalConfigs(records, 'tabA')).toEqual([]);
  });
});
