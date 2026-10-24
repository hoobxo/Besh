import { useEffect, useRef } from "react"

/**
 * Cloudflare's challenge widget.
 *
 * The script is loaded once for the whole page and each mount renders a widget into
 * its own element. A remount is how the challenge is reset: after a failed login the
 * token is spent, and asking Cloudflare for a fresh one is cheaper and less fragile
 * than tracking widget ids and calling reset on a stale handle.
 */
type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (id?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

let loading: Promise<void> | null = null

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (loading) return loading
  loading = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`)
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true })
      existing.addEventListener("error", () => reject(new Error("turnstile unavailable")), { once: true })
      return
    }
    const script = document.createElement("script")
    script.src = SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("turnstile unavailable"))
    document.head.appendChild(script)
  })
  return loading
}

export function Turnstile({ siteKey, onToken, onError }: { siteKey: string; onToken: (token: string) => void; onError?: () => void }) {
  const holder = useRef<HTMLDivElement>(null)
  // Kept in a ref so a new inline callback does not tear the widget down and rebuild it.
  const callback = useRef(onToken)
  callback.current = onToken
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    let cancelled = false
    let widget: string | null = null

    void loadScript()
      .then(() => {
        if (cancelled || !holder.current || !window.turnstile) return
        widget = window.turnstile.render(holder.current, {
          sitekey: siteKey,
          callback: (token: string) => callback.current(token),
          // An expired or failed challenge must not leave a stale token behind, or the
          // server would reject a login the form thought was ready.
          "expired-callback": () => callback.current(""),
          "error-callback": () => {
            callback.current("")
            onErrorRef.current?.()
          },
        })
      })
      .catch(() => {
        callback.current("")
        onErrorRef.current?.()
      })

    return () => {
      cancelled = true
      if (widget && window.turnstile) window.turnstile.remove(widget)
    }
  }, [siteKey])

  return <div ref={holder} className="min-h-[65px]" />
}
