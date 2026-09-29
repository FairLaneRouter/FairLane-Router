import { z } from 'zod'

/**
 * The id of a channel or a channel group in the registry.
 *
 * A module of its own because the public SDK ships it: the recommendation
 * names its group by this id, and the SDK must not carry the whole registry
 * builder along with one regular expression.
 */
export const registryIdSchema = z.string().regex(/^[a-z0-9-]+$/, 'an id may contain only [a-z0-9-]')
