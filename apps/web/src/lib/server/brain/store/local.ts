/**
 * The local brain store (`backend: 'local'`): the existing brain functions, unchanged, with the origin passed through.
 * Loading this file registers it (docs/features/notion-brain.md#how-it-is-built).
 */
import type { BrainStore } from '../../../shared/brain-store';
import { getUser } from '../../auth/users'; // NB05:
import { database } from '../../db';
import { personAdd } from '../../notebook/service';
import { draftPractice } from '../../practices/store';
import { addEntityFact, deleteEntity, getEntity, listEntities, upsertEntity } from '../entities';
import { listFacts, searchFacts } from '../facts';
import { setLocalBrainStore } from './port';

export const LocalBrainStore: BrainStore = {
  backend: 'local',
  entity: (type, id) => getEntity(type, id),
  entities: (filter) => listEntities(filter),
  facts: (filter) => listFacts(filter),
  searchFacts: (query, options) => searchFacts(query, options),
  upsertEntity: (input, origin, by) => upsertEntity(input, database(), new Date().toISOString(), origin, by),
  deleteEntity: (type, id, origin, by) => deleteEntity(type, id, database(), origin, by),
  addFact: (entity, input, origin, by) => addEntityFact(entity, input, database(), origin, by),
  draftPractice: (input, origin) => draftPractice(input, origin),
  // NB05: `by` is a user id. The author is that user's name; "A Notion user" for origin notion without one; else "Landflow" (never a verified note authored "Notion").
  addNote: (teamId, input, origin, by) => personAdd(teamId, (by && getUser(by)?.name) || (origin === 'notion' ? 'A Notion user' : 'Landflow'), input, origin),
};

setLocalBrainStore(LocalBrainStore);
