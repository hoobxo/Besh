import { OS_ICON_URLS } from "@/assets/os/urls"

/**
 * The mark for a host's distribution.
 *
 * The marks are the projects' own full-colour logos, so they are drawn as images: a
 * distribution logo is usually more than one path, often with its own gradient, and
 * flattening it into a single fill would make it a different logo.
 *
 * The name comes from `/etc/os-release` as a marketing string ("Alpine Linux
 * v3.24"), so the match is by family, most specific first. A host that has never
 * been connected to has no name yet and gets a plain outline instead of a guess.
 */
const FAMILIES: Array<[RegExp, string]> = [
  [/alpine/i, "alpinelinux"],
  [/debian/i, "debian"],
  [/ubuntu/i, "ubuntu"],
  [/arch/i, "archlinux"],
  [/centos/i, "centos"],
  [/rocky/i, "rockylinux"],
  [/alma/i, "almalinux"],
  [/fedora/i, "fedora"],
  [/red hat|rhel/i, "redhat"],
  [/opensuse|suse/i, "opensuse"],
  [/raspbian|raspberry/i, "raspberrypi"],
  [/proxmox/i, "proxmox"],
  [/kali/i, "kalilinux"],
  [/openwrt|lede/i, "openwrt"],
  [/freebsd/i, "freebsd"],
  [/truenas|freenas/i, "truenas"],
  [/unraid/i, "unraid"],
  [/synology|dsm/i, "synology"],
  [/linux/i, "linux"],
]

function osIconSlug(os: string | null): string | null {
  if (!os) return null
  for (const [pattern, slug] of FAMILIES) {
    if (pattern.test(os)) return slug
  }
  return null
}

export function OsIcon({ os, className }: { os: string | null; className?: string }) {
  const slug = osIconSlug(os)
  const url = slug ? OS_ICON_URLS[slug] : undefined

  if (!url) {
    // Nothing known yet: a plain box, the same shape the row used before.
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className} aria-hidden="true">
        <rect x="3" y="4" width="18" height="7" rx="1.5" />
        <rect x="3" y="13" width="18" height="7" rx="1.5" />
      </svg>
    )
  }

  return <img src={url} alt="" aria-hidden="true" className={className} draggable={false} />
}
