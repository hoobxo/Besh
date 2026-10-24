/**
 * Group endpoints.
 *
 * Same posture as the server inventory: authenticated and same-origin, with the
 * database as the authority on duplicate names and on what happens to servers
 * when a group disappears.
 */
import { GroupStoreError, createGroup, deleteGroup, listGroups, renameGroup } from "../domain/group-store.ts"
import { jsonError } from "./auth.ts"

export type GroupEnv = { DB: D1Database }

export async function handleListGroups(env: GroupEnv): Promise<Response> {
  return Response.json({ groups: await listGroups(env.DB) }, { headers: { "Cache-Control": "no-store" } })
}

export async function handleCreateGroup(request: Request, env: GroupEnv): Promise<Response> {
  const parsed = await readName(request)
  if ("response" in parsed) return parsed.response

  try {
    const group = await createGroup(env.DB, { name: parsed.name })
    return Response.json({ group }, { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof GroupStoreError) return jsonError("INVALID_REQUEST", error.message, 400)
    throw error
  }
}

export async function handleRenameGroup(request: Request, env: GroupEnv, id: string): Promise<Response> {
  const parsed = await readName(request)
  if ("response" in parsed) return parsed.response

  try {
    await renameGroup(env.DB, id, { name: parsed.name })
    return Response.json({ renamed: true }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof GroupStoreError) {
      return error.message.includes("not found")
        ? jsonError("NOT_FOUND", error.message, 404)
        : jsonError("INVALID_REQUEST", error.message, 400)
    }
    throw error
  }
}

export async function handleDeleteGroup(env: GroupEnv, id: string): Promise<Response> {
  try {
    await deleteGroup(env.DB, id)
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof GroupStoreError) return jsonError("NOT_FOUND", error.message, 404)
    throw error
  }
}

async function readName(request: Request): Promise<{ name: string } | { response: Response }> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { response: jsonError("INVALID_REQUEST", "Expected a JSON body", 400) }
  }
  const name = (body as { name?: unknown } | null)?.name
  if (typeof name !== "string") {
    return { response: jsonError("INVALID_REQUEST", "A group name is required", 400) }
  }
  return { name }
}
