import { useLocalDb } from '../utils/db'
import { ensureTurnSecret } from '../utils/turn'

export default defineNitroPlugin(() => {
  useLocalDb()
  ensureTurnSecret()
})
