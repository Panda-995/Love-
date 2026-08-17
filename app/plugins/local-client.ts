import { createLocalClient } from '~/utils/localClient'
import type { LocalClient } from '~/utils/localClient'

// Keep the historical `$supabase` injection name so existing UI composables can
// use the local same-origin adapter without a risky application-wide rewrite.
export default defineNuxtPlugin<{ supabase: LocalClient }>(() => ({
  provide: { supabase: createLocalClient() },
}))
