import { ACTIVITY_ITEM_SCHEMA, defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor, type PropertyOption } from '@landflow/sdk';
import {
  ACTIVITY_WITH_TEXT_SCHEMA,
  COMMENT_FIELDS,
  commentActivity,
  hintsOf,
  issueActivity,
  issueFields,
  issueText,
  listOf,
  PROJECT_UPDATE_FIELDS,
  projectUpdateActivity,
  sinceIso,
} from '../activity';
import { DEFAULT_BASE_URL, graphql, pickCredentials, type ApiContext, type LinearCredentials } from '../client';

/** Hard stop for one changed-since read: 100 pages of 50. */
export const MAX_FETCH = 5000;
const PAGE_SIZE = 50;

// --- credentials ----------------------------------------------------------------------------------------------------

const viewerTest = async (data: LinearCredentials, ctx: { http: ApiContext['http'] }) => {
  try {
    const { viewer } = await graphql<{ viewer: { name?: string; email?: string } }>({ http: ctx.http }, data, '{ viewer { id name email } }', {}, { retries: 0 });
    return { ok: true, message: `Authenticated as ${viewer.name ?? 'unknown'}${viewer.email ? ` (${viewer.email})` : ''}` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
};

const baseUrlProperty: PropertyDescriptor = {
  name: 'baseUrl',
  displayName: 'Base URL',
  type: 'string',
  default: DEFAULT_BASE_URL,
  description: 'Change it only for a proxy or a test double. The GraphQL endpoint is <base URL>/graphql.',
};

export const linearApi = defineCredentialType<LinearCredentials>({
  name: 'linearApi',
  displayName: 'Linear API',
  icon: 'file:linear.svg',
  documentationUrl: 'https://linear.app/developers/graphql',
  description:
    'A personal API key (Linear Settings, Security & access). It is sent as is in the Authorization header, without Bearer. A key acts as you: creating webhooks for the Linear Trigger needs a workspace admin.',
  properties: [
    { name: 'apiKey', displayName: 'API Key', type: 'string', required: true, typeOptions: { password: true }, placeholder: 'lin_api_…', description: 'Personal API key' },
    baseUrlProperty,
  ],
  test: viewerTest,
});

/**
 * Linear OAuth2: extends the host's generic OAuth2 type. Connect runs the authorization-code flow; the access token
 * (about a day) is renewed with the refresh token. Scopes default to what the actions need and no more.
 */
export const linearOAuth2Api = defineCredentialType<LinearCredentials>({
  name: 'linearOAuth2Api',
  displayName: 'Linear OAuth2 API',
  icon: 'file:linear.svg',
  documentationUrl: 'https://linear.app/developers/oauth-2-0-authentication',
  description:
    'Sign in with Linear: create an OAuth2 application (Linear Settings, API), add the redirect URL shown below, then Connect. ' +
    'The default scopes are read plus issues:create and comments:create, which cover every node operation. ' +
    'The Linear Trigger registers its webhook through the API, which needs the admin scope: add it to Scopes (or register the webhook yourself and use a key).',
  extends: ['oAuth2Api'],
  properties: [
    { name: 'grantType', displayName: 'Grant Type', type: 'hidden', default: 'authorizationCode' },
    { name: 'authUrl', displayName: 'Authorization URL', type: 'hidden', default: 'https://linear.app/oauth/authorize' },
    { name: 'accessTokenUrl', displayName: 'Access Token URL', type: 'hidden', default: 'https://api.linear.app/oauth/token' },
    { name: 'authentication', displayName: 'Client Authentication', type: 'hidden', default: 'body' },
    {
      name: 'scope',
      displayName: 'Scopes',
      type: 'string',
      default: 'read,issues:create,comments:create',
      description: 'Comma-separated scopes asked for at Connect. read: all reads. issues:create: create issues and attach links. comments:create: comment. admin: needed only to register the Linear Trigger\'s webhook.',
    },
    baseUrlProperty,
  ],
  test: viewerTest,
});

// --- reading ---------------------------------------------------------------------------------------------------------

/**
 * Records updated after `since`, oldest first. Linear can only order newest first (`orderBy: updatedAt`), so the pages
 * (50 each, `after` = the previous `endCursor`) are read to the end and sorted here. `limit` keeps the oldest ones,
 * and a limit that falls inside a run of equal `updatedAt` takes the whole run, so the next read (Since = the last
 * item's cursor, `gt`) loses nothing.
 */
export async function changedSince(
  api: ApiContext,
  credentials: LinearCredentials,
  connection: 'issues' | 'comments' | 'projectUpdates',
  fields: string,
  since: string,
  options: { limit: number; filter?: JsonObject; max?: number },
): Promise<JsonObject[]> {
  const filterType = { issues: 'IssueFilter', comments: 'CommentFilter', projectUpdates: 'ProjectUpdateFilter' }[connection];
  const query = `query($filter: ${filterType}, $first: Int, $after: String) {
    ${connection}(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${fields} } pageInfo { hasNextPage endCursor } }
  }`;
  const filter: JsonObject = { ...(options.filter ?? {}), updatedAt: { gt: since } };
  const found: JsonObject[] = [];
  let after: string | undefined;
  do {
    const data = await graphql<Record<string, { nodes: JsonObject[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } }>>(api, credentials, query, { filter, first: PAGE_SIZE, ...(after && { after }) });
    const page = data[connection];
    found.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined;
  } while (after && found.length < (options.max ?? MAX_FETCH));
  found.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) || String(a.id).localeCompare(String(b.id)));
  if (found.length <= options.limit) return found;
  let end = options.limit;
  while (end < found.length && found[end].updatedAt === found[end - 1].updatedAt) end++;
  return found.slice(0, end);
}

