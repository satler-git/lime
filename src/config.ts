/**
 * Shared client config. `VITE_WORKER_URL` is read at build time and can be set
 * to an absolute or relative worker base URL. An empty value keeps calls on the
 * same origin, which matches the `AuthClient` default.
 */
export const workerBaseUrl = import.meta.env.VITE_WORKER_URL?.trim() ?? ''
