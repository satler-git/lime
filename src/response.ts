/** Best-effort cancellation for a response body that the caller will not read. */
export const cancelResponseBody = (response: Response): void => {
  const body = response.body
  if (body === null) return

  try {
    void body.cancel().catch(() => {})
  } catch {
    // A locked or already-consumed body must not replace the typed transport error.
  }
}
