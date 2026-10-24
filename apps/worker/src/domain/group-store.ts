/**
 * Custom server groups.
 *
 * Deleting a group never deletes servers: `servers.group_id` is ON DELETE SET
 * NULL, so they fall back to "ungrouped". The unique index compares names with
 * lower(trim(...)) so "生产" and "生产 " cannot become two groups.
 */

export type Group = {
  id: string
  name: string
  sortOrder: number
  serverCount: number
}

export class GroupStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GroupStoreError"
  }
}

const NAME_LIMIT = 60

export async function listGroups(db: D1Database): Promise<Group[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.name, g.sort_order AS sortOrder, COUNT(s.id) AS serverCount
       FROM server_groups g
       LEFT JOIN servers s ON s.group_id = g.id
       GROUP BY g.id, g.name, g.sort_order
       ORDER BY g.sort_order ASC, g.name ASC`
    )
    .all<Group>()
  return results.map((row) => ({ ...row, serverCount: Number(row.serverCount) }))
}

export async function createGroup(db: D1Database, input: { name: string; now?: number }): Promise<Group> {
  const name = validateName(input.name)
  const now = input.now ?? Date.now()
  const id = crypto.randomUUID()

  try {
    await db
      .prepare("INSERT INTO server_groups (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, name, await nextSortOrder(db), now)
      .run()
  } catch (error) {
    // The unique index is the authority on duplicates, including case and
    // surrounding whitespace.
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      throw new GroupStoreError("A group with this name already exists")
    }
    throw error
  }

  return { id, name, sortOrder: 0, serverCount: 0 }
}

export async function renameGroup(db: D1Database, id: string, input: { name: string }): Promise<void> {
  const name = validateName(input.name)
  try {
    const result = await db.prepare("UPDATE server_groups SET name = ? WHERE id = ?").bind(name, id).run()
    if (result.meta.changes === 0) throw new GroupStoreError("Group not found")
  } catch (error) {
    if (error instanceof GroupStoreError) throw error
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      throw new GroupStoreError("A group with this name already exists")
    }
    throw error
  }
}

/** Removes the group; its servers become ungrouped rather than disappearing. */
export async function deleteGroup(db: D1Database, id: string): Promise<void> {
  const result = await db.prepare("DELETE FROM server_groups WHERE id = ?").bind(id).run()
  if (result.meta.changes === 0) throw new GroupStoreError("Group not found")
}

async function nextSortOrder(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM server_groups").first<{
    next: number
  }>()
  return Number(row?.next ?? 0)
}

function validateName(value: string): string {
  const name = value.trim()
  if (name.length === 0 || name.length > NAME_LIMIT) {
    throw new GroupStoreError(`Group name must be 1-${NAME_LIMIT} characters`)
  }
  return name
}
