/**
 * The render fixtures' input (backbone/contracts/nb/README.md §3a): three objects as the wiki routes build them for a
 * project's members (`wikiPage` and `wikiHome` with the project's scope and no person), the Notion page each mapped page
 * has, and the words around them. NB04's renderer turns `KESTREL_BANK` into kestrel-bank.md, `ANA` into ana.md and `HOME`
 * into home.md byte for byte; NB05's pull reads those three files to find the region and "Your notes".
 *
 * Made-up data (no real person, company or key). Written by the plan for the Notion brain program, wave nb2: NB04 owns it
 * (backbone/contracts/nb/render-fixtures/); NB04 and NB05 copy the folder byte for byte to apps/web/test/fixtures/notion-render/.
 * Change it in the contract first, then every copy.
 */
import type { Proposal } from '@/lib/shared/brain';
import type { WikiHome, WikiPage } from '@/lib/shared/brain-wiki';

export const PROJECT = { id: 'prj_northwind', name: 'Northwind' } as const;

/** LANDFLOW_PUBLIC_URL for the "Open in Landflow" links. */
export const PUBLIC_URL = 'http://landflow.test';

/**
 * The Notion page of each local page that has one (`notion_brain_items` kind `entity`: `local_key` → `notion_id`). A link
 * to a page in this map becomes a page mention; a link to any other page (`system/card-gateway`, `person/omar`) its name.
 */
export const MAPPED: Readonly<Record<string, string>> = {
  'initiative/q4-renewals': '0a1b2c3d-0001-4000-8000-000000000001',
  'initiative/sso-rollout': '0a1b2c3d-0001-4000-8000-000000000002',
  'initiative/pricing-2027': '0a1b2c3d-0001-4000-8000-000000000003',
  'customer/kestrel-bank': '0a1b2c3d-0002-4000-8000-000000000001',
  'customer/harbor-air': '0a1b2c3d-0002-4000-8000-000000000002',
  'customer/lumen-health': '0a1b2c3d-0002-4000-8000-000000000003',
  'customer/orbit-foods': '0a1b2c3d-0002-4000-8000-000000000004',
  'person/ana': '0a1b2c3d-0003-4000-8000-000000000001',
  'person/ben': '0a1b2c3d-0003-4000-8000-000000000002',
  'person/chen': '0a1b2c3d-0003-4000-8000-000000000003',
  'person/dana': '0a1b2c3d-0003-4000-8000-000000000004',
  'person/eli': '0a1b2c3d-0003-4000-8000-000000000005',
  'system/billing-api': '0a1b2c3d-0004-4000-8000-000000000001',
  'system/ledger-api': '0a1b2c3d-0004-4000-8000-000000000002',
};

const AT = '2026-11-18T08:00:00.000Z';

const proposal = (input: Pick<Proposal, 'id' | 'title' | 'why' | 'target'>): Proposal => ({
  ...input,
  source: 'detector',
  fingerprint: `fixture:${input.id}`,
  projectId: PROJECT.id,
  evidence: [],
  ops: [],
  risk: 'low',
  confidence: 0.7,
  score: 5,
  status: 'open',
  createdAt: AT,
  updatedAt: AT,
});

