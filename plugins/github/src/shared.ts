/**
 * What the GitHub node needs besides the API client: per-item processing with pairedItem, required parameters and
 * the error for an operation the resource doesn't have.
 */
import { NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';

/** A required string parameter, trimmed. */
export function requireString(ctx: IExecuteContext, name: string, label: string, itemIndex: number): string {
  const text = optionalString(ctx, name, itemIndex);
  if (!text) throw new NodeOperationError(`${label} is required`, { itemIndex });
  return text;
}

/** A string parameter, trimmed; empty when unset. */
export function optionalString(ctx: IExecuteContext, name: string, itemIndex: number): string {
  const value = ctx.getNodeParameter<unknown>(name, itemIndex, '');
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Re-throw any failure as a node error that names the item. */
export function atItem(error: unknown, itemIndex: number): NodeOperationError {
  if (error instanceof NodeOperationError) {
    return error.itemIndex === itemIndex
      ? error
      : new NodeOperationError(error.message, { itemIndex, ...(error.description && { description: error.description }) });
  }
  return new NodeOperationError((error as Error)?.message ?? String(error), { itemIndex });
}

/**
 * Per-item processing: parameters are read per item index and every result is paired with its input item. A failure
 * stops the node with `itemIndex` set, unless the node continues on fail: then the item becomes `{ error }` and the
 * next item runs.
 */
export async function mapItems(ctx: IExecuteContext, fn: (itemIndex: number, item: NodeItem) => Promise<JsonObject | JsonObject[]>): Promise<NodeItem[]> {
  const out: NodeItem[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      const result = await fn(i, items[i]);
      for (const json of Array.isArray(result) ? result : [result]) out.push({ json, pairedItem: { item: i } });
    } catch (error) {
      const failure = atItem(error, i);
      if (!ctx.continueOnFail()) throw failure;
      out.push({ json: { error: failure.message, ...(failure.description && { description: failure.description }) }, pairedItem: { item: i } });
    }
  }
  return out;
}

/** Resource / operation dispatch with a clear error for combinations the node doesn't have. */
export function unsupported(resource: string, operation: string): NodeOperationError {
  return new NodeOperationError(`Operation "${operation}" is not available for resource "${resource}"`, {
    description: 'Pick an operation from the list after changing the resource.',
  });
}