// --- the node --------------------------------------------------------------------------------------------------------

const sinceOps = { show: { resource: ['issue', 'comment', 'projectUpdate'], operation: ['getManySince'] } };

export const HINT_OPTIONS: PropertyDescriptor[] = [
  {
    name: 'customerLabelPrefix',
    displayName: 'Customer Label Prefix',
    type: 'string',
    default: 'customer:',
    description: 'Used when an issue has no Linear customer needs: a label named <prefix><name> (customer:Acme) is about the customer <name> (customerHint). Empty: no label hints.',
  },
];

export const Linear = defineNode({
  description: {
    name: 'linear',
    displayName: 'Linear',
    description: 'Read Linear issues, comments and project updates changed since a time as activity items, get an issue with its comments, list users with their email, create issues and comments and attach links',
    version: 1,
    kind: 'action',
    categories: ['Productivity', 'Development'],
    icon: 'file:linear.svg',
    color: '#5E6AD2',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://linear.app/developers/graphql',
    keywords: ['linear', 'issue', 'ticket', 'comment', 'project update', 'bug', 'activity', 'changed since'],
    usableAsTool: true,
    // Create operations are at most once over a broker; reads opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription: 'Create a Linear issue, comment on an issue, attach a link to an issue, get one issue with its comments, list issues, comments or project updates changed since a time, or list workspace users with their email. It never deletes, archives or closes anything.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [
      { name: 'linearApi', required: true, displayOptions: { show: { authentication: ['apiKey'] } } },
      { name: 'linearOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    properties: [
      {
        name: 'authentication',
        displayName: 'Authentication',
        type: 'options',
        noDataExpression: true,
        default: 'apiKey',
        options: [
          { name: 'API Key', value: 'apiKey', description: 'A personal API key' },
          { name: 'OAuth2', value: 'oAuth2', description: 'Connect with Linear; the token is renewed for you' },
        ],
      },
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'issue',
        options: [
          { name: 'Comment', value: 'comment' },
          { name: 'Issue', value: 'issue' },
          { name: 'Project Update', value: 'projectUpdate' },
          { name: 'User', value: 'user' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'create',
        displayOptions: { show: { resource: ['comment'] } },
        options: [
          { name: 'Create', value: 'create', description: 'Comment on an issue', action: 'Create a comment' },
          { name: 'Get Many Changed Since', value: 'getManySince', description: 'Comments created or edited after a time, oldest first, as activity items', action: 'Get comments changed since', idempotent: true, outputSchema: ACTIVITY_ITEM_SCHEMA },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getManySince',
        displayOptions: { show: { resource: ['projectUpdate'] } },
        options: [
          { name: 'Get Many Changed Since', value: 'getManySince', description: 'Project updates posted or edited after a time, oldest first, as activity items', action: 'Get project updates changed since', idempotent: true, outputSchema: ACTIVITY_ITEM_SCHEMA },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getAll',
        displayOptions: { show: { resource: ['user'] } },
        options: [{ name: 'Get Many', value: 'getAll', description: 'List the workspace’s users with their email, status and teams', action: 'Get many users', idempotent: true }],
      },
      // The default resource's operation comes last: parameter defaults are keyed by name, last one wins.
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getManySince',
        displayOptions: { show: { resource: ['issue'] } },
        options: [
          { name: 'Add Link', value: 'addLink', description: 'Attach a URL to an issue', action: 'Add a link to an issue' },
          { name: 'Create', value: 'create', description: 'Create an issue in a team', action: 'Create an issue' },
          { name: 'Get', value: 'get', description: 'One issue as an activity item, with its description and comments as text', action: 'Get an issue', idempotent: true, outputSchema: ACTIVITY_WITH_TEXT_SCHEMA },
          { name: 'Get Many Changed Since', value: 'getManySince', description: 'Issues created or updated after a time, oldest first, as activity items', action: 'Get issues changed since', idempotent: true, outputSchema: ACTIVITY_ITEM_SCHEMA },
        ],
      },

      // Get Many Changed Since
      {
        name: 'since',
        displayName: 'Since',
        type: 'string',
        default: '',
        placeholder: '2026-11-12T08:00:00.000Z',
        displayOptions: sinceOps,
        description: 'Records updated after this ISO time, or the cursor of an earlier item (an ISO time too). Empty: the last 24 hours.',
      },
      {
        name: 'returnAll',
        displayName: 'Return All',
        type: 'boolean',
        default: false,
        displayOptions: { show: { resource: ['issue', 'comment', 'projectUpdate', 'user'], operation: ['getManySince', 'getAll'] } },
        description: 'Whether to return all results or only up to a limit',
      },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1, numberPrecision: 0 },
        displayOptions: { show: { resource: ['issue', 'comment', 'projectUpdate', 'user'], operation: ['getManySince', 'getAll'], returnAll: [false] } },
        description: 'Max number of results to return (the oldest first for Changed Since)',
      },
      {
        name: 'activityOptions',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { resource: ['issue', 'comment', 'projectUpdate'], operation: ['getManySince', 'get'] } },
        values: [
          {
            name: 'teamKey',
            displayName: 'Team Key',
            type: 'string',
            default: '',
            placeholder: 'ENG',
            description: 'Issues Get Many Changed Since: only issues of the team with this key',
          },
          {
            name: 'customerNeeds',
            displayName: 'Read Customer Needs',
            type: 'boolean',
            default: true,
            description: 'Whether to read Linear’s customer needs for the customer hint (turn off if the workspace has no Customers feature)',
          },
          ...HINT_OPTIONS,
        ],
      },

      // Get
      {
        name: 'issueId',
        displayName: 'Issue',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'ENG-123',
        displayOptions: { show: { resource: ['issue'], operation: ['get', 'addLink'] } },
        description: 'The issue’s identifier (ENG-123) or ID',
      },
      {
        name: 'issueId',
        displayName: 'Issue',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'ENG-123',
        displayOptions: { show: { resource: ['comment'], operation: ['create'] } },
        description: 'The issue to comment on: its identifier (ENG-123) or ID',
      },

      // Create issue
      {
        name: 'teamId',
        displayName: 'Team',
        type: 'options',
        required: true,
        default: '',
        typeOptions: { loadOptionsMethod: 'getTeams' },
        displayOptions: { show: { resource: ['issue'], operation: ['create'] } },
        description: 'The team that owns the issue. Pick one, or set a team ID with an expression',
      },
      {
        name: 'title',
        displayName: 'Title',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['issue'], operation: ['create'] } },
      },
      {
        name: 'description',
        displayName: 'Description',
        type: 'string',
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: { show: { resource: ['issue'], operation: ['create'] } },
        description: 'Markdown',
      },
      {
        name: 'additionalFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add field',
        displayOptions: { show: { resource: ['issue'], operation: ['create'] } },
        values: [
          { name: 'priority', displayName: 'Priority', type: 'options', default: 0, options: [{ name: 'No Priority', value: 0 }, { name: 'Urgent', value: 1 }, { name: 'High', value: 2 }, { name: 'Medium', value: 3 }, { name: 'Low', value: 4 }] },
          { name: 'assigneeId', displayName: 'Assignee ID', type: 'string', default: '', description: 'The user’s UUID (User → Get Many)' },
          { name: 'labelIds', displayName: 'Label IDs', type: 'string', default: '', description: 'Comma-separated label UUIDs' },
          { name: 'projectId', displayName: 'Project ID', type: 'string', default: '', description: 'A project UUID of the team' },
          { name: 'stateId', displayName: 'Status ID', type: 'string', default: '', description: 'A workflow state UUID of the team. Default: the team’s first status' },
          { name: 'dueDate', displayName: 'Due Date', type: 'string', default: '', placeholder: '2026-12-01', description: 'YYYY-MM-DD' },
        ],
      },

      // Create comment
      {
        name: 'body',
        displayName: 'Comment',
        type: 'string',
        required: true,
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: { show: { resource: ['comment'], operation: ['create'] } },
        description: 'Markdown. @mentions notify the people mentioned.',
      },
      {
        name: 'parentId',
        displayName: 'Reply To Comment ID',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['comment'], operation: ['create'] } },
        description: 'Optional: the root comment of a thread to reply in',
      },

      // Add link
      {
        name: 'url',
        displayName: 'URL',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'https://example.com/pull/42',
        displayOptions: { show: { resource: ['issue'], operation: ['addLink'] } },
        description: 'Attaching a URL already on the issue updates that attachment',
      },
      {
        name: 'linkTitle',
        displayName: 'Title',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['issue'], operation: ['addLink'] } },
        description: 'Shown in Linear. Empty: the URL',
      },
      {
        name: 'linkSubtitle',
        displayName: 'Subtitle',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['issue'], operation: ['addLink'] } },
      },

      // Users
      {
        name: 'includeDisabled',
        displayName: 'Include Deactivated Users',
        type: 'boolean',
        default: false,
        displayOptions: { show: { resource: ['user'], operation: ['getAll'] } },
      },
    ],
  },
  methods: {
    loadOptions: {
      async getTeams(ctx): Promise<PropertyOption[]> {
        const credentials = pickCredentials(ctx);
        const data = await graphql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>({ http: ctx.http }, credentials, '{ teams(first: 100) { nodes { id key name } } }');
        return data.teams.nodes.map((t) => ({ name: `${t.name} (${t.key})`, value: t.id })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  },
  async execute(ctx) {
    const credentials = pickCredentials(ctx, ctx.getNodeParameter('authentication', 0, 'apiKey'));
    const api: ApiContext = { http: ctx.http };
    const out: Array<{ json: JsonObject; pairedItem: { item: number } }> = [];
    const items = ctx.getInputData();
    for (let i = 0; i < items.length; i++) {
      try {
        const results = await runItem(ctx, api, credentials, i);
        for (const json of results) out.push({ json, pairedItem: { item: i } });
      } catch (error) {
        const failure = error instanceof NodeOperationError ? error : new NodeOperationError((error as Error)?.message ?? String(error), { itemIndex: i });
        if (!ctx.continueOnFail()) throw failure;
        out.push({ json: { error: failure.message, ...(failure.description && { description: failure.description }) }, pairedItem: { item: i } });
      }
    }
    return out;
  },
});

const required = (ctx: IExecuteContext, name: string, label: string, i: number): string => {
  const value = String(ctx.getNodeParameter<unknown>(name, i, '') ?? '').trim();
  if (!value) throw new NodeOperationError(`${label} is required`, { itemIndex: i });
  return value;
};

async function runItem(ctx: IExecuteContext, api: ApiContext, credentials: LinearCredentials, i: number): Promise<JsonObject[]> {
  const resource = ctx.getNodeParameter<string>('resource', i);
  const operation = ctx.getNodeParameter<string>('operation', i);
  const options = ctx.getNodeParameter<JsonObject>('activityOptions', i, {}) ?? {};
  const hints = hintsOf(options);
  const returnAll = ctx.getNodeParameter<boolean>('returnAll', i, false);
  const limit = returnAll ? Infinity : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50);

  if (operation === 'getManySince') {
    let since: string;
    try {
      since = sinceIso(ctx.getNodeParameter('since', i, ''));
    } catch (error) {
      throw new NodeOperationError((error as Error).message, { itemIndex: i });
    }
    if (resource === 'issue') {
      const filter: JsonObject = options.teamKey ? { team: { key: { eq: String(options.teamKey).trim() } } } : {};
      const nodes = await ctx.span('linear.issues', {}, () => changedSince(api, credentials, 'issues', issueFields(options.customerNeeds !== false), since, { limit, filter }));
      return nodes.map((n) => ({ ...issueActivity(n, { hints, cursor: String(n.updatedAt) }) }));
    }
    if (resource === 'comment') {
      const nodes = await ctx.span('linear.comments', {}, () => changedSince(api, credentials, 'comments', COMMENT_FIELDS, since, { limit }));
      return nodes.map((n) => ({ ...commentActivity(n, { hints, cursor: String(n.updatedAt) }) }));
    }
    if (resource === 'projectUpdate') {
      const nodes = await ctx.span('linear.projectUpdates', {}, () => changedSince(api, credentials, 'projectUpdates', PROJECT_UPDATE_FIELDS, since, { limit }));
      return nodes.map((n) => ({ ...projectUpdateActivity(n, { hints, cursor: String(n.updatedAt) }) }));
    }
  }

  if (resource === 'issue') {
    switch (operation) {
      case 'get': {
        const id = required(ctx, 'issueId', 'Issue', i);
        const data = await graphql<{ issue: JsonObject | null }>(
          api,
          credentials,
          `query($id: String!) { issue(id: $id) { ${issueFields(options.customerNeeds !== false)} comments(first: 100) { nodes { body createdAt user { name email } } } } }`,
          { id },
        );
        if (!data.issue) throw new NodeOperationError(`No issue ${id}`, { itemIndex: i });
        return [{ ...issueActivity(data.issue, { hints, withText: true, text: issueText(data.issue) }) }];
      }
      case 'create': {
        const extra = ctx.getNodeParameter<JsonObject>('additionalFields', i, {}) ?? {};
        const input: JsonObject = { teamId: required(ctx, 'teamId', 'Team', i), title: required(ctx, 'title', 'Title', i) };
        const description = String(ctx.getNodeParameter('description', i, '') ?? '');
        if (description) input.description = description;
        if (extra.priority !== undefined && extra.priority !== '') input.priority = Number(extra.priority);
        for (const key of ['assigneeId', 'projectId', 'stateId', 'dueDate']) if (extra[key]) input[key] = String(extra[key]).trim();
        const labels = String(extra.labelIds ?? '').split(/[,\s]+/).filter(Boolean);
        if (labels.length) input.labelIds = labels;
        const data = await graphql<{ issueCreate: { success: boolean; issue: JsonObject | null } }>(
          api,
          credentials,
          'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }',
          { input },
        );
        if (!data.issueCreate.success || !data.issueCreate.issue) throw new NodeOperationError('Linear did not create the issue', { itemIndex: i });
        return [data.issueCreate.issue];
      }
      case 'addLink': {
        const url = required(ctx, 'url', 'URL', i);
        const input: JsonObject = { issueId: required(ctx, 'issueId', 'Issue', i), url, title: String(ctx.getNodeParameter('linkTitle', i, '') ?? '').trim() || url };
        const subtitle = String(ctx.getNodeParameter('linkSubtitle', i, '') ?? '').trim();
        if (subtitle) input.subtitle = subtitle;
        const data = await graphql<{ attachmentCreate: { success: boolean; attachment: JsonObject | null } }>(
          api,
          credentials,
          'mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id url title subtitle } } }',
          { input },
        );
        if (!data.attachmentCreate.success || !data.attachmentCreate.attachment) throw new NodeOperationError('Linear did not attach the link', { itemIndex: i });
        return [data.attachmentCreate.attachment];
      }
    }
  }

  if (resource === 'comment' && operation === 'create') {
    const input: JsonObject = { issueId: required(ctx, 'issueId', 'Issue', i), body: required(ctx, 'body', 'Comment', i) };
    const parentId = String(ctx.getNodeParameter('parentId', i, '') ?? '').trim();
    if (parentId) input.parentId = parentId;
    const data = await graphql<{ commentCreate: { success: boolean; comment: JsonObject | null } }>(
      api,
      credentials,
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url body createdAt } } }',
      { input },
    );
    if (!data.commentCreate.success || !data.commentCreate.comment) throw new NodeOperationError('Linear did not create the comment', { itemIndex: i });
    return [data.commentCreate.comment];
  }

  if (resource === 'user' && operation === 'getAll') {
    const includeDisabled = ctx.getNodeParameter<boolean>('includeDisabled', i, false) === true;
    const users: JsonObject[] = [];
    let after: string | undefined;
    do {
      const data = await graphql<{ users: { nodes: JsonObject[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } } }>(
        api,
        credentials,
        `query($first: Int, $after: String, $includeDisabled: Boolean) {
          users(first: $first, after: $after, includeDisabled: $includeDisabled) {
            nodes { id name displayName email active admin guest teams(first: 20) { nodes { key name } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first: Math.min(100, Number.isFinite(limit) ? limit - users.length : 100), includeDisabled, ...(after && { after }) },
      );
      for (const u of data.users.nodes) {
        users.push({
          id: u.id,
          name: u.name,
          displayName: u.displayName,
          email: String(u.email ?? '').toLowerCase() || null,
          active: u.active,
          admin: u.admin,
          guest: u.guest,
          teams: listOf(u.teams).map((t) => String(t.name)),
        });
      }
      after = data.users.pageInfo.hasNextPage ? (data.users.pageInfo.endCursor ?? undefined) : undefined;
    } while (after && users.length < limit);
    return users.slice(0, limit);
  }

  throw new NodeOperationError(`Operation "${operation}" is not available for resource "${resource}"`, { itemIndex: i, description: 'Pick an operation from the list after changing the resource.' });
}