/** A customer with a summary (links to a mapped page, an unmapped one and a person), work, people, related pages, facts, a suggestion and a mention. */
export const KESTREL_BANK: WikiPage = {
  entity: {
    type: 'customer',
    id: 'kestrel-bank',
    name: 'Kestrel Bank',
    description: 'Regional bank; our largest card-issuing customer.',
    owner: 'usr_ana',
    ownerName: 'Ana Ruiz',
    projectId: PROJECT.id,
    attrs: { tier: 'enterprise', region: 'EMEA' },
    source: 'ui',
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-11-17T09:30:00.000Z',
  },
  summary: {
    text: 'Kestrel Bank renews for 2027 under [[initiative/q4-renewals|Q4 renewals]], led by [[person/ana|Ana Ruiz]] [1]. Its card feed goes through [[system/card-gateway]], which timed out twice this month [2].\n',
    model: 'fixture-model',
    generatedAt: '2026-11-17T10:00:00.000Z',
    stale: false,
    links: [
      { ref: 'initiative/q4-renewals', name: 'Q4 renewals' },
      { ref: 'person/ana', name: 'Ana Ruiz' },
      { ref: 'system/card-gateway', name: 'Card gateway' },
    ],
  },
  work: [
    {
      id: 'wrk_1',
      at: '2026-11-17T09:12:00.000Z',
      kind: 'work.pr_merged',
      source: 'github',
      title: 'Kestrel renewal quote for <n>',
      summary: 'Adds the <n> price sheet and the EMEA discount.',
      url: 'https://github.com/acme/quotes/pull/42',
      actor: 'ana@acme.test',
      team: 'Sales',
      customer: 'Kestrel Bank',
      refs: ['customer/kestrel-bank', 'person/ana', 'initiative/q4-renewals'],
    },
    {
      id: 'wrk_2',
      at: '2026-11-16T15:40:00.000Z',
      kind: 'work.ticket_moved',
      source: 'linear',
      title: 'Card feed retries after gateway timeouts',
      actor: 'fay@acme.test',
      team: 'Support',
      refs: ['customer/kestrel-bank', 'system/card-gateway'],
    },
    {
      id: 'wrk_3',
      at: '2026-11-14T11:05:00.000Z',
      kind: 'work.meeting_held',
      source: 'fathom',
      title: 'Kestrel QBR',
      summary: 'Asked for SSO on the card portal by March.',
      actor: 'ana@acme.test',
      team: 'Sales',
      refs: ['customer/kestrel-bank', 'person/ana', 'system/ledger-api'],
    },
  ],
  people: [
    { ref: 'person/ana', name: 'Ana Ruiz', email: 'ana@acme.test', team: 'Sales', events: 2 },
    // No person page: the wiki names them by their email, which never reaches Notion as it is.
    { name: 'fay@acme.test', email: 'fay@acme.test', team: 'Support', events: 1 },
  ],
  related: [
    { ref: 'initiative/q4-renewals', type: 'initiative', id: 'q4-renewals', name: 'Q4 renewals', shared: 1 },
    { ref: 'system/card-gateway', type: 'system', id: 'card-gateway', name: 'Card gateway', shared: 1 },
    { ref: 'system/ledger-api', type: 'system', id: 'ledger-api', name: 'Ledger API', shared: 1 },
  ],
  teams: [
    { team: 'Sales', events: 2 },
    { team: 'Support', events: 1 },
  ],
  facts: [
    {
      id: 'fct_k1',
      subjectType: 'entity',
      subjectId: 'customer/kestrel-bank',
      subjectName: 'Kestrel Bank',
      kind: 'purpose',
      statement: 'Issues corporate cards through our card feed.',
      evidence: [],
      confidence: 0.9,
      projectId: PROJECT.id,
      firstSeen: '2026-10-05T00:00:00.000Z',
      lastSeen: '2026-11-17T00:00:00.000Z',
      status: 'active',
    },
    {
      id: 'fct_k2',
      subjectType: 'entity',
      subjectId: 'customer/kestrel-bank',
      subjectName: 'Kestrel Bank',
      kind: 'dependency',
      statement: 'Settles nightly through the Ledger API (alerts when latency > 2 s).',
      evidence: [],
      confidence: 0.8,
      projectId: PROJECT.id,
      firstSeen: '2026-10-20T00:00:00.000Z',
      lastSeen: '2026-11-16T00:00:00.000Z',
      status: 'active',
    },
  ],
  proposals: [
    proposal({
      id: 'prp_k1',
      title: 'Name an owner for the card feed',
      why: 'Two timeouts this month and nobody owns the card gateway integration.',
      target: { type: 'entity', id: 'customer/kestrel-bank', name: 'Kestrel Bank' },
    }),
  ],
  mentionedIn: [{ ref: 'initiative/q4-renewals', name: 'Q4 renewals' }],
  canEdit: false,
};

