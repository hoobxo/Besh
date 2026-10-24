/**
 * One SSH connection has one outbound cipher state and packet sequence, shared
 * by terminal input, window updates, SFTP and exec. Serialize the entire operation
 * (framing/encryption/write), not just socket writes: WebCrypto yields before
 * AES-GCM advances its invocation counter, so parallel builds can reuse an IV.
 */
export class PacketSendQueue {
  #tail: Promise<void> = Promise.resolve()

  send(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(operation)
    this.#tail = next
    // Mark background callers handled without hiding the failure from an awaiting
    // caller. After a failed packet, later packets must not use uncertain state;
    // the connection needs to be closed/reconnected rather than silently resumed.
    void next.catch(() => {})
    return next
  }
}
