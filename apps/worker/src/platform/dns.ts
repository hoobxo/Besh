import type { AddressResolver } from "../domain/target.ts"

/**
 * Resolves hostnames through DNS over HTTPS.
 *
 * Workers cannot open raw DNS queries, and DoH is also the safer choice: the
 * answers come from one place, so validation and dialling cannot disagree about
 * what the name means.
 */
export const dohResolver: AddressResolver = async (hostname) => {
  const url = new URL("https://cloudflare-dns.com/dns-query")
  url.searchParams.set("name", hostname)
  url.searchParams.set("type", "A")

  const response = await fetch(url, { headers: { Accept: "application/dns-json" } })
  if (!response.ok) throw new Error(`DNS lookup failed with status ${response.status}`)

  const body = (await response.json()) as { Answer?: Array<{ type: number; data: string }> }
  const addresses = (body.Answer ?? [])
    .filter((answer) => answer.type === 1 || answer.type === 28)
    .map((answer) => answer.data)

  if (addresses.length === 0) throw new Error("Hostname resolved to no addresses")
  return addresses
}
