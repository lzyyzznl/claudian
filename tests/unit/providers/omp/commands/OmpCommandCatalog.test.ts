import { OmpCommandCatalog } from '@/providers/omp/commands/OmpCommandCatalog';

describe('OmpCommandCatalog', () => {
  it('maps runtime commands into slash dropdown entries without changing order', async () => {
    const catalog = new OmpCommandCatalog();
    catalog.setCommandSnapshot([
      {
        argumentHint: '<topic>',
        content: '',
        description: 'Review changes',
        id: 'omp:prompt:review',
        name: 'review',
        source: 'sdk',
      },
      {
        content: '',
        description: 'Duplicate review',
        id: 'omp:prompt:review-duplicate',
        name: 'review',
        source: 'sdk',
      },
      {
        content: '',
        description: 'Skill command',
        id: 'omp:skill:test',
        kind: 'skill',
        name: 'test',
        source: 'sdk',
      },
    ]);

    await expect(catalog.listDropdownEntries({ includeBuiltIns: false })).resolves.toEqual([
      expect.objectContaining({
        argumentHint: '<topic>',
        description: 'Review changes',
        displayPrefix: '/',
        id: 'omp:prompt:review',
        insertPrefix: '/',
        isDeletable: false,
        isEditable: false,
        kind: 'command',
        name: 'review',
        providerId: 'omp',
        scope: 'runtime',
      }),
      expect.objectContaining({
        description: 'Duplicate review',
        id: 'omp:prompt:review-duplicate',
        name: 'review',
        providerId: 'omp',
      }),
      expect.objectContaining({
        id: 'omp:skill:test',
        kind: 'skill',
        name: 'test',
        providerId: 'omp',
      }),
    ]);
  });

  it('uses slash triggers without exposing editable vault operations', () => {
    const catalog = new OmpCommandCatalog();

    expect(catalog.getDropdownConfig()).toEqual({
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'omp',
      skillPrefix: '/',
      triggerChars: ['/'],
    });
    expect('listVaultEntries' in catalog).toBe(false);
    expect('saveVaultEntry' in catalog).toBe(false);
    expect('deleteVaultEntry' in catalog).toBe(false);
  });

  it('preserves provider-advertised names and order', async () => {
    const catalog = new OmpCommandCatalog();
    catalog.setCommandSnapshot([
      { content: '', id: 'one', name: 'skill:shared-review', source: 'sdk' },
      { content: '', id: 'two', name: 'scope:qualified', source: 'sdk' },
    ]);

    const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

    expect(entries.map((entry) => entry.name)).toEqual([
      'skill:shared-review',
      'scope:qualified',
    ]);
  });
});