/** A person with no summary yet, work that names them, someone they work with who has no Notion page, related pages and a mention. */
export const ANA: WikiPage = {
  entity: {
    type: 'person',
    id: 'ana',
    name: 'Ana Ruiz',
    description: 'Account lead for EMEA banks.',
    projectId: PROJECT.id,
    attrs: { department: 'Sales' },
    source: 'api',
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-11-10T12:00:00.000Z',
  },
  work: [
    {
      id: 'wrk_1',
      at: '2026-11-17T09:12:00.000Z',
      kind: 'work.pr_merged',
      source: 'github',
      title: 'Kestrel renewal quote for <n>',
      summary: 'Adds the <n> price sheet and the EMEA discount.',
      url: 'https://github.com/acme/quotes/pull/42',
      actor: 'ana@acme.test',
      team: 'Sales',
      refs: ['customer/kestrel-bank', 'person/ana', 'initiative/q4-renewals'],
    },
    {
      id: 'wrk_3',
      at: '2026-11-14T11:05:00.000Z',
      kind: 'work.meeting_held',
      source: 'fathom',
      title: 'Kestrel QBR',
      actor: 'ana@acme.test',
      team: 'Sales',
      refs: ['customer/kestrel-bank', 'person/ana', 'system/ledger-api'],
    },
  ],
  people: [{ ref: 'person/omar', name: 'Omar Haddad', email: 'omar@acme.test', team: 'Sales', events: 1 }],
  related: [
    { ref: 'customer/kestrel-bank', type: 'customer', id: 'kestrel-bank', name: 'Kestrel Bank', shared: 2 },
    { ref: 'initiative/q4-renewals', type: 'initiative', id: 'q4-renewals', name: 'Q4 renewals', shared: 1 },
    { ref: 'system/ledger-api', type: 'system', id: 'ledger-api', name: 'Ledger API', shared: 1 },
  ],
  teams: [{ team: 'Sales', events: 2 }],
  facts: [],
  proposals: [],
  mentionedIn: [{ ref: 'customer/kestrel-bank', name: 'Kestrel Bank' }],
  canEdit: false,
};

const entry = (type: WikiHome['entries'][number]['type'], id: string, name: string, week = 0) => ({ type, id, name, week, month: week, teams: [] as string[] });

/** The project's index: 14 pages (3 initiatives, 4 customers, 5 people, 2 systems), shared work, two suggestions, two teams and pages that need a person. */
export const HOME: WikiHome = {
  status: { enabled: true, model: 'fixture-model', events: 7, facts: 16, profiles: 0, entities: 14, open: 2, detectors: [] },
  days: 7,
  entries: [
    entry('initiative', 'q4-renewals', 'Q4 renewals', 2),
    entry('initiative', 'sso-rollout', 'SSO rollout'),
    entry('initiative', 'pricing-2027', 'Pricing 2027'),
    entry('customer', 'kestrel-bank', 'Kestrel Bank', 3),
    entry('customer', 'harbor-air', 'Harbor Air'),
    entry('customer', 'lumen-health', 'Lumen Health'),
    entry('customer', 'orbit-foods', 'Orbit Foods'),
    entry('person', 'ana', 'Ana Ruiz', 2),
    entry('person', 'ben', 'Ben Okafor'),
    entry('person', 'chen', 'Chen Wei'),
    entry('person', 'dana', 'Dana Levi'),
    entry('person', 'eli', 'Eli Brandt'),
    entry('system', 'billing-api', 'Billing API'),
    entry('system', 'ledger-api', 'Ledger API', 1),
  ],
  shared: [
    {
      ref: 'customer/kestrel-bank',
      type: 'customer',
      id: 'kestrel-bank',
      name: 'Kestrel Bank',
      teams: [
        { team: 'Sales', events: 2, people: ['Ana Ruiz'] },
        { team: 'Support', events: 1, people: ['fay@acme.test'] },
      ],
      events: 3,
      lastAt: '2026-11-17T09:12:00.000Z',
      latest: [],
    },
  ],
  teams: [
    {
      team: 'Sales',
      events: 5,
      people: 2,
      top: [
        { ref: 'customer/kestrel-bank', name: 'Kestrel Bank', events: 3 },
        { ref: 'initiative/q4-renewals', name: 'Q4 renewals', events: 2 },
      ],
    },
    { team: 'Support', events: 2, people: 1, top: [{ ref: 'system/card-gateway', name: 'Card gateway', events: 1 }] },
  ],
  kinds: [],
  recent: [],
  proposals: [
    proposal({ id: 'prp_k1', title: 'Name an owner for the card feed', why: 'Two timeouts this month.', target: { type: 'entity', id: 'customer/kestrel-bank', name: 'Kestrel Bank' } }),
    proposal({ id: 'prp_h1', title: 'Merge the two SSO pages', why: 'Both pages describe one rollout.', target: { type: 'instance' } }),
  ],
  health: {
    noOwner: [{ ref: 'system/billing-api', name: 'Billing API' }],
    quiet: [{ ref: 'customer/orbit-foods', name: 'Orbit Foods' }],
    staleSummaries: [],
  },
  model: 'fixture-model',
};

/** Each fixture file and what it is rendered from. */
export const RENDER_CASES = [
  { file: 'kestrel-bank.md', kind: 'page', page: KESTREL_BANK },
  { file: 'ana.md', kind: 'page', page: ANA },
  { file: 'home.md', kind: 'home', home: HOME },
] as const;
