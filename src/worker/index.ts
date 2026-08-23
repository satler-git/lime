import { createAuthApp } from './auth/routes'
import { registerSyncRoutes } from './sync/routes'
import { registerTelemetryRoutes } from './telemetry/routes'
import type { ExecutionContext } from '@cloudflare/workers-types'
import type { Env } from './auth/types'

const app = createAuthApp()
registerSyncRoutes(app)
registerTelemetryRoutes(app)

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext) {
    return app.fetch(request, env, executionContext)
  },
}
